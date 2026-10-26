-- Vigie — schéma Supabase. À coller dans SQL Editor > New query, puis Run.
-- Peut être relancé sans risque : aucune donnée n'est supprimée (mise à jour d'une version précédente comprise).
--
-- Ce que voit le public (clé publishable) : les signalements des 4 dernières heures, sans identifiant d'appareil,
-- et les tendances apprises (vitesse des contrôles par ligne).
-- Ce qu'il peut faire : signaler via la fonction public.signaler(), limitée à 6 signalements par appareil et par 10 minutes.
-- Après 48 heures, un signalement passe dans une archive privée et anonyme (sans empreinte), qui sert à apprendre.

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
-- sens de circulation (identifiant de l'arrêt terminus) et rang de l'arrêt dans ce sens (0 = départ)
alter table public.signalements add column if not exists direction text check (char_length(direction) between 1 and 80);
alter table public.signalements add column if not exists seq smallint check (seq between 0 and 199);
-- noms de ligne jusqu'à 12 caractères (« Bus-LEB », lignes de nuit…)
alter table public.signalements drop constraint if exists signalements_line_check;
alter table public.signalements add constraint signalements_line_check check (char_length(line) between 1 and 12);

-- Anti-doublon des messages Telegram (les signalements de l'app ont ext_id vide : jamais en conflit).
create unique index if not exists signalements_src_ext_id on public.signalements (src, ext_id);
create index if not exists signalements_at on public.signalements (at desc);

alter table public.signalements enable row level security;
revoke all on public.signalements from anon, authenticated;
grant select on public.signalements to anon, authenticated;
grant all on public.signalements to service_role;

-- ---------------------------------------------------------------- schéma privé
-- Non exposé par l'API : journal anti-spam et archive, jamais lisibles depuis l'app.
create schema if not exists vigie_private;
revoke all on schema vigie_private from public, anon, authenticated;

create table if not exists vigie_private.appareils (
  device  text not null,
  at      timestamptz not null default now()
);
create index if not exists appareils_device_at on vigie_private.appareils (device, at desc);

-- Archive anonyme : ni empreinte, ni identifiant de message, heure arrondie à la minute.
create table if not exists vigie_private.archive (
  id        bigint generated always as identity primary key,
  kind      text not null,
  sub       text,
  of_kind   text,
  stop_id   text not null,
  line      text,
  direction text,
  seq       smallint,
  src       text not null,
  at        timestamptz not null
);
create index if not exists archive_ligne_at on vigie_private.archive (line, direction, at);
-- archive créée par une version intermédiaire de ce script (clé sans numérotation automatique) : on l'ajoute
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'vigie_private' and table_name = 'archive' and column_name = 'id' and is_identity = 'NO') then
    alter table vigie_private.archive alter column id add generated always as identity;
    perform setval(pg_get_serial_sequence('vigie_private.archive', 'id'),
                   coalesce((select max(id) from vigie_private.archive), 0) + 1, false);
  end if;
end $$;

-- ---------------------------------------------------------------- tendances apprises (publiques)
-- Pour chaque ligne et chaque sens : couples de signalements de contrôle successifs (même ligne, même sens,
-- 2 à 40 min d'écart, 0 à 10 arrêts plus loin). arrets / minutes = vitesse moyenne des contrôleurs.
create table if not exists public.tendances (
  line      text not null,
  direction text not null,
  paires    int not null,
  arrets    int not null,
  minutes   numeric not null,
  maj       timestamptz not null default now(),
  primary key (line, direction)
);
alter table public.tendances enable row level security;
revoke all on public.tendances from anon, authenticated;
grant select on public.tendances to anon, authenticated;
grant all on public.tendances to service_role;

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

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'tendances' and policyname = 'lecture') then
    create policy "lecture" on public.tendances for select to anon, authenticated using (true);
  end if;

  -- Temps réel : l'app reçoit les nouveaux signalements sans recharger.
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'signalements') then
    alter publication supabase_realtime add table public.signalements;
  end if;
end $$;

-- ---------------------------------------------------------------- signaler depuis l'app
-- Ancienne version (sans le sens) remplacée ; les appels sans p_direction / p_seq restent valables.
drop function if exists public.signaler(text, text, text, text, text, text);

create or replace function public.signaler(
  p_kind      text,
  p_stop_id   text,
  p_device    text,
  p_line      text default null,
  p_sub       text default null,
  p_of_kind   text default null,
  p_direction text default null,
  p_seq       int  default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
  new_id bigint;
  v_direction text := case when p_line is not null and char_length(p_direction) between 1 and 80 then p_direction end;
  v_seq smallint := case when p_line is not null and p_direction is not null and p_seq between 0 and 199 then p_seq end;
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

  insert into public.signalements (kind, sub, of_kind, stop_id, line, direction, seq, src, voter)
  values (p_kind, p_sub, p_of_kind, p_stop_id, p_line, v_direction, case when v_direction is not null then v_seq end, 'app',
          md5(p_device || ':' || p_stop_id || ':' || to_char(now() at time zone 'Europe/Zurich', 'YYYY-MM-DD')))
  returning id into new_id;

  return new_id;
end $$;

revoke all on function public.signaler(text, text, text, text, text, text, text, int) from public;
grant execute on function public.signaler(text, text, text, text, text, text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------- tâches planifiées (voir purge.sql)
-- Signalements de plus de 48 h : déplacés dans l'archive anonyme.
create or replace function vigie_private.archiver() returns int
language sql
security definer
set search_path = ''
as $$
  -- une seule instruction : chaque ligne supprimée est archivée, ou rien ne change
  with moved as (
    delete from public.signalements where at < now() - interval '48 hours'
    returning kind, sub, of_kind, stop_id, line, direction, seq, src, at
  ), kept as (
    insert into vigie_private.archive (kind, sub, of_kind, stop_id, line, direction, seq, src, at)
    select kind, sub, of_kind, stop_id, line, direction, seq, src, date_trunc('minute', at) from moved
    returning 1
  )
  select count(*)::int from kept;
$$;

-- Tendances : recalculées sur tout l'historique (archive + signalements récents).
-- Garde-fous contre des signalements fabriqués (sens et rang viennent de l'app) : un couple plus rapide que
-- 1,5 arrêt par minute est ignoré, et au plus 20 couples par ligne, sens et jour sont comptés.
create or replace function vigie_private.apprendre() returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.tendances;
  insert into public.tendances (line, direction, paires, arrets, minutes)
  with ctl as (
    select line, direction, seq, at from vigie_private.archive
     where kind = 'controle' and line is not null and direction is not null and seq is not null
    union all
    select line, direction, seq, at from public.signalements
     where kind = 'controle' and line is not null and direction is not null and seq is not null
  ), suite as (
    select line, direction, seq, at,
           lead(seq) over w as seq2, lead(at) over w as at2
      from ctl
    window w as (partition by line, direction order by at)
  ), paires as (
    select line, direction, at, seq2 - seq as k, extract(epoch from at2 - at) / 60.0 as dt
      from suite
     where at2 > at + interval '2 minutes' and at2 <= at + interval '40 minutes'
       and seq2 between seq and seq + 10
  ), plausibles as (
    select line, direction, k, dt,
           row_number() over (partition by line, direction, (at at time zone 'Europe/Zurich')::date order by at) as rang
      from paires
     where k <= 1.5 * dt
  )
  select line, direction, count(*), sum(k), round(sum(dt), 1)
    from plausibles
   where rang <= 20
   group by line, direction;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function vigie_private.archiver() from public, anon, authenticated;
revoke all on function vigie_private.apprendre() from public, anon, authenticated;

-- ---------------------------------------------------------------- tâches planifiées d'une base existante
-- Si pg_cron est déjà installé (purge.sql exécuté une fois), les tâches suivent aussitôt cette version :
-- l'ancienne tâche qui effaçait les signalements archive désormais. Sans pg_cron (première installation,
-- tests), rien ne se passe ici : c'est purge.sql qui crée les tâches.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vigie-purge-signalements', '17 * * * *', $job$select vigie_private.archiver()$job$);
    perform cron.schedule('vigie-purge-appareils', '*/15 * * * *',
      $job$delete from vigie_private.appareils where at < now() - interval '1 hour'$job$);
    perform cron.schedule('vigie-apprendre', '23 * * * *', $job$select vigie_private.apprendre()$job$);
  end if;
end $$;
