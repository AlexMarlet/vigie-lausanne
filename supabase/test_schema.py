"""
Teste supabase/schema.sql sur un PostgreSQL configuré comme Supabase (rôles anon / authenticated /
service_role, publication supabase_realtime) : mise à jour depuis la version précédente, règles d'accès,
anti-spam, sens de circulation, archive anonyme et tendances apprises.

    PG_DSN="host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" python supabase/test_schema.py

En CI, la base est un conteneur postgres:17 jetable (voir .github/workflows/ci.yml).
"""
import os
import pathlib
import sys

import psycopg

DSN = os.environ.get("PG_DSN", "host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres")
HERE = pathlib.Path(__file__).parent
SCHEMA = (HERE / "schema.sql").read_text(encoding="utf-8")
SCHEMA_V1 = (HERE / "test_schema_v1.sql").read_text(encoding="utf-8")
DEV1, DEV2, DEV3, DEV4, DEV5 = "a1b2c3d4e5f60718", "0f1e2d3c4b5a6978", "1111222233334444", "5555666677778888", "9999aaaabbbbcccc"
ok = bad = 0


def check(cond, label):
    global ok, bad
    print(("✓ " if cond else "✗ ") + label)
    ok += bool(cond)
    bad += (not cond)


def fails(c, sql, params=None):
    try:
        with c.transaction():
            c.execute(sql, params)
        return False
    except psycopg.Error:
        return True


def fresh_database(c):
    """Environnement minimal façon Supabase, sans privilèges par défaut : on teste nos propres GRANT."""
    c.execute("reset role")
    c.execute("drop schema if exists vigie_private cascade; drop schema public cascade; create schema public;")
    for role, opts in (("anon", "nologin"), ("authenticated", "nologin"), ("service_role", "nologin bypassrls")):
        c.execute(f"do $$ begin create role {role} {opts}; exception when duplicate_object then null; end $$;")
    c.execute("grant usage on schema public to anon, authenticated, service_role;")
    c.execute("drop publication if exists supabase_realtime; create publication supabase_realtime;")


with psycopg.connect(DSN, autocommit=True) as c:
    # ================================================================ mise à jour d'une base existante
    fresh_database(c)
    c.execute(SCHEMA_V1)
    c.execute("set role anon")
    c.execute("select public.signaler('controle', 'flon', %s, 'M2')", (DEV5,))
    c.execute("reset role")
    c.execute(SCHEMA)
    c.execute(SCHEMA)
    check(True, "mise à jour : nouveau schéma appliqué (deux fois) sur l'ancien")
    check(c.execute("select count(*) from public.signalements where stop_id = 'flon'").fetchone()[0] == 1,
          "mise à jour : les signalements existants sont conservés")
    check(c.execute("select count(*) from pg_proc where proname = 'signaler'").fetchone()[0] == 1,
          "mise à jour : une seule fonction signaler() (l'ancienne est remplacée)")
    cols = {r[0] for r in c.execute("select column_name from information_schema.columns "
                                    "where table_schema = 'public' and table_name = 'signalements'")}
    check({"direction", "seq"} <= cols, "mise à jour : colonnes direction et seq ajoutées")
    check(c.execute("select count(*) from pg_constraint where conname = 'signalements_line_check'").fetchone()[0] == 1,
          "mise à jour : une seule contrainte sur le nom de ligne")
    c.execute("set role anon")
    c.execute("select public.signaler(p_kind => 'controle', p_stop_id => 'gare', p_device => %s, p_line => 'M2', "
              "p_sub => null, p_of_kind => null)", (DEV5,))
    check(True, "mise à jour : l'ancienne app (appel sans le sens) peut toujours signaler")
    c.execute("reset role")

    # ================================================================ installation neuve
    fresh_database(c)
    c.execute(SCHEMA)
    c.execute(SCHEMA)  # deux fois : doit être idempotent
    check(True, "schéma exécuté deux fois sans erreur")
    check(c.execute("select count(*) from pg_publication_tables where pubname = 'supabase_realtime' "
                    "and tablename = 'signalements'").fetchone()[0] == 1, "temps réel activé une seule fois")
    check(c.execute("select count(*) from pg_policies where tablename = 'signalements'").fetchone()[0] == 1,
          "une seule règle de lecture, pas de doublon")

    # --- collecteur Telegram (service_role) : même requête que PostgREST on_conflict=src,ext_id + ignore-duplicates
    up = ("insert into public.signalements (kind, stop_id, line, src, ext_id, at) "
          "values (%s, %s, %s, 'telegram', %s, now() - %s::interval) on conflict (src, ext_id) do nothing")
    c.execute("set role service_role")
    c.execute(up, ("controle", "flon", "M2", "abc", "2 minutes"))
    c.execute(up, ("controle", "flon", "M2", "abc", "2 minutes"))  # même message relu
    c.execute(up, ("controle", "ouchy", None, "old", "5 hours"))
    n = c.execute("select count(*) from public.signalements where src = 'telegram'").fetchone()[0]
    check(n == 2, "collecteur : doublon Telegram ignoré")
    c.execute("reset role")

    # --- app (anon)
    c.execute("set role anon")
    rid = c.execute("select public.signaler('controle', 'chauderon', %s, 'M1')", (DEV1,)).fetchone()[0]
    check(isinstance(rid, int), "app : signalement accepté via signaler()")
    rows = c.execute("select stop_id, src, voter from public.signalements order by id").fetchall()
    seen = [r[0] for r in rows]
    check("flon" in seen and "chauderon" in seen and "ouchy" not in seen, "app : lit le récent, rien de plus de 4 h")
    voter = next(r[2] for r in rows if r[0] == "chauderon")
    check(voter and DEV1 not in voter and len(voter) == 32, "app : seule une empreinte anonyme est visible")
    check(fails(c, "select * from vigie_private.appareils"), "app : journal des appareils illisible")
    check(fails(c, "insert into public.signalements (kind, stop_id, src) values ('controle', 'gare', 'app')"),
          "app : écriture directe dans la table refusée")
    check(fails(c, "insert into public.signalements (kind, stop_id, src) values ('controle', 'gare', 'telegram')"),
          "app : faux message Telegram refusé")
    check(fails(c, "delete from public.signalements"), "app : suppression refusée")
    check(fails(c, "select public.signaler('photo', 'gare', %s)", (DEV1,)), "app : type inconnu refusé")
    check(fails(c, "select public.signaler('controle', 'gare', 'pas-un-id')"), "app : identifiant d'appareil invalide refusé")
    check(fails(c, "select public.signaler('controle', 'gare', %s, 'LIGNE-TROP-LONGUE')", (DEV1,)), "app : ligne trop longue refusée")
    c.execute("select public.signaler('controle', 'echallens-gare', %s, 'Bus-LEB')", (DEV4,))
    check(True, "app : nom de ligne long accepté (Bus-LEB)")

    for _ in range(5):  # 1 déjà fait : 6 au total
        c.execute("select public.signaler('controle', 'gare', %s)", (DEV1,))
    try:
        with c.transaction():
            c.execute("select public.signaler('controle', 'gare', %s)", (DEV1,))
        check(False, "anti-spam : 7e signalement en 10 min bloqué")
    except psycopg.Error as e:
        check("Trop de signalements" in str(e), "anti-spam : 7e signalement en 10 min bloqué")
    c.execute("select public.signaler('fin', 'gare', %s, null, null, 'controle')", (DEV2,))
    check(True, "anti-spam : un autre appareil peut toujours signaler")
    v = c.execute("select count(distinct voter) from public.signalements where stop_id = 'gare' and src = 'app'").fetchone()[0]
    check(v == 2, "même appareil, même arrêt, même jour : une seule empreinte")

    # --- sens de circulation
    sig = ("select public.signaler(p_kind => 'controle', p_stop_id => %s, p_device => %s, p_line => %s, "
           "p_sub => null, p_of_kind => null, p_direction => %s, p_seq => %s)")
    a = c.execute(sig, ("riponne", DEV3, "M2", "croisettes", 6)).fetchone()[0]
    b = c.execute(sig, ("riponne", DEV3, None, "croisettes", 6)).fetchone()[0]
    d = c.execute(sig, ("bessieres", DEV3, "M2", "croisettes", 500)).fetchone()[0]
    e = c.execute(sig, ("bessieres", DEV3, "M2", None, 7)).fetchone()[0]
    got = {r[0]: r[1:] for r in c.execute("select id, direction, seq from public.signalements where id = any(%s)", ([a, b, d, e],))}
    check(got[a] == ("croisettes", 6), "sens : ligne, sens et rang de l'arrêt enregistrés")
    check(got[b] == (None, None), "sens : ignoré sans ligne")
    check(got[d] == ("croisettes", None), "sens : rang invalide ignoré, sens gardé")
    check(got[e] == (None, None), "sens : rang ignoré sans sens")
    check(fails(c, "select * from vigie_private.archive"), "app : archive illisible")
    check(fails(c, "select vigie_private.archiver()") and fails(c, "select vigie_private.apprendre()"),
          "app : ne peut pas lancer l'archivage ni l'apprentissage")
    check(fails(c, "insert into public.tendances values ('M2', 'x', 1, 1, 1)"), "app : tendances non modifiables")
    c.execute("reset role")

    # --- archive anonyme (tâche horaire)
    c.execute("set role service_role")
    c.execute("insert into public.signalements (kind, stop_id, line, direction, seq, src, voter, ext_id, at) values "
              "('controle', 'gare', 'M2', 'croisettes', 4, 'telegram', 'empreinte', 'msg-1', now() - interval '49 hours 30 seconds'), "
              "('controle', 'flon', 'M2', 'croisettes', 5, 'telegram', 'empreinte', 'msg-2', now() - interval '47 hours')")
    c.execute("reset role")
    moved = c.execute("select vigie_private.archiver()").fetchone()[0]
    check(moved == 1, "archive : seuls les signalements de plus de 48 h sont déplacés")
    check(c.execute("select count(*) from public.signalements where ext_id = 'msg-1'").fetchone()[0] == 0
          and c.execute("select count(*) from public.signalements where ext_id = 'msg-2'").fetchone()[0] == 1,
          "archive : retirés de la table publique, les récents restent")
    acols = {r[0] for r in c.execute("select column_name from information_schema.columns "
                                     "where table_schema = 'vigie_private' and table_name = 'archive'")}
    check(not ({"voter", "ext_id"} & acols), "archive : ni empreinte ni identifiant de message")
    row = c.execute("select stop_id, line, direction, seq, extract(second from at) from vigie_private.archive").fetchone()
    check(row[:4] == ("gare", "M2", "croisettes", 4) and row[4] == 0, "archive : arrêt, ligne, sens gardés ; heure à la minute")
    check(c.execute("select vigie_private.archiver()").fetchone()[0] == 0, "archive : relancer ne déplace rien de plus")

    # --- tendances (tâche horaire) : couples successifs même ligne / même sens
    c.execute("""
      insert into vigie_private.archive (id, kind, stop_id, line, direction, seq, src, at)
      select 9000 + n, k, 'x', l, d, s, 'app', now() - interval '3 days' + m * interval '1 minute'
      from (values (1, 'controle', 'M2', 'croisettes', 3, 0),
                   (2, 'controle', 'M2', 'croisettes', 4, 3),     -- +1 arrêt en 3 min
                   (3, 'controle', 'M2', 'croisettes', 6, 10),    -- +2 arrêts en 7 min
                   (4, 'controle', 'M2', 'croisettes', 5, 12),    -- retour en arrière : ignoré
                   (5, 'controle', 'M2', 'croisettes', 7, 70),    -- 58 min plus tard : ignoré
                   (6, 'perturbation', 'M2', 'croisettes', 8, 4), -- pas un contrôle : ignoré
                   (7, 'controle', '9', 'lutry', 1, 0),
                   (8, 'controle', '9', 'lutry', 1, 5),           -- toujours au même arrêt 5 min plus tard
                   (9, 'controle', '9', null, 3, 6))              -- sans sens : ignoré
        as t(n, k, l, d, s, m)
    """)
    n = c.execute("select vigie_private.apprendre()").fetchone()[0]
    t = {(r[0], r[1]): r[2:] for r in c.execute("select line, direction, paires, arrets, minutes from public.tendances")}
    check(n == 2 and set(t) == {("M2", "croisettes"), ("9", "lutry")}, f"tendances : une ligne par ligne et par sens ({sorted(t)})")
    check(t.get(("M2", "croisettes")) == (2, 3, 10), f"tendances M2 : 2 couples, 3 arrêts en 10 min ({t.get(('M2', 'croisettes'))})")
    check(t.get(("9", "lutry")) == (1, 0, 5), "tendances 9 : arrêt immobile compté (0 arrêt en 5 min)")
    c.execute("select vigie_private.apprendre()")
    check(c.execute("select count(*) from public.tendances").fetchone()[0] == 2, "tendances : recalcul sans doublon")
    c.execute("set role anon")
    check(len(c.execute("select * from public.tendances").fetchall()) == 2, "app : lit les tendances")
    c.execute("reset role")

print(f"\n{ok} OK, {bad} échec(s)")
sys.exit(1 if bad else 0)
