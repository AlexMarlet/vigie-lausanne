// Vigie — bot Telegram : la logique, sans réseau ni Deno (testée avec Node : core/test-bot.mjs).
//
// Les admins ajoutent le bot au groupe de signalement. Telegram envoie alors chaque message du groupe à la fonction
// Supabase « telegram » (webhook, voir index.ts), qui appelle handle() :
//   - message du groupe configuré (TG_CHAT_ID) qui cite un arrêt → un signalement (contrôle, perturbation ou fin),
//     lu avec le même parseur que l'app (core/vigie-core.js) ; une réponse « partis » ou « toujours là » à un
//     signalement prend l'arrêt du message auquel elle répond ;
//   - message qui suit (même personne, 15 min au plus, ou réponse) : « ils montent dans le 8 » complète la ligne et le
//     sens du signalement d'avant ; « 3 m2 dir croisettes » puis « à la Riponne » donne l'arrêt qui manquait ;
//     « descendus à Délices » après « M2 Grancy direction Ouchy » garde la ligne et le sens ; « partis » le termine.
//     La mémoire de ces suites (handle(update, { memoire })) ne garde, 30 minutes au plus, qu'une empreinte salée de
//     l'auteur avec l'arrêt, la ligne et le sens de son dernier message, jamais le texte ;
//   - message privé → le bot explique ce qu'il fait, ou montre ce qu'il comprend d'un message (rien n'est enregistré) ;
//   - groupe de test (TG_TEST_CHAT_ID, par ex. celui où les admins essaient le bot) → le bot répond dans le groupe ce
//     qu'il comprend de chaque signalement, sans rien enregistrer ;
//   - autre groupe → le bot en sort aussitôt (personne ne peut l'utiliser pour injecter de faux signalements) ;
//   - pas encore de TG_CHAT_ID (installation) → le bot n'enregistre rien, reste muet et note l'identifiant du groupe.
// Rien n'est jamais posté dans le groupe de signalement. Ni le texte des messages ni leur auteur ne sont enregistrés : seulement une
// empreinte du message (anti-doublon), une empreinte « personne + arrêt + jour » (une seule voix par personne et par
// arrêt chaque jour, comme dans l'app) et, 30 minutes au plus, une empreinte de l'auteur pour relier ses messages qui
// se suivent, toutes salées, donc non réversibles.

const ENC = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", ENC.encode(s))); }
export async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", ENC.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)));
}

// Secret du webhook (en-tête X-Telegram-Bot-Api-Secret-Token) et sel des empreintes, tirés du jeton du bot :
// aucun secret de plus à gérer. Même calcul dans tools/bot_telegram.py.
export async function deriveSecrets(token, salt) {
  return { webhook: (await hmac(token, "vigie-webhook")).slice(0, 48), salt: salt || (await hmac(token, "vigie-salt")) };
}

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

// Réponses à un signalement : volontairement plus strict que le parseur, pour qu'un « merci », « ok » ou
// « c'est bon » en réponse ne compte pas. Textes normalisés (minuscules, sans accents).
const RE_GONE = /\b(partis?|parties|descendus?|descendues?|sortis?|sorties|disparus?|plus de controle\w*|plus personne|plus la|y a plus|y en a plus|ya plus|fausse alerte)\b/;
const RE_NOT_GONE = /\b(pas|toujours|encore|jamais) (encore |toujours |vraiment )?(partis?|parties|descendus?|descendues?|sortis?|sorties|disparus?)\b/;
const RE_STILL = /\b(toujours la|encore la|toujours present\w*|encore present\w*|ils y sont|y sont encore|y sont toujours|je confirme|confirme|tjrs la|tjs la)\b/;
const RE_BACK = /\b(retabli\w*|circule a nouveau|circulent a nouveau|resolu\w*)\b/;
const gone = (n) => RE_GONE.test(n) && !RE_NOT_GONE.test(n);
const still = (n) => RE_STILL.test(n) && !/\b(pas|plus)\b/.test(n);

const SUB = { retard: "retard", panne: "panne", deviation: "déviation", accident: "accident", bonde: "véhicule bondé" };

// Ligne et sens : toutes les lignes citées (« ligne 6 et 7 et M2 », « dans le 9 », « 6 direction… »), gardées si elles
// passent à l'arrêt ; le sens (« direction Chailly ») choisit parmi elles, puis parmi les lignes de l'arrêt (une ligne
// citée qui ne passe pas à l'arrêt, comme « M2 … EPFL », est corrigée par le sens ou par la seule ligne de l'arrêt).
// « direction centre / Lausanne / ville » : le sens où l'on atteint le plus vite un arrêt du centre.
const COUNT = /^(controleurs?|controleuses?|agents?|mecs?|gars|types?|personnes?|bleus?|schtroumpfs?|minutes?|min|mn|fois|chf|francs?|ans|avril|h|heures?)$/;
const CENTRE = ["flon", "stfrancois", "belair", "chauderon", "riponne", "bessieres", "gare", "tunnel"];
const RE_CENTRE = /\b(?:direction|dir|vers|sens|cote)(?: le| la| de)? (?:lausanne centre|centre ville|centre|lausanne ville|ville|lausanne)\b/;
const HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hourCycle: "h23" });
// 🚌 🚇 🚊 (messages du bot de signalement anonyme) : « lignes concernées », comme dans le parseur
const LINE_EMOJI = /[\u{1F68C}\u{1F68D}\u{1F68E}\u{1F687}\u{1F688}\u{1F68A}\u{1F683}\u{1F68B}]\uFE0F?/gu;
function linesIn(norm) {
  const out = [], add = (l) => { if (!out.includes(l)) out.push(l); };
  for (const m of norm.matchAll(/\b(?:m|metro)\s?([123])\b/g)) add("M" + m[1]);
  const t = norm.replace(/\br 20\b/g, "r20").split(" ");
  let prev = false;                                   // le mot précédent était une ligne : liste « 31, 33 », « 6 et 7 »
  t.forEach((w, i) => {
    if (/^m[123]$/.test(w)) { prev = true; return; }
    if (w === "leb" || w === "r20") { add("LEB"); prev = true; return; }   // train Lausanne-Echallens-Bercher (R20)
    if (w === "et" || w === "ou") return;
    if (/^\d{1,2}$/.test(w) && +w > 0 && !COUNT.test(t[i + 1] || "")) {
      const before = t.slice(Math.max(0, i - 2), i).join(" ");
      // suite de numéros (« 6/7 », « (7,8,19) ») : des lignes, sauf si elle compte quelque chose (« 4 5 contrôleurs »)
      let j = i;
      while (/^\d{1,2}$/.test(t[j + 1] || "")) j++;
      const list = j > i && !COUNT.test(t[j + 1] || "");
      if (prev || list || /(?:^|\s)(?:ligne|lignes|bus|trolley|trolleybus|le|du|l|n|no|num|numero|et|ou)$/.test(before) ||
          /^(?:direction|dir|vers|sens)$/.test(t[i + 1] || "")) { add(String(+w)); prev = true; return; }
    }
    prev = false;
  });
  return out;
}
// texte normalisé pour les lignes et le sens : sans les heures (« 10h30 », « 10:30 »), émojis de ligne en « ligne »
const normFor = (text, C) => C.normalize(String(text || "").replace(/\b\d{1,2}\s?[:h]\s?\d{2}\b/gi, " ").replace(LINE_EMOJI, " ligne "));
const FRESH = 15 * 60000;   // une suite : 15 minutes au plus après le message d'avant
const isGroup = (c) => c && (c.type === "group" || c.type === "supergroup");
// message de test qui ressemble à un signalement sans arrêt reconnu : le bot le dit (sinon il reste muet)
const RE_ATTEMPT = /\b(contr\w*|agents?|panne\w*|retard\w*|devi\w*|accident\w*|partis?|bloque\w*|perturb\w*|bonde\w*)\b/;

export function createBot({ C, stops, lignes, chatId, testIds, salt, site }) {
  const gaz = C.buildGazetteer(stops);
  const net = C.buildNetwork(lignes);
  const group = String(chatId || "").trim();
  const tests = new Set(String(testIds || "").split(/[\s,;]+/).filter(Boolean));
  tests.delete(group);          // le groupe de signalement n'est jamais un groupe de test : le bot y reste muet
  const SITE = (site || "https://vigie-lausanne.ch").replace(/\/$/, "");
  const name = (id) => (gaz.byId.get(id) || {}).name || id;
  const serves = (id, line) => ((gaz.byId.get(id) || {}).lines || []).includes(line);

  // Arrêts visés par « direction X » quand X n'est pas sur la ligne : ceux de la même commune (« direction Pully » →
  // Pully, Val-Vert) ou dont le nom contient X (« direction Malley » → Prilly-Malley, Gare/aréna)
  const town = (s) => C.normalize(s.name.includes(",") ? s.name.split(",")[0] : s.name.replace(/[- ]gare$/i, ""));
  const WORDS = new Map(stops.map((s) => [s.id, C.tokens(s.name)]));
  const TOWN = new Map(stops.map((s) => [s.id, town(s)]));
  // « direction St-Sulpice », « vers Crissier » : une commune de plusieurs arrêts, sans arrêt de ce nom
  const byTown = new Map();
  for (const s of stops) { const t = TOWN.get(s.id); if (!byTown.has(t)) byTown.set(t, []); byTown.get(t).push(s.id); }
  const towns = [...byTown.keys()].filter((t) => t.length >= 4 && byTown.get(t).length >= 2).sort((a, b) => b.length - a.length);
  const RE_TOWN = towns.length ? new RegExp("\\b(?:direction|dir|vers|sens)(?: de| du| la| le| l)? (" + towns.join("|") + ")\\b") : null;
  const townCible = (norm) => { const m = RE_TOWN && RE_TOWN.exec(norm.replace(/\bsaint\b/g, "st")); return m ? byTown.get(m[1])[0] : null; };
  // positions des arrêts (stops.json) : distance en mètres, Infinity si l'un des deux n'est pas placé
  const POS = new Map(stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)).map((s) => [s.id, [s.lat, s.lon]]));
  function dist(a, b) {
    const p = POS.get(a), q = POS.get(b);
    if (!p || !q) return Infinity;
    const r = Math.PI / 180, x = (q[1] - p[1]) * r * Math.cos(((p[0] + q[0]) / 2) * r), y = (q[0] - p[0]) * r;
    return Math.hypot(x, y) * 6371000;
  }
  const near = new Map();
  function targets(id) {
    if (!near.has(id)) {
      const w = WORDS.get(id), t = TOWN.get(id);
      near.set(id, !w ? [id] : [id].concat(stops.filter((o) => o.id !== id &&
        (TOWN.get(o.id) === t || w.every((x) => WORDS.get(o.id).includes(x)))).map((o) => o.id)));
    }
    return near.get(id);
  }

  // Ce qu'un message dit de la ligne et du sens, sans l'arrêt : { lines (citées), cible (arrêt visé ou "centre") }
  function said(p, text) {
    const norm = normFor(text, C);
    const lines = linesIn(norm);
    if (p.line && !lines.includes(p.line)) lines.push(p.line);
    return { lines, cible: p.dirStopId || (RE_CENTRE.test(norm) ? "centre" : townCible(norm)) };
  }

  // Ligne et sens à un arrêt : { line, dir, seq, via, vers }, chacun pouvant être null. Les lignes citées qui passent à
  // l'arrêt sont gardées et le sens choisit parmi elles seulement (« le 4 à Bel-Air direction Ouchy » reste la 4) ;
  // sans ligne citée qui y passe (« M2 … EPFL »), le sens choisit parmi les lignes de l'arrêt, ou la seule ligne.
  function resolveAt(stopId, lines, cible, date) {
    const at = (gaz.byId.get(stopId) || {}).lines || [];
    if (!at.length) return { line: lines.length === 1 ? lines[0] : null, dir: null, seq: null };
    const cited = lines.filter((l) => at.includes(l));
    const h = Number(HOUR.format(date)), night = h >= 22 || h < 6;
    const day = at.filter((l) => night || !/^N\d/.test(l));
    const metro = lines.some((l) => /^M\d$/.test(l)) ? day.filter((l) => /^M\d$/.test(l)) : [];
    const centre = cible === "centre" && !CENTRE.includes(stopId);
    if (centre || (cible && cible !== "centre")) {
      // lignes de nuit en journée : seulement pour un arrêt qui n'a qu'elles
      for (const set of cited.length ? [cited] : [metro, day.length ? day : at]) {
        if (!set.length) continue;
        if (centre) {
          const w = towardCentre(set, stopId);
          if (w) return { line: w.line, dir: w.dir, seq: w.seq, via: "centre" };
          continue;
        }
        const w = C.resolveDirection(net, set, stopId, cible, null);
        // via : ce qu'a écrit la personne, quand ce n'est pas le terminus (« direction Chailly » → « Val-Vert »)
        if (w) return { line: w.line, dir: w.dir || null, seq: w.dir ? w.seq : null, via: w.dir && w.dir !== cible ? cible : null };
        if (reaches(set, stopId, cible)) continue;          // plusieurs lignes y mènent : ambigu, rien d'approché
        // l'arrêt écrit n'est sur aucune de ces lignes : un arrêt de la même commune, ou dont le nom le contient, à
        // condition qu'ils mènent tous au même sens (« direction Malley » sur la 7 → Prilly-Malley, Gare/aréna)
        const found = new Map();
        for (const t of targets(cible).slice(1)) {
          const x = C.resolveDirection(net, set, stopId, t, null);
          if (x && x.dir) found.set(x.line + "|" + x.dir, x);
          else if (reaches(set, stopId, t)) { found.set("?", null); break; }
        }
        if (found.size === 1 && !found.has("?")) {
          const x = [...found.values()][0];
          return { line: x.line, dir: x.dir, seq: x.seq, via: null };
        }
        // ni l'arrêt ni sa commune sur ces lignes : le seul sens qui s'en approche (« Bel-Air, 7 direction
        // St-François » → Val-Vert : la 7 passe ensuite à Riponne, à 430 m de St-François ; l'autre sens s'en éloigne)
        const g = toward(set, stopId, cible);
        if (g) return { line: g.line, dir: g.dir, seq: g.seq, via: null, vers: cible };
      }
    }
    const line = cited.length ? (cited.length === 1 ? cited[0] : null) : (day.length === 1 ? day[0] : null);
    return { line, dir: null, seq: null };
  }
  // sens qui s'approche de X : dans ses 12 arrêts suivants, il passe plus près de X que l'arrêt de départ, à 800 m au
  // plus, et tous les autres sens (de ces lignes) restent nettement plus loin ; sinon rien
  function toward(set, stopId, cible) {
    const d0 = dist(stopId, cible);
    if (!Number.isFinite(d0)) return null;
    const all = [];
    for (const l of set) {
      for (const { dir, seq } of C.directionsAt(net, l, stopId)) {
        all.push({ line: l, dir: dir.id, seq, d: Math.min(...dir.stops.slice(seq + 1, seq + 13).map((s) => dist(s, cible))) });
      }
    }
    all.sort((a, b) => a.d - b.d);
    const best = all[0];
    if (!best || !(best.d < d0 && best.d <= 800)) return null;
    return all.some((o) => (o.line !== best.line || o.dir !== best.dir) && o.d < 1.25 * best.d) ? null : best;
  }
  // une des lignes mène-t-elle à cet arrêt, plus loin dans un de ses sens ?
  const reaches = (set, stopId, t) => set.some((l) => C.directionsAt(net, l, stopId).some(({ dir, seq }) => dir.stops.indexOf(t, seq + 1) !== -1));
  // vers le centre : pour chaque ligne, le sens qui atteint le plus vite un arrêt du centre ; une seule ligne possible
  function towardCentre(lines, stopId) {
    const found = [];
    for (const l of lines) {
      let best = null;
      for (const { dir, seq } of C.directionsAt(net, l, stopId)) {
        const k = Math.min(...CENTRE.map((c) => dir.stops.indexOf(c, seq + 1)).filter((i) => i > 0).map((i) => i - seq));
        if (Number.isFinite(k) && (!best || k < best.k)) best = { line: l, dir: dir.id, seq, k };
      }
      if (best) found.push(best);
    }
    return found.length === 1 ? found[0] : null;
  }
  // nouvel arrêt sur la ligne du message d'avant : même ligne, et même sens s'il est plus loin dans ce sens (12 arrêts)
  function follow(prev, stopId) {
    const d = prev.dir && C.dirById(net, prev.line, prev.dir);
    if (d) {
      const j = d.stops.indexOf(prev.stop), i = d.stops.indexOf(stopId, Math.max(0, j));
      if (j >= 0 && i > j && i - j <= 12) return { line: prev.line, dir: prev.dir, seq: i };
    }
    return { line: prev.line, dir: null, seq: null };
  }

  // Ce que dit un message, avec le contexte de la même personne (prev, mémoire des suites) :
  // { p (résultat du parseur, avec arrêt si utilisable), way (ligne et sens retenus), reply (arrêt pris du message auquel
  //   il répond), suite (« complete » : complète un signalement d'avant ; « precise » : l'arrêt qui manquait au message
  //   d'avant ; « herite » : ligne et sens du message d'avant ; « fin » : partis, à la suite de son signalement),
  //   base (signalement complété), why (rien à retenir : « question », « autre », « arret »), ctx (à retenir pour la suite) }
  function interpret(msg, prev) {
    const text = msg.text ?? msg.caption ?? "";
    const date = new Date((msg.date || 0) * 1000);
    const p = C.parseMessage(text, gaz);
    if (p.kind === "question" || p.kind === "autre") return { p, why: p.kind };
    const a = said(p, text);
    const says = a.lines.length > 0 || !!a.cible;
    const age = prev && prev.at ? date - Date.parse(prev.at) : Infinity;
    const fresh = age <= FRESH && age >= -60000 ? prev : null;
    const ctxOf = (q, way, lines, cible, at) => ({ stop: q.stopId, kind: q.kind, sub: q.sub || null, of: q.of || null,
      lines, cible, line: way.line || null, dir: way.dir || null, seq: way.dir ? way.seq : null, at: at.toISOString() });

    // 1. le message cite un arrêt
    if (p.usable) {
      let way = resolveAt(p.stopId, a.lines, a.cible, date), suite = null, lines = a.lines, cible = a.cible;
      if (!says && fresh && p.kind !== "fin") {
        if (!fresh.stop && (fresh.lines.length || fresh.cible)) {          // « 3 m2 dir croisettes » puis « à la Riponne »
          lines = fresh.lines; cible = fresh.cible;
          way = resolveAt(p.stopId, lines, cible, date);
          suite = "precise";
        } else if (fresh.stop && fresh.stop !== p.stopId && fresh.line && serves(p.stopId, fresh.line)) {
          way = follow(fresh, p.stopId);                                   // « descendus à Délices »
          lines = [fresh.line]; cible = fresh.cible;
          suite = "herite";
        }
      } else if (says && !way.line && fresh && fresh.line && serves(p.stopId, fresh.line)) {
        const w = resolveAt(p.stopId, [fresh.line], a.cible, date);       // plusieurs lignes possibles : celle d'avant
        if (w.line) { way = w; lines = [fresh.line]; suite = "herite"; }
      }
      // autres arrêts du message (« vieux moulin et grande borde ») : même ligne et même sens visé, chacun à son arrêt
      const more = (p.moreStopIds || []).map((id) => ({ id, way: resolveAt(id, lines, cible, date) }));
      return { p, way, suite, more, ctx: ctxOf(p, way, lines, cible, date) };
    }

    // 2. réponse à un signalement : « partis », « toujours là », ou ligne et sens (« montés dans le 18 dir Clochatte »)
    const rep = msg.reply_to_message;
    const rt = rep && (rep.text ?? rep.caption);
    if (rt) {
      const base = C.parseMessage(rt, gaz);
      if (base.usable && base.kind !== "fin") {
        const n = C.normalize(text), ba = said(base, rt), bway = resolveAt(base.stopId, ba.lines, ba.cible, date);
        if (base.kind === "controle" && gone(n)) return { p: Object.assign({}, base, { kind: "fin", of: "controle", sub: null }), reply: true, way: bway };
        if (base.kind === "perturbation" && RE_BACK.test(n)) return { p: Object.assign({}, base, { kind: "fin", of: "perturbation", sub: null }), reply: true, way: bway };
        if (still(n)) return { p: Object.assign({}, base), reply: true, way: bway };
        if (says && !p.stopId && p.kind !== "fin") {
          const bdate = new Date((rep.date || msg.date) * 1000);
          const lines = a.lines.length ? a.lines : ba.lines, cible = a.cible || ba.cible;
          const way = resolveAt(base.stopId, lines, cible, bdate);
          // la ligne citée doit passer à l'arrêt du signalement (sinon c'est un autre endroit, pas une précision)
          if (way.line && (!a.lines.length || a.lines.includes(way.line)) && (way.line !== bway.line || way.dir !== bway.dir)) {
            return { p: base, way, reply: true, suite: "complete", of: rep, ctx: ctxOf(base, way, lines, cible, bdate) };
          }
        }
      }
    }

    // 3. pas d'arrêt, mais une ligne ou un sens : complète le signalement d'avant de la même personne, si la ligne
    //    citée passe à cet arrêt (« 3 à Chauderon » puis « m2 dir croisettes » : ailleurs, arrêt à venir)
    if (!p.stopId && says && p.kind !== "fin") {
      if (fresh && fresh.stop && fresh.ext && (!a.lines.length || a.lines.some((l) => serves(fresh.stop, l)))) {
        const lines = a.lines.length ? a.lines : fresh.lines, cible = a.cible || fresh.cible;
        const way = resolveAt(fresh.stop, lines, cible, new Date(fresh.at));
        const ctx = Object.assign({}, fresh, { lines, cible, line: way.line || null, dir: way.dir || null, seq: way.dir ? way.seq : null });
        if (way.line && (!a.lines.length || a.lines.includes(way.line)) && (way.line !== fresh.line || way.dir !== fresh.dir)) {
          return { p: { kind: fresh.kind, sub: fresh.sub, of: fresh.of, stopId: fresh.stop, usable: true }, way, suite: "complete", base: fresh, ctx };
        }
        return { p, why: "deja", ctx };
      }
      // rien à compléter pour l'instant : gardé pour le message suivant (« 3 m2 dir croisettes » puis « à la Riponne »)
      const keep = fresh && !fresh.stop ? fresh : { lines: [], cible: null };
      return { p, why: "arret", pending: true,
        ctx: { stop: null, lines: a.lines.length ? a.lines : keep.lines, cible: a.cible || keep.cible, at: date.toISOString() } };
    }

    // 4. « partis » (ou « c'est rétabli ») sans arrêt, à la suite de son propre signalement
    if (!p.stopId && fresh && fresh.stop && fresh.ext) {
      const n = C.normalize(text), way = { line: fresh.line, dir: fresh.dir, seq: fresh.seq };
      const end = fresh.kind === "controle" && gone(n) ? "controle" : fresh.kind === "perturbation" && RE_BACK.test(n) ? "perturbation" : null;
      if (end) {
        return { p: { kind: "fin", of: end, sub: null, stopId: fresh.stop, usable: true }, way, suite: "fin",
          ctx: { stop: null, lines: [], cible: null, at: date.toISOString() } };
      }
    }
    return { p, why: "arret" };
  }

  // part : autre arrêt du même message (empreinte propre à cet arrêt)
  async function toRow(msg, p, w, part) {
    const direction = (w && w.dir) || null;
    const who = msg.from && !msg.from.is_bot ? msg.from.id : null;
    const day = DAY.format(new Date(msg.date * 1000));
    return {
      kind: p.kind, sub: p.sub || null, of_kind: p.of || null, stop_id: p.stopId,
      line: (w && w.line) || null, direction, seq: direction ? w.seq : null,
      src: "telegram",
      ext_id: (await sha256(`${salt}:${msg.chat.id}:${msg.message_id}` + (part ? ":" + part : ""))).slice(0, 24),
      voter: who != null ? (await sha256(`${salt}:tg:${who}:${p.stopId}:${day}`)).slice(0, 32) : null,
      at: new Date(msg.date * 1000).toISOString(),
    };
  }
  // signalement complété, tel qu'il a été enregistré (même empreinte, même heure, même voix), avec la ligne et le sens
  function completed(base, w) {
    return { kind: base.kind, sub: base.sub || null, of_kind: base.of || null, stop_id: base.stop,
      line: w.line || null, direction: w.dir || null, seq: w.dir ? w.seq : null, src: "telegram",
      ext_id: base.ext, voter: base.voter || null, at: base.at };
  }
  // empreinte de l'auteur pour la mémoire des suites (par groupe : jamais reliée d'un groupe à l'autre)
  const author = async (msg) => (msg.from && !msg.from.is_bot ? (await sha256(`${salt}:suite:${msg.chat.id}:${msg.from.id}`)).slice(0, 32) : null);

  function describe(p, w, more) {
    const what = p.kind === "controle" ? "contrôle"
      : p.kind === "perturbation" ? "perturbation" + (SUB[p.sub] ? " (" + SUB[p.sub] + ")" : "")
      : p.of === "perturbation" ? "fin de perturbation" : "fin de contrôle (ils sont partis)";
    const where = (id, w) => {
      const via = w && w.dir && w.via ? (w.via === "centre" ? " (vers le centre)" : " (par " + name(w.via) + ")") :
        w && w.dir && w.vers ? " (vers " + name(w.vers) + ")" : "";
      return name(id) + (w && w.line ? ", ligne " + w.line : "") + (w && w.dir ? ", direction " + name(w.dir) + via : "");
    };
    return what + " à " + where(p.stopId, w) + (more || []).map((m) => " ; aussi à " + where(m.id, m.way)).join("");
  }
  const SUITE = {
    complete: " (complète le signalement d'avant)",
    precise: " (avec la ligne et le sens du message d'avant)",
    herite: " (avec la ligne du message d'avant)",
    fin: " (à la suite du signalement d'avant)",
  };
  function understood(r) {
    return "Compris : " + describe(r.p, r.way, r.suite === "complete" ? null : r.more) + (r.suite ? SUITE[r.suite] : r.reply ? " (en réponse à un message qui citait cet arrêt)" : "") + ".";
  }
  function pendingText(r) {
    const c = r.ctx || {};
    const bits = [c.lines && c.lines.length ? "ligne " + c.lines.join(", ") : null,
      c.cible === "centre" ? "vers le centre" : c.cible ? "direction " + name(c.cible) : null].filter(Boolean).join(", ");
    return "Noté : " + bits + ". Il manque l'arrêt : le message suivant qui le donne sera placé avec ça.";
  }

  const INTRO = "Bonjour ! Je suis le bot de Vigie Lausanne, la carte des contrôles et perturbations sur le réseau tl : " + SITE + "\n\n" +
    "Dans le groupe de signalement, je lis les messages et je place sur la carte ceux qui citent un arrêt (contrôle, " +
    "perturbation, « partis »). Un message qui suit le tien (« ils montent dans le 8 ») complète ton signalement. Je ne " +
    "garde que le type, l'arrêt, la ligne, le sens et l'heure : jamais le texte ni l'auteur (une empreinte chiffrée sert " +
    "seulement à ne pas compter deux fois la même personne, et à relier tes messages qui se suivent pendant 30 minutes). " +
    "Je ne poste rien dans le groupe.\n\n" +
    "Pour essayer, écris-moi ici un message comme dans le groupe : je te dis ce que je comprends, sans rien enregistrer.\n\n" +
    "Confidentialité : " + SITE + "/confidentialite.html";

  function privateAnswer(msg, r) {
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text || /^\/(start|aide|help)\b/i.test(text)) return INTRO;
    if (r.p.usable) return understood(r) + "\n\nIci c'est un test : rien n'est enregistré. Dans le groupe, ce message irait sur la carte.";
    if (r.why === "question") return "C'est une question : elle ne va pas sur la carte.";
    if (r.why === "autre") return "Ce message ne ressemble pas à un signalement (un fait d'hier, ou rien sur un contrôle) : il ne va pas sur la carte.";
    if (r.pending) return pendingText(r);
    if (r.why === "deja") return "Rien de neuf : ton signalement d'avant a déjà cette ligne et ce sens.";
    return NO_STOP;
  }
  const NO_STOP = "Je ne trouve pas d'arrêt dans ce message. Exemples : « Contrôleurs à Flon M2 direction Croisettes », " +
    "« Panne ligne 9 à Chauderon », ou « partis » en réponse à un signalement.";

  // Groupe de test : le bot répond à chaque signalement (et à ce qui y ressemble) ce qu'il comprend, rien n'est enregistré
  function testAnswer(msg, fromBot, r) {
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (/^\/(start|aide|help)(@\w+)?\b/i.test(text)) {
      return "Groupe de test : je réponds ici ce que je comprends de chaque signalement, sans rien enregistrer. " +
        "Dans le groupe de signalement, je ne poste jamais rien. Carte : " + SITE;
    }
    if (r.p.usable) return understood(r) + " Groupe de test : rien n'est enregistré.";
    if (r.pending && !fromBot) return pendingText(r);
    if (!fromBot && r.why !== "question" && r.why !== "autre" && RE_ATTEMPT.test(C.normalize(text))) return NO_STOP;
    return null;
  }

  // mémoire des suites : lecture et écriture protégées (une panne ne bloque jamais un signalement)
  function within(promise, ms) {
    let t;
    const late = new Promise((_, no) => { t = setTimeout(() => no(new Error("délai dépassé")), ms); });
    return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(t));
  }
  async function recall(memoire, key, log, ms) {
    if (!memoire || !key) return null;
    try { return await within(memoire.lire(key), ms); }
    catch (e) { log.push("mémoire des suites indisponible (" + ((e && e.message) || e) + ")"); return null; }
  }
  async function remember(memoire, key, ctx, log, ms) {
    if (!memoire || !key || !ctx) return;
    try { await within(memoire.noter(key, ctx), ms); }
    catch (e) { log.push("mémoire des suites : écriture impossible (" + ((e && e.message) || e) + ")"); }
  }

  // Une mise à jour Telegram → { rows (signalements à enregistrer), merge (mettre à jour : message modifié ou
  // signalement complété), reply (méthode de l'API Bot à exécuter en réponse au webhook), log (sans le texte des
  // messages), commit (à appeler une fois rows enregistrés : note le contexte pour le message suivant ; si
  // l'enregistrement échoue, Telegram renvoie le message, relu alors avec le même contexte) }
  // opts.memoire : { lire(cle) → contexte ou null, noter(cle, contexte) } pour relier les messages qui se suivent ;
  // opts.delai : attente maximale de la mémoire, en ms (3 s par défaut)
  async function handle(update, opts = {}) {
    /** @type {{ rows: any[], merge: boolean, reply: any, log: string[], commit: null | (() => Promise<void>) }} */
    const out = { rows: [], merge: false, reply: null, log: [], commit: null };
    const memoire = opts.memoire || null, ms = opts.delai || 3000;
    const mcm = update && update.my_chat_member;
    if (mcm) {
      const c = mcm.chat, st = mcm.new_chat_member && mcm.new_chat_member.status;
      if (!isGroup(c)) return out;
      if (tests.has(String(c.id))) out.log.push(`groupe de test « ${c.title} » : le bot est maintenant « ${st} »`);
      else if (!group) out.log.push(`installation : bot « ${st} » dans le groupe « ${c.title} », TG_CHAT_ID = ${c.id}`);
      else if (String(c.id) === group) out.log.push(`groupe de signalement : le bot est maintenant « ${st} »`);
      else if (st === "member" || st === "administrator") {
        out.reply = { method: "leaveChat", chat_id: c.id };
        out.log.push(`ajouté à un autre groupe (${c.id}) : le bot en sort`);
      }
      return out;
    }
    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.chat) return out;
    const edited = !update.message;
    const fromBot = !!(msg.from && msg.from.is_bot);
    // contexte de la même personne : pas pour un message modifié ni pour un bot
    const key = !edited && !fromBot ? await author(msg) : null;
    const interpretWithMemory = async () => {
      const prev = await recall(memoire, key, out.log, ms);
      const r = interpret(msg, prev);
      const save = (row) => {
        const ctx = r.ctx && (row && !r.ctx.ext && r.ctx.stop ? Object.assign({}, r.ctx, { ext: row.ext_id, voter: row.voter }) : r.ctx);
        out.commit = ctx && memoire && key ? () => remember(memoire, key, ctx, out.log, ms) : null;
      };
      return { r, save };
    };
    if (msg.chat.type === "private") {
      if (!edited) {
        const text = (msg.text ?? msg.caption ?? "").trim();
        const { r, save } = await interpretWithMemory();
        if (text && !/^\/(start|aide|help)\b/i.test(text)) save(r.p.usable && !r.suite ? await toRow(msg, r.p, r.way) : null);
        out.reply = { method: "sendMessage", chat_id: msg.chat.id, text: privateAnswer(msg, r), link_preview_options: { is_disabled: true } };
      }
      return out;
    }
    if (!isGroup(msg.chat)) return out;
    if (tests.has(String(msg.chat.id))) {
      // un autre bot (signalement anonyme) : réponse seulement à un signalement compris, jamais à une réponse (pas de
      // conversation entre bots)
      let text = null;
      if (!edited && !(fromBot && msg.reply_to_message)) {
        const { r, save } = await interpretWithMemory();
        save(r.p.usable && !r.suite ? await toRow(msg, r.p, r.way) : null);
        text = testAnswer(msg, fromBot, r);
      }
      if (text) out.reply = { method: "sendMessage", chat_id: msg.chat.id, text, link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
      out.log.push("groupe de test : " + (text ? "réponse envoyée" : "rien à répondre"));
      return out;
    }
    if (!group) { out.log.push(`installation : message du groupe « ${msg.chat.title} », TG_CHAT_ID = ${msg.chat.id}`); return out; }
    if (String(msg.chat.id) !== group) {
      out.reply = { method: "leaveChat", chat_id: msg.chat.id };
      out.log.push(`message d'un autre groupe (${msg.chat.id}) : le bot en sort`);
      return out;
    }
    // messages d'autres bots : ceux du bot de signalement anonyme comptent (sans voix personnelle) ; les réponses d'un
    // bot à un message (commandes, accueil…) sont ignorées
    if (fromBot && msg.reply_to_message) return out;
    const { r, save } = await interpretWithMemory();
    if (!r.p.usable) {
      save(null);
      out.log.push(r.pending ? "ligne ou sens sans arrêt : gardés pour le message suivant" : r.why === "deja" ? "suite sans rien de neuf" : "message sans signalement");
      return out;
    }
    let row;
    if (r.suite === "complete") {
      row = r.base ? completed(r.base, r.way) : await toRow(Object.assign({ chat: msg.chat }, r.of), r.p, r.way);
      out.merge = true;
    } else {
      row = await toRow(msg, r.p, r.way);
      out.merge = edited;
      // autres arrêts du même message : un signalement chacun
      for (const m of r.more || []) out.rows.push(await toRow(msg, Object.assign({}, r.p, { stopId: m.id }), m.way, m.id));
    }
    out.rows.unshift(row);
    save(row);
    out.log.push(`${row.kind}${row.of_kind ? "/" + row.of_kind : ""} · ${row.stop_id} · ligne ${row.line || "-"}` +
      (row.direction ? " → " + row.direction : "") + (out.rows.length > 1 ? " + " + (out.rows.length - 1) + " autre(s) arrêt(s)" : "") +
      (r.suite ? " (suite : " + r.suite + ")" : r.reply ? " (réponse)" : "") + (edited ? " (modifié)" : ""));
    return out;
  }

  return { handle, interpret, describe };
}
