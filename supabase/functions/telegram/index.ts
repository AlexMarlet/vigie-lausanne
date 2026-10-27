// Vigie — bot Telegram, fonction Supabase (Deno). Telegram y envoie chaque message du groupe (webhook) ; la logique
// est dans bot.mjs. Déployée par .github/workflows/bot.yml, qui ajoute vigie-core.js et data.js (tools/bot_bundle.mjs).
//
// Variables : TELEGRAM_BOT_TOKEN, TG_CHAT_ID (groupe de signalement ; vide pendant l'installation), VIGIE_SALT et
// VIGIE_SITE (facultatifs). SUPABASE_URL et la clé secrète sont fournies par Supabase.
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

const ready = TOKEN ? deriveSecrets(TOKEN, Deno.env.get("VIGIE_SALT") ?? "") : Promise.resolve(null);
const botP = ready.then((s) => s && createBot({
  C, stops: STOPS, lignes: LIGNES, chatId: Deno.env.get("TG_CHAT_ID") ?? "", salt: s.salt, site: Deno.env.get("VIGIE_SITE") ?? "",
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
  const out = await bot.handle(update);
  for (const line of out.log) console.log(line);
  if (out.rows.length && !(await save(out.rows, out.merge))) return new Response("réessayer", { status: 503 });
  return out.reply ? Response.json(out.reply) : new Response(null, { status: 200 });
});
