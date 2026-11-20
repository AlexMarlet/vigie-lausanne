// Vigie — statistiques d'apprentissage, fonction Supabase (Deno), en lecture seule.
// Ce que le modèle a appris et sur quelles données : agrégats de l'historique (archive anonyme + signalements
// récents), jamais un signalement isolé avec son empreinte ou son identifiant de message.
// Accès : en-tête x-vigie-cle = HMAC-SHA256(TELEGRAM_BOT_TOKEN, "vigie-stats")[:48] (même calcul dans
// .github/workflows/stats.yml et tableau.yml) ; sinon 401. Déployée par .github/workflows/bot.yml.
// Lue aussi par la page privée du site, /apprentissage/ (web/apprentissage/), depuis le navigateur : réponses
// CORS pour le site seulement, et un même résultat servi pendant 15 s à plusieurs onglets ou rafraîchissements.
import postgres from "npm:postgres@3.4.9";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const DB = Deno.env.get("SUPABASE_DB_URL") ?? "";
const ENC = new TextEncoder();
const SITES = new Set(["https://vigie-lausanne.ch", "https://www.vigie-lausanne.ch"]);
const MEMO_MS = 15_000;

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", ENC.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string): boolean {               // comparaison à temps constant
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const want = TOKEN ? hmac(TOKEN, "vigie-stats").then((h) => h.slice(0, 48)) : Promise.resolve("");

// Tous les signalements connus : archive (plus de 48 h, heure à la minute, sans empreinte) + table publique
const TOUT = `select kind, sub, of_kind, stop_id, line, direction, seq, src, at from vigie_private.archive
              union all
              select kind, sub, of_kind, stop_id, line, direction, seq, src, at from public.signalements`;
const LOCAL = `(at at time zone 'Europe/Zurich')`;

// deno-lint-ignore no-explicit-any
async function stats(sql: any) {
  const q = (text: string) => sql.unsafe(text);   // requêtes fixes, sans aucune donnée venue de la requête HTTP
  const [totaux, jours, heures, arrets, lignes, sousTypes, paires, tendances, presence, confirmations, telegram] = await Promise.all([
    q(`select src, kind, coalesce(of_kind, '') as of_kind, count(*)::int as n, min(at) as premier, max(at) as dernier
         from (${TOUT}) t group by 1, 2, 3 order by 1, 2, 3`),
    q(`select to_char(${LOCAL}, 'YYYY-MM-DD') as jour, src, kind, count(*)::int as n
         from (${TOUT}) t group by 1, 2, 3 order by 1`),
    q(`select src, extract(isodow from ${LOCAL})::int as jour_semaine, extract(hour from ${LOCAL})::int as heure, count(*)::int as n
         from (${TOUT}) t where kind = 'controle' group by 1, 2, 3`),
    q(`select stop_id, src, kind, count(*)::int as n, count(distinct ${LOCAL}::date)::int as jours, max(at) as dernier
         from (${TOUT}) t where kind in ('controle', 'perturbation') group by 1, 2, 3 order by 4 desc limit 800`),
    q(`select coalesce(line, '') as line, src, kind, count(*)::int as n, count(direction)::int as avec_sens,
              count(seq)::int as avec_rang
         from (${TOUT}) t where kind in ('controle', 'perturbation', 'fin') group by 1, 2, 3 order by 4 desc`),
    q(`select coalesce(sub, '') as sub, count(*)::int as n from (${TOUT}) t where kind = 'perturbation' group by 1 order by 2 desc`),
    // couples de signalements successifs d'une même ligne et d'un même sens (60 min au plus) : ceux que
    // vigie_private.apprendre() retient (2 à 40 min, 0 à 10 arrêts plus loin, au plus 1,5 arrêt par minute) et les autres
    q(`with ctl as (select line, direction, seq, at from (${TOUT}) t
                     where kind = 'controle' and line is not null and direction is not null and seq is not null),
            suite as (select line, direction, seq, at, lead(seq) over w as seq2, lead(at) over w as at2
                        from ctl window w as (partition by line, direction order by at))
       select line, direction, seq, seq2, at, (seq2 - seq)::int as k, round((extract(epoch from at2 - at) / 60.0)::numeric, 1)::float as dt
         from suite where at2 is not null and at2 <= at + interval '60 minutes' order by at`),
    q(`select line, direction, paires, arrets, minutes::float as minutes, maj from public.tendances order by paires desc`),
    // durée d'un contrôle à un arrêt : du premier et du dernier signalement de contrôle (2 h avant au plus)
    // au « partis » signalé au même arrêt
    q(`with t as (${TOUT})
       select f.stop_id, f.src, f.at,
              round((extract(epoch from f.at - c.premier) / 60.0)::numeric, 1)::float as depuis_premier,
              round((extract(epoch from f.at - c.dernier) / 60.0)::numeric, 1)::float as depuis_dernier, c.n
         from t f
         join lateral (select min(at) as premier, max(at) as dernier, count(*)::int as n from t c
                        where c.kind = 'controle' and c.stop_id = f.stop_id
                          and c.at <= f.at and c.at > f.at - interval '120 minutes') c on c.n > 0
        where f.kind = 'fin' and coalesce(f.of_kind, 'controle') = 'controle' order by f.at`),
    // un contrôle déjà signalé au même arrêt dans les 20 minutes précédentes = une confirmation. lag() prend le
    // signalement précédent, y compris un de la même minute : l'archive, à la minute près, ne sait plus lequel
    // était le premier, et un « p.at < c.at » strict perdait ces confirmations au bout de 48 h
    q(`with c as (select src, at, lag(at) over (partition by stop_id order by at) as avant
                    from (${TOUT}) t where kind = 'controle')
       select src, count(*)::int as n, count(*) filter (where avant >= at - interval '20 minutes')::int as confirment
         from c group by 1`),
    q(`select date_trunc('hour', at) as heure, kind, count(*)::int as n from (${TOUT}) t
        where src = 'telegram' group by 1, 2 order by 1`),
  ]);
  return { genere: new Date().toISOString(), totaux, jours, heures, arrets, lignes, sousTypes, paires, tendances, presence,
    confirmations, telegram };
}

async function calcul(): Promise<string> {
  const sql = postgres(DB, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    // deno-lint-ignore no-explicit-any
    return JSON.stringify(await sql.begin("read only", (tx: any) => stats(tx)));
  } finally {
    await sql.end({ timeout: 2 });
  }
}
let memo: { at: number; body: Promise<string> } | null = null;

// en-têtes CORS : seulement pour le site, qui envoie la clé dans x-vigie-cle (d'où la requête préalable OPTIONS)
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!SITES.has(origin)) return { vary: "Origin" };
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "x-vigie-cle", "access-control-max-age": "86400", vary: "Origin" };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (!TOKEN || !DB) return new Response("non configuré", { status: 503, headers: h });
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: h });
  if (!same(req.headers.get("x-vigie-cle") ?? "", await want)) return new Response("non autorisé", { status: 401, headers: h });
  let m = memo;
  if (!m || Date.now() - m.at > MEMO_MS) {
    const body = calcul();
    m = memo = { at: Date.now(), body };
    body.catch(() => { if (memo?.body === body) memo = null; });   // une erreur n'est pas gardée
  }
  try {
    return new Response(await m.body, { headers: { ...h, "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    console.error("stats :", e);
    return new Response("erreur : " + String((e as Error)?.message ?? e).slice(0, 300), { status: 500, headers: h });
  }
});
