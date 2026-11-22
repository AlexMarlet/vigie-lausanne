// Vigie — bot Telegram, fonction Supabase (Deno). Telegram y envoie chaque message du groupe (webhook) ; la logique
// est dans bot.mjs. Déployée par .github/workflows/bot.yml, qui ajoute vigie-core.js et data.js (tools/bot_bundle.mjs).
//
// Variables : TELEGRAM_BOT_TOKEN, TG_CHAT_ID (groupe de signalement ; vide pendant l'installation), TG_TEST_CHAT_ID
// (groupes de test, séparés par des virgules), VIGIE_SALT et VIGIE_SITE (facultatifs). SUPABASE_URL, la clé
// secrète et SUPABASE_DB_URL sont fournies par Supabase.
//
// Mémoire des suites (« ils montent dans le 8 » après « 3 à Georgette ») : table vigie_private.suites, une ligne par
// auteur (empreinte salée, pas d'identifiant Telegram) avec l'arrêt, la ligne et le sens de son dernier message, effacée
// après 30 minutes (à chaque écriture, et toutes les 5 minutes par la tâche pg_cron « vigie-purge-suites »). Table et
// tâche créées ici si elles manquent (mêmes définitions dans supabase/schema.sql et purge.sql). Si la base ne répond
// pas, le bot place quand même chaque message seul.
import postgres from "npm:postgres@3.4.9";
import "./vigie-core.js";
import { LIGNES, STOPS } from "./data.js";
import { createBot, deriveSecrets } from "./bot.mjs";

// deno-lint-ignore no-explicit-any
const C = (globalThis as any).VigieCore;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const API = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");

// clé secrète : nouvelles clés (SUPABASE_SECRET_KEYS, « default » ou la première) ou ancienne clé service_role
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const k = keys && (keys.default ?? Object.values(keys)[0]);
    if (typeof k === "string" && k) return k;
  } catch { /* format inattendu : clé historique */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const KEY = secretKey();
const DB = Deno.env.get("SUPABASE_DB_URL") ?? "";

// deno-lint-ignore no-explicit-any
let sql: any = null;
let table: Promise<void> | null = null;
async function base() {
  if (!sql) sql = postgres(DB, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5 });
  if (!table) {
    table = (async () => {
      await sql.unsafe("create table if not exists vigie_private.suites (auteur text primary key, at timestamptz not null default now(), ctx jsonb not null)");
      await sql.unsafe("create index if not exists suites_at on vigie_private.suites (at)");
      try {                                                     // même nom : remplace la tâche, pas de doublon
        await sql.unsafe("select cron.schedule('vigie-purge-suites', '*/5 * * * *', " +
          "$$delete from vigie_private.suites where at < now() - interval '30 minutes'$$)");
      } catch (e) {
        console.warn("mémoire des suites : effacement planifié impossible, fait à chaque message (" + ((e as Error)?.message ?? e) + ")");
      }
    })().catch((e) => { table = null; throw e; });
  }
  await table;
  return sql;
}
// deno-lint-ignore no-explicit-any
async function avecBase<T>(f: (s: any) => Promise<T>): Promise<T> {
  try {
    return await f(await base());
  } catch (e) {                                                 // connexion perdue : nouveau client au prochain message
    const old = sql;
    sql = null;
    table = null;
    try { await old?.end({ timeout: 1 }); } catch { /* déjà fermé */ }
    throw e;
  }
}
// exportée pour tools/test_suites.ts (CI, vrai PostgreSQL)
export const memoire = DB ? {
  lire: (cle: string) => avecBase(async (s) => {
    const r = await s`select ctx from vigie_private.suites where auteur = ${cle} and at > now() - interval '30 minutes'`;
    return r.length ? r[0].ctx : null;
  }),
  noter: (cle: string, ctx: unknown) => avecBase(async (s) => {
    await s`insert into vigie_private.suites (auteur, at, ctx) values (${cle}, now(), ${s.json(ctx)})
            on conflict (auteur) do update set at = excluded.at, ctx = excluded.ctx`;
    await s`delete from vigie_private.suites where at < now() - interval '30 minutes'`;
  }),
} : null;

const ready = TOKEN ? deriveSecrets(TOKEN, Deno.env.get("VIGIE_SALT") ?? "") : Promise.resolve(null);
const botP = ready.then((s) => s && createBot({
  C, stops: STOPS, lignes: LIGNES, chatId: Deno.env.get("TG_CHAT_ID") ?? "", testIds: Deno.env.get("TG_TEST_CHAT_ID") ?? "",
  salt: s.salt, site: Deno.env.get("VIGIE_SITE") ?? "",
}));

function same(a: string, b: string): boolean {               // comparaison à temps constant
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Enregistre les signalements. true : fait, ou erreur définitive (inutile de réessayer) ; false : Telegram réessaiera.
// deno-lint-ignore no-explicit-any
async function save(rows: any[], merge: boolean): Promise<boolean> {
  const headers: Record<string, string> = {
    apikey: KEY, "Content-Type": "application/json",
    Prefer: `resolution=${merge ? "merge" : "ignore"}-duplicates,return=minimal`,
  };
  if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;   // ancienne clé (JWT)
  const url = `${API}/rest/v1/signalements?on_conflict=src,ext_id`;
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(rows) });
  let txt = res.ok ? "" : await res.text();
  if (!res.ok && /direction|'seq'|PGRST204/.test(txt)) {      // base pas encore mise à jour (schema.sql) : sans le sens
    console.warn("base sans colonne direction : relance supabase/schema.sql");
    const slim = rows.map(({ direction: _d, seq: _s, ...r }) => r);
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(slim) });
    txt = res.ok ? "" : await res.text();
  }
  if (res.ok) return true;
  console.error(`Supabase ${res.status} : ${txt.slice(0, 300)}`);
  return res.status < 500;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Vigie : bot Telegram en ligne\n");
  const [secrets, bot] = await Promise.all([ready, botP]);
  if (!secrets || !bot || !KEY || !API) return new Response("bot non configuré", { status: 503 });
  if (!same(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secrets.webhook)) return new Response("interdit", { status: 401 });
  let update;
  try { update = await req.json(); } catch { return new Response("requête invalide", { status: 400 }); }
  const out = await bot.handle(update, { memoire });
  if (out.rows.length && !(await save(out.rows, out.merge))) {
    for (const line of out.log) console.log(line);
    return new Response("réessayer", { status: 503 });
  }
  if (out.commit) await out.commit();                          // contexte pour le message suivant de la même personne
  for (const line of out.log) console.log(line);
  return out.reply ? Response.json(out.reply) : new Response(null, { status: 200 });
});
