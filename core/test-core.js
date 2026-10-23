// node test-core.js  — vérifie le parseur et le calcul de confiance
const core = require("./vigie-core.js");
const STOPS = require("./stops-base.js");
const gaz = core.buildGazetteer(STOPS);

const cases = require("./parser-cases.json").map((c) => [c.msg, c.exp]);

let ok = 0, bad = 0;
for (const [msg, exp] of cases) {
  const r = core.parseMessage(msg, gaz);
  const diffs = Object.entries(exp).filter(([k, v]) => r[k] !== v);
  if (diffs.length) {
    bad++;
    console.log("✗", JSON.stringify(msg), "→", JSON.stringify(r), "attendu", JSON.stringify(exp));
  } else ok++;
}
console.log(`parseur : ${ok}/${ok + bad} OK`);

// ---- confiance
const now = Date.now(), min = 60000;
const R = (o) => Object.assign({ stopId: "flon", kind: "controle", src: "telegram", id: Math.random().toString(36) }, o);
const show = (label, reps) => {
  const cl = core.computeClusters(reps, now);
  const c = cl[0];
  console.log(label.padEnd(52), c ? `${(c.confidence * 100).toFixed(1)} % (${c.level}, r=${core.radiusFor(c.confidence)}px, ${core.colorFor(c.confidence)})` : "masqué");
  return c ? c.confidence : 0;
};
const a = show("1 message Telegram, à l'instant", [R({ at: now })]);
const b = show("1 message Telegram, il y a 20 min", [R({ at: now - 20 * min })]);
const c = show("1 message Telegram, il y a 60 min", [R({ at: now - 60 * min })]);
const d = show("3 messages Telegram, 0/3/6 min", [R({ at: now }), R({ at: now - 3 * min }), R({ at: now - 6 * min })]);
const e = show("3 messages puis « partis » (app) il y a 1 min", [R({ at: now - 2 * min }), R({ at: now - 3 * min }), R({ at: now - 6 * min }), R({ kind: "fin", src: "app", by: "u1", at: now - 1 * min })]);
const f = show("même utilisateur app ×3 (compte 1 voix)", [R({ src: "app", by: "u1", at: now }), R({ src: "app", by: "u1", at: now - min }), R({ src: "app", by: "u1", at: now - 2 * min })]);
const g = show("signalement après le démenti (pas affecté)", [R({ kind: "fin", src: "app", by: "u2", at: now - 10 * min }), R({ src: "app", by: "u3", at: now - 1 * min })]);
const h = show("1 message, il y a 130 min (hors fenêtre)", [R({ at: now - 130 * min })]);

const assert = (cond, m) => { if (!cond) { console.log("✗", m); bad++; } else ok++; };
assert(Math.abs(a - 0.45) < 1e-9, "1 message frais = 45 %");
assert(Math.abs(b - 0.225) < 1e-9, "demi-vie 20 min");
assert(d > 0.7 && d > a, "3 messages → forte");
assert(e < d * 0.5, "démenti divise la confiance");
assert(Math.abs(f - 0.6) < 1e-9, "dédoublonnage par personne");
assert(Math.abs(g - 0.6 * Math.pow(0.5, 1 / 20)) < 1e-9, "démenti antérieur ignoré");
assert(h === 0, "fenêtre max 120 min");
assert(c < b && b < a, "décroissance monotone");
console.log(bad ? `${bad} échec(s)` : "tous les tests passent");
process.exit(bad ? 1 : 0);
