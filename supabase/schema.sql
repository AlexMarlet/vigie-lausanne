-- Vigie — schéma Supabase. À coller dans SQL Editor > New query, puis Run.
-- Peut être relancé sans risque : rien n'est supprimé.
--
-- Ce que voit le public (clé publishable) : les signalements des 4 dernières heures, sans identifiant d'appareil.
-- Ce qu'il peut faire : signaler via la fonction public.signaler(), limitée à 6 signalements par appareil et par 10 minutes.

-- ---------------------------------------------------------------- signalements (publics)
create table if not exists public.signalements (
  id        bigint generated always as identity primary key,
  kind      text not null check (kind in ('controle', 'perturbation', 'fin')),
  sub       text check (sub in ('retard', 'panne', 'deviation', 'accident', 'bonde', 'autre')),
  of_kind   text check (of_kind in ('controle', 'perturbation')),   -- pour kind = 'fin' : ce qui est terminé
  stop_id   text not null check (char_length(stop_id) between 1 and 80),
  line      text check (char_length(line) between 1 and 4),
  src       text not null check (src in ('app', 'telegram')),
  voter     text,      -- empreinte anonyme : même appareil, même arrêt, même jour = une seule voix
  ext_id    text,      -- empreinte du message Telegram (anti-doublon)
  at        timestamptz not null default now()
);

-- Anti-doublon des messages Telegram (les signalements de l'app ont ext_id vide : jamais en conflit).
create unique index if not exists signalements_src_ext_id on public.signalements (src, ext_id);
create index if not exists signalements_at on public.signalements (at desc);

alter table public.signalements enable row level security;
revoke all on public.signalements from anon, authenticated;
grant select on public.signalements to anon, authenticated;
grant all on public.signalements to service_role;

-- ---------------------------------------------------------------- journal des appareils (privé)
-- Schéma non exposé par l'API : sert uniquement à l'anti-spam, jamais lisible depuis l'app.
create schema if not exists vigie_private;
revoke all on schema vigie_private from public, anon, authenticated;

create table if not exists vigie_private.appareils (
  device  text not null,
  at      timestamptz not null default now()
);
create index if not exists appareils_device_at on vigie_private.appareils (device, at desc);

-- ---------------------------------------------------------------- règles d'accès et temps réel
do $$
begin
  -- Tout le monde lit les signalements des 4 dernières heures, rien de plus ancien.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'signalements' and policyname = 'lecture recente') then
    create policy "lecture recente" on public.signalements
      for select to anon, authenticated
      using (at > now() - interval '4 hours');
  end if;

  -- Temps réel : l'app reçoit les nouveaux signalements sans recharger.
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'signalements') then
    alter publication supabase_realtime add table public.signalements;
  end if;
end $$;

-- ---------------------------------------------------------------- signaler depuis l'app
create or replace function public.signaler(
  p_kind    text,
  p_stop_id text,
  p_device  text,
  p_line    text default null,
  p_sub     text default null,
  p_of_kind text default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
  new_id bigint;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{16,64}$' then
    raise exception 'Appareil non reconnu.';
  end if;

  select count(*) into recent
    from vigie_private.appareils
   where device = p_device and at > now() - interval '10 minutes';
  if recent >= 6 then
    raise exception 'Trop de signalements depuis cet appareil, réessaie dans quelques minutes.';
  end if;

  insert into vigie_private.appareils (device) values (p_device);

  insert into public.signalements (kind, sub, of_kind, stop_id, line, src, voter)
  values (p_kind, p_sub, p_of_kind, p_stop_id, p_line, 'app',
          md5(p_device || ':' || p_stop_id || ':' || to_char(now() at time zone 'Europe/Zurich', 'YYYY-MM-DD')))
  returning id into new_id;

  return new_id;
end $$;

revoke all on function public.signaler(text, text, text, text, text, text) from public;
grant execute on function public.signaler(text, text, text, text, text, text) to anon, authenticated;
