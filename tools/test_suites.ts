// Mémoire des suites du bot Telegram (supabase/functions/telegram/index.ts) sur un vrai PostgreSQL : table créée au
// premier message, lecture, mise à jour, rien au-delà de 30 minutes, effacement. Lancé par la CI (service postgres),
// après node tools/bot_bundle.mjs :
//   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres \
//     npx deno@2.9.6 run --allow-env --allow-net --allow-read --node-modules-dir=none tools/test_suites.ts
import postgres from "npm:postgres@3.4.9";

const DB = Deno.env.get("SUPABASE_DB_URL") ?? "";
if (!DB) {
  console.error("SUPABASE_DB_URL manquant");
  Deno.exit(2);
}
// la fonction démarre son serveur à l'import : pas ici
// deno-lint-ignore no-explicit-any
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown: async () => {} });

const admin = postgres(DB, { max: 1, onnotice: () => {} });
await admin.unsafe("create schema if not exists vigie_private");
await admin.unsafe("drop table if exists vigie_private.suites");

let ok = 0, bad = 0;
const check = (cond: boolean, m: string) => {
  if (cond) ok++;
  else bad++;
  console.log((cond ? "✓ " : "✗ ") + m);
};

// jsonb range les clés à sa façon : comparaison sans tenir compte de leur ordre
const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const { memoire } = await import("../supabase/functions/telegram/index.ts");
check(memoire !== null, "mémoire active avec SUPABASE_DB_URL");
const m = memoire!;
const A = "a".repeat(32), B = "b".repeat(32);
const ctx1 = { stop: "georgette", kind: "controle", sub: null, of: null, lines: [], cible: "stfrancois", line: null, dir: null,
  seq: null, at: "2026-11-22T17:06:00.000Z", ext: "0123456789abcdef01234567", voter: "f".repeat(32) };

check((await m.lire(A)) === null, "auteur inconnu (et table créée au passage) : rien");
await m.noter(A, ctx1);
check(same(await m.lire(A), ctx1), "contexte relu tel quel");
const ctx2 = { ...ctx1, lines: ["8"], line: "8", dir: "lemont", seq: 4 };
await m.noter(A, ctx2);
const n = await admin`select count(*)::int as n from vigie_private.suites where auteur = ${A}`;
check(same(await m.lire(A), ctx2) && n[0].n === 1, "mis à jour : une seule ligne par auteur");
await admin`update vigie_private.suites set at = now() - interval '31 minutes' where auteur = ${A}`;
check((await m.lire(A)) === null, "plus de 30 minutes : ignoré");
await m.noter(B, ctx1);
const left = await admin`select auteur from vigie_private.suites order by auteur`;
check(left.length === 1 && left[0].auteur === B, "plus de 30 minutes : effacé à l'écriture suivante");
const cols = await admin`select column_name from information_schema.columns
                         where table_schema = 'vigie_private' and table_name = 'suites' order by ordinal_position`;
check(cols.map((c) => c.column_name).join() === "auteur,at,ctx", "table : empreinte, heure, contexte (rien d'autre)");

await admin.end();
console.log(bad ? `mémoire des suites : ${bad} échec(s), ${ok} OK` : `mémoire des suites : ${ok} tests OK`);
Deno.exit(bad ? 1 : 0);
