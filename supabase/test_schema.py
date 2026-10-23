"""
Teste supabase/schema.sql sur un PostgreSQL configuré comme Supabase (rôles anon / authenticated /
service_role, publication supabase_realtime).

    PG_DSN="host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" python supabase/test_schema.py

En CI, la base est un conteneur postgres:17 jetable (voir .github/workflows/ci.yml).
"""
import os
import pathlib
import sys

import psycopg

DSN = os.environ.get("PG_DSN", "host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres")
SCHEMA = (pathlib.Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
DEV1, DEV2 = "a1b2c3d4e5f60718", "0f1e2d3c4b5a6978"
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


with psycopg.connect(DSN, autocommit=True) as c:
    # environnement minimal façon Supabase, sans privilèges par défaut : on teste nos propres GRANT
    c.execute("drop schema if exists vigie_private cascade; drop schema public cascade; create schema public;")
    for role, opts in (("anon", "nologin"), ("authenticated", "nologin"), ("service_role", "nologin bypassrls")):
        c.execute(f"do $$ begin create role {role} {opts}; exception when duplicate_object then null; end $$;")
    c.execute("grant usage on schema public to anon, authenticated, service_role;")
    c.execute("drop publication if exists supabase_realtime; create publication supabase_realtime;")

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
    check(fails(c, "select public.signaler('controle', 'gare', %s, 'LIGNE99')", (DEV1,)), "app : ligne trop longue refusée")

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
    c.execute("reset role")

print(f"\n{ok} OK, {bad} échec(s)")
sys.exit(1 if bad else 0)
