// Vigie — bot Telegram : la logique, sans réseau ni Deno (testée avec Node : core/test-bot.mjs).
//
// Les admins ajoutent le bot au groupe de signalement. Telegram envoie alors chaque message du groupe à la fonction
// Supabase « telegram » (webhook, voir index.ts), qui appelle handle() :
//   - message du groupe configuré (TG_CHAT_ID) qui cite un arrêt → un signalement (contrôle, perturbation ou fin),
//     lu avec le même parseur que l'app (core/vigie-core.js) ; une réponse « partis » ou « toujours là » à un
//     signalement prend l'arrêt du message auquel elle répond ;
//   - message privé → le bot explique ce qu'il fait, ou montre ce qu'il comprend d'un message (rien n'est enregistré) ;
//   - groupe de test (TG_TEST_CHAT_ID, par ex. celui où les admins essaient le bot) → le bot répond dans le groupe ce
//     qu'il comprend de chaque signalement, sans rien enregistrer ;
//   - autre groupe → le bot en sort aussitôt (personne ne peut l'utiliser pour injecter de faux signalements) ;
//   - pas encore de TG_CHAT_ID (installation) → le bot n'enregistre rien, reste muet et note l'identifiant du groupe.
// Rien n'est jamais posté dans le groupe de signalement. Ni le texte des messages ni leur auteur ne sont enregistrés : seulement une
// empreinte du message (anti-doublon) et une empreinte « personne + arrêt + jour » (une seule voix par personne et par
// arrêt chaque jour, comme dans l'app), toutes deux salées, donc non réversibles.

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
const isGroup = (c) => c && (c.type === "group" || c.type === "supergroup");
// message de test qui ressemble à un signalement sans arrêt reconnu : le bot le dit (sinon il reste muet)
const RE_ATTEMPT = /\b(contr\w*|agents?|panne\w*|retard\w*|devi\w*|accident\w*|partis?|bloque\w*|perturb\w*|bonde\w*)\b/;

export function createBot({ C, stops, lignes, chatId, testIds, salt, site }) {
  const gaz = C.buildGazetteer(stops);
  const net = C.buildNetwork(lignes);
  const group = String(chatId || "").trim();
  const tests = new Set(String(testIds || "").split(/[\s,;]+/).filter(Boolean));
  const SITE = (site || "https://vigie-lausanne.ch").replace(/\/$/, "");
  const name = (id) => (gaz.byId.get(id) || {}).name || id;

  // Ce que dit un message : { p (résultat du parseur, avec arrêt si utilisable), reply (arrêt pris du message
  // auquel il répond), why (« question » ou « arret » s'il n'y a rien à retenir) }
  function interpret(msg) {
    const text = msg.text ?? msg.caption ?? "";
    const p = C.parseMessage(text, gaz);
    if (p.usable) return { p, reply: false };
    if (p.kind === "question") return { p, reply: false, why: "question" };
    const rep = msg.reply_to_message;
    const rt = rep && (rep.text ?? rep.caption);
    if (rt) {
      const base = C.parseMessage(rt, gaz);
      if (base.usable && base.kind !== "fin") {
        const n = C.normalize(text);
        if (base.kind === "controle" && gone(n)) return { p: Object.assign({}, base, { kind: "fin", of: "controle", sub: null }), reply: true };
        if (base.kind === "perturbation" && RE_BACK.test(n)) return { p: Object.assign({}, base, { kind: "fin", of: "perturbation", sub: null }), reply: true };
        if (still(n)) return { p: Object.assign({}, base), reply: true };
      }
    }
    return { p, reply: false, why: "arret" };
  }

  function way(p) {
    if (!p.dirStopId) return null;
    const stop = gaz.byId.get(p.stopId) || {};
    return C.resolveDirection(net, stop.lines || [], p.stopId, p.dirStopId, p.line);
  }

  async function toRow(msg, p) {
    const w = way(p);
    const direction = (w && w.dir) || null;
    const who = msg.from && !msg.from.is_bot ? msg.from.id : null;
    const day = DAY.format(new Date(msg.date * 1000));
    return {
      kind: p.kind, sub: p.sub || null, of_kind: p.of || null, stop_id: p.stopId,
      line: p.line || (w && w.line) || null, direction, seq: direction ? w.seq : null,
      src: "telegram",
      ext_id: (await sha256(`${salt}:${msg.chat.id}:${msg.message_id}`)).slice(0, 24),
      voter: who != null ? (await sha256(`${salt}:tg:${who}:${p.stopId}:${day}`)).slice(0, 32) : null,
      at: new Date(msg.date * 1000).toISOString(),
    };
  }

  function describe(p) {
    const what = p.kind === "controle" ? "contrôle"
      : p.kind === "perturbation" ? "perturbation" + (SUB[p.sub] ? " (" + SUB[p.sub] + ")" : "")
      : p.of === "perturbation" ? "fin de perturbation" : "fin de contrôle (ils sont partis)";
    const w = way(p), line = p.line || (w && w.line);
    return what + " à " + name(p.stopId) + (line ? ", ligne " + line : "") + (w && w.dir ? ", direction " + name(w.dir) : "");
  }

  const INTRO = "Bonjour ! Je suis le bot de Vigie Lausanne, la carte des contrôles et perturbations sur le réseau tl : " + SITE + "\n\n" +
    "Dans le groupe de signalement, je lis les messages et je place sur la carte ceux qui citent un arrêt (contrôle, " +
    "perturbation, « partis »). Je ne garde que le type, l'arrêt, la ligne, le sens et l'heure : jamais le texte ni " +
    "l'auteur (une empreinte chiffrée sert seulement à ne pas compter deux fois la même personne). Je ne poste rien dans le groupe.\n\n" +
    "Pour essayer, écris-moi ici un message comme dans le groupe : je te dis ce que je comprends, sans rien enregistrer.\n\n" +
    "Confidentialité : " + SITE + "/confidentialite.html";

  function privateAnswer(msg) {
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text || /^\/(start|aide|help)\b/i.test(text)) return INTRO;
    const { p, reply, why } = interpret(msg);
    if (p.usable) {
      return "Compris : " + describe(p) + (reply ? " (en réponse à un message qui citait cet arrêt)" : "") + ".\n\n" +
        "Ici c'est un test : rien n'est enregistré. Dans le groupe, ce message irait sur la carte.";
    }
    if (why === "question") return "C'est une question : elle ne va pas sur la carte.";
    return NO_STOP;
  }
  const NO_STOP = "Je ne trouve pas d'arrêt dans ce message. Exemples : « Contrôleurs à Flon M2 direction Croisettes », " +
    "« Panne ligne 9 à Chauderon », ou « partis » en réponse à un signalement.";

  // Groupe de test : le bot répond à chaque signalement (et à ce qui y ressemble) ce qu'il comprend, rien n'est enregistré
  function testAnswer(msg) {
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (/^\/(start|aide|help)(@\w+)?\b/i.test(text)) {
      return "Groupe de test : je réponds ici ce que je comprends de chaque signalement, sans rien enregistrer. " +
        "Dans le groupe de signalement, je ne poste jamais rien. Carte : " + SITE;
    }
    const { p, reply, why } = interpret(msg);
    if (p.usable) {
      return "Compris : " + describe(p) + (reply ? " (en réponse à un message qui citait cet arrêt)" : "") + ". " +
        "Groupe de test : rien n'est enregistré.";
    }
    if (why !== "question" && RE_ATTEMPT.test(C.normalize(text))) return NO_STOP;
    return null;
  }

  // Une mise à jour Telegram → { rows (signalements à enregistrer), merge (message modifié : mettre à jour),
  // reply (méthode de l'API Bot à exécuter en réponse au webhook), log (sans le texte des messages) }
  async function handle(update) {
    const out = { rows: [], merge: false, reply: null, log: [] };
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
    if (msg.chat.type === "private") {
      if (!edited) out.reply = { method: "sendMessage", chat_id: msg.chat.id, text: privateAnswer(msg), link_preview_options: { is_disabled: true } };
      return out;
    }
    if (!isGroup(msg.chat)) return out;
    if (tests.has(String(msg.chat.id))) {
      const text = edited || (msg.from && msg.from.is_bot) ? null : testAnswer(msg);
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
    // autres bots du groupe : ignorés (sauf un admin anonyme, qui écrit au nom du groupe)
    if (msg.from && msg.from.is_bot && !(msg.sender_chat && String(msg.sender_chat.id) === group)) return out;
    const { p, reply } = interpret(msg);
    if (!p.usable) { out.log.push("message sans signalement"); return out; }
    const row = await toRow(msg, p);
    out.rows.push(row);
    out.merge = edited;
    out.log.push(`${row.kind}${row.of_kind ? "/" + row.of_kind : ""} · ${row.stop_id} · ligne ${row.line || "-"}` +
      (row.direction ? " → " + row.direction : "") + (reply ? " (réponse)" : "") + (edited ? " (modifié)" : ""));
    return out;
  }

  return { handle, interpret, describe };
}
