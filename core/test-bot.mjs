// node core/test-bot.mjs — vérifie la logique du bot Telegram (supabase/functions/telegram/bot.mjs)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createBot, deriveSecrets } from "../supabase/functions/telegram/bot.mjs";

const require = createRequire(import.meta.url);
const C = require("./vigie-core.js");
const stops = require("../collector/stops.json");
const lignes = require("../collector/lignes.json");

let ok = 0, bad = 0;
const assert = (cond, m) => { if (cond) ok++; else { bad++; console.log("✗", m); } };

const GROUP = -1001234567890;
const bot = createBot({ C, stops, lignes, chatId: String(GROUP), salt: "sel-de-test", site: "https://vigie-lausanne.ch" });
const t0 = Math.floor(Date.UTC(2026, 9, 27, 10, 0, 0) / 1000);
let mid = 100;
const msg = (text, o = {}) => Object.assign({ message_id: ++mid, date: t0, chat: { id: GROUP, type: "supergroup", title: "Contrôleurs Lausanne" },
  from: { id: 42, is_bot: false, first_name: "A" }, text }, o);
const up = (m, edited) => (edited ? { update_id: mid, edited_message: m } : { update_id: mid, message: m });

// ---- message du groupe
const m1 = msg("Contrôleurs à Flon M2 direction Croisettes");
const r1 = await bot.handle(up(m1));
const row = r1.rows[0];
assert(r1.rows.length === 1 && row.kind === "controle" && row.stop_id === "flon" && row.line === "M2", "message du groupe : contrôle à Flon, M2");
assert(row.direction === "croisettes" && row.seq === lignes.find((l) => l.id === "M2").dirs.find((d) => d.id === "croisettes").stops.indexOf("flon"),
  "sens et rang déduits de « direction Croisettes »");
assert(row.src === "telegram" && /^[0-9a-f]{24}$/.test(row.ext_id) && /^[0-9a-f]{32}$/.test(row.voter) && row.at === new Date(t0 * 1000).toISOString(),
  "source, empreintes et heure du message");
assert(!JSON.stringify(r1).includes("Contrôleurs à Flon") && Object.values(row).every((x) => x !== 42 && x !== "42") &&
  Object.keys(row).sort().join() === "at,direction,ext_id,kind,line,of_kind,seq,src,stop_id,sub,voter", "ni le texte ni l'auteur ne sont enregistrés ou journalisés");
assert(r1.reply === null && !r1.merge, "rien n'est posté dans le groupe");

// ---- une voix par personne, par arrêt et par jour
const v = async (text, from, date) => (await bot.handle(up(msg(text, { from, date: date || t0 })))).rows[0].voter;
const A = { id: 42, is_bot: false }, B = { id: 43, is_bot: false };
assert((await v("controle flon", A)) === row.voter, "même personne, même arrêt, même jour : même voix");
assert((await v("controle flon", B)) !== row.voter, "autre personne : autre voix");
assert((await v("controle chauderon", A)) !== row.voter, "même personne, autre arrêt : autre voix");
assert((await v("controle flon", A, t0 + 86400)) !== row.voter, "même personne, le lendemain : autre voix");
const again = await bot.handle(up(m1));
assert(again.rows[0].ext_id === row.ext_id, "même message reçu deux fois : même empreinte (pas de doublon en base)");

// ---- réponses à un signalement
const reply = async (text, to) => (await bot.handle(up(msg(text, { reply_to_message: to })))).rows;
const gone = await reply("Ils sont partis 👍", m1);
assert(gone.length === 1 && gone[0].kind === "fin" && gone[0].of_kind === "controle" && gone[0].stop_id === "flon", "« partis » en réponse : fin du contrôle à Flon");
const stillThere = await reply("toujours là", m1);
assert(stillThere.length === 1 && stillThere[0].kind === "controle" && stillThere[0].stop_id === "flon" && stillThere[0].line === "M2", "« toujours là » en réponse : confirmation à Flon");
for (const t of ["merci !", "ok", "c'est bon merci", "toujours là ?", "pas encore partis", "lol"]) {
  assert((await reply(t, m1)).length === 0, `« ${t} » en réponse : rien`);
}
const panne = msg("Panne ligne 9 à Chauderon");
assert((await bot.handle(up(panne))).rows[0].kind === "perturbation", "perturbation");
const back = await reply("c'est rétabli", panne);
assert(back.length === 1 && back[0].kind === "fin" && back[0].of_kind === "perturbation" && back[0].stop_id === "chauderon", "« rétabli » en réponse à une panne : fin de perturbation");
assert((await reply("partis", panne)).length === 0, "« partis » en réponse à une panne : rien");
assert((await reply("partis", msg("quelqu'un a vu des contrôleurs ?"))).length === 0, "réponse à un message sans arrêt : rien");

// ---- cas particuliers du groupe
const edit = await bot.handle(up(msg("controleurs a Bessieres"), true));
assert(edit.rows.length === 1 && edit.merge, "message modifié : mise à jour du signalement");
assert((await bot.handle(up(msg("salut tout le monde")))).rows.length === 0, "message sans arrêt : rien");
assert((await bot.handle(up(msg("controle Flon", { from: { id: 7, is_bot: true } })))).rows.length === 0, "message d'un autre bot : ignoré");
const anon = await bot.handle(up(msg("controle Flon", { from: { id: 1087968824, is_bot: true }, sender_chat: { id: GROUP, type: "supergroup" } })));
assert(anon.rows.length === 1 && anon.rows[0].voter === null, "admin anonyme : pris en compte, sans voix personnelle");
assert((await bot.handle(up(msg(null, { caption: "contrôleurs à Chauderon", photo: [{}] })))).rows[0]?.stop_id === "chauderon", "photo avec légende");

// ---- autres groupes : le bot en sort
const other = await bot.handle(up(msg("controle Flon", { chat: { id: -100999, type: "supergroup", title: "autre" } })));
assert(other.rows.length === 0 && other.reply && other.reply.method === "leaveChat" && other.reply.chat_id === -100999, "message d'un autre groupe : le bot en sort");
const added = await bot.handle({ update_id: 1, my_chat_member: { chat: { id: -100999, type: "supergroup", title: "autre" }, new_chat_member: { status: "member" } } });
assert(added.reply && added.reply.method === "leaveChat", "ajouté à un autre groupe : le bot en sort");
const ours = await bot.handle({ update_id: 1, my_chat_member: { chat: { id: GROUP, type: "supergroup", title: "x" }, new_chat_member: { status: "administrator" } } });
assert(ours.reply === null && ours.log.length === 1, "ajouté au groupe configuré : il reste");

// ---- installation (pas encore de TG_CHAT_ID) : rien n'est enregistré, l'identifiant du groupe est noté
const setup = createBot({ C, stops, lignes, chatId: "", salt: "s" });
const s1 = await setup.handle(up(msg("controle Flon")));
assert(s1.rows.length === 0 && s1.reply === null && s1.log[0].includes(String(GROUP)), "installation : identifiant du groupe noté, rien d'enregistré");

// ---- groupe de test (ex. « devgroup3 ») : le bot répond ce qu'il comprend, rien n'est enregistré
const TEST = -100777;
const inTest = (text, o = {}) => up(msg(text, Object.assign({ chat: { id: TEST, type: "supergroup", title: "devgroup3" } }, o)));
for (const [label, b] of [["avant l'installation", createBot({ C, stops, lignes, chatId: "", testIds: String(TEST), salt: "s" })],
                          ["avec le groupe de signalement", createBot({ C, stops, lignes, chatId: String(GROUP), testIds: `${TEST}, -100888`, salt: "s" })]]) {
  const t1 = await b.handle(inTest("Contrôleurs à Flon M2 direction Croisettes"));
  assert(t1.rows.length === 0 && t1.reply && t1.reply.method === "sendMessage" && t1.reply.chat_id === TEST &&
    /Compris : contrôle à Lausanne-Flon, ligne M2, direction Croisettes/.test(t1.reply.text) && /rien n'est enregistré/.test(t1.reply.text) &&
    t1.reply.reply_parameters.message_id === mid, `groupe de test (${label}) : réponse au message, rien d'enregistré`);
  const t2 = await b.handle(inTest("salut, on teste le bot"));
  assert(t2.reply === null && t2.rows.length === 0, `groupe de test (${label}) : bavardage, pas de réponse`);
  const t3 = await b.handle(inTest("contrôleurs dans le bus"));
  assert(t3.reply && /ne trouve pas d'arrêt/.test(t3.reply.text), `groupe de test (${label}) : signalement sans arrêt reconnu, le bot le dit`);
  const t4 = await b.handle(inTest("partis", { reply_to_message: msg("controle a Chauderon") }));
  assert(t4.reply && /fin de contrôle .* Chauderon/.test(t4.reply.text), `groupe de test (${label}) : réponse « partis » comprise`);
  const t5 = await b.handle(inTest("/start@VigieLausanneBot"));
  assert(t5.reply && /Groupe de test/.test(t5.reply.text), `groupe de test (${label}) : /start`);
  assert((await b.handle(inTest("controle Flon", { from: { id: 9, is_bot: true } }))).reply === null, `groupe de test (${label}) : messages des bots ignorés`);
  const t6 = await b.handle({ update_id: 1, my_chat_member: { chat: { id: TEST, type: "supergroup", title: "devgroup3" }, new_chat_member: { status: "member" } } });
  assert(t6.reply === null, `groupe de test (${label}) : le bot y reste`);
}
const pre = createBot({ C, stops, lignes, chatId: "", testIds: String(TEST), salt: "s" });
const main = await pre.handle(up(msg("controle Flon")));
assert(main.rows.length === 0 && main.reply === null && main.log[0].includes(String(GROUP)), "groupe de test configuré, signalement pas encore : le bot reste muet ailleurs et note l'identifiant");

// ---- messages privés : explication, ou test sans rien enregistrer
const priv = (text) => ({ update_id: 1, message: { message_id: 1, date: t0, chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false }, text } });
const start = await bot.handle(priv("/start"));
assert(start.reply.method === "sendMessage" && start.reply.chat_id === 5 && start.reply.text.includes("https://vigie-lausanne.ch/confidentialite.html"), "/start : présentation du bot");
const test = await bot.handle(priv("Contrôleurs à Flon M2 direction Croisettes"));
assert(test.rows.length === 0 && /Compris : contrôle à Lausanne-Flon, ligne M2, direction Croisettes/.test(test.reply.text), "test en privé : interprétation, rien d'enregistré");
assert(/ne trouve pas d'arrêt/.test((await bot.handle(priv("bonjour"))).reply.text), "test en privé : message sans arrêt");
assert(/question/.test((await bot.handle(priv("des contrôleurs à Flon ?"))).reply.text), "test en privé : question");

// ---- secrets dérivés : même calcul en JavaScript (fonction) et en Python (installation)
const sec = await deriveSecrets("123456:ABC-test");
const py = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'tools'); import bot_telegram as b; print(b.webhook_secret('123456:ABC-test'))"],
  { cwd: new URL("..", import.meta.url).pathname }).toString().trim();
assert(/^[0-9a-f]{48}$/.test(sec.webhook) && sec.webhook === py, "secret du webhook identique en JS et en Python");
assert(sec.salt !== sec.webhook && (await deriveSecrets("123456:ABC-test", "mon-sel")).salt === "mon-sel", "sel : dérivé du jeton, ou VIGIE_SALT");

console.log(bad ? `bot : ${bad} échec(s), ${ok} OK` : `bot : ${ok} tests OK`);
process.exit(bad ? 1 : 0);
