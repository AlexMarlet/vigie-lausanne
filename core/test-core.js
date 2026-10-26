// node test-core.js  — vérifie le parseur et le calcul de confiance
const core = require("./vigie-core.js");
const STOPS = require("../collector/stops.json");   // liste complète, générée par tools/build_app.py
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

// ---- réseau, sens et position estimée
const M2 = ["ouchy", "jordils", "delices", "grancy", "gare", "flon", "riponne", "bessieres", "ours", "chuv", "sallaz", "fourmi", "vennes", "croisettes"];
const M1 = ["flon", "vigie", "montelly", "provence", "malley", "bourdonnette", "chamberonne", "mouline", "sorge", "epfl", "bassenges", "cerisaie", "crochy", "epenex", "renens"];
const mins = (n) => Array.from({ length: n }, (_, i) => i * 1.4);
const NET = core.buildNetwork([
  { id: "M1", dirs: [{ id: "renens", to: "renens", stops: M1, min: mins(15) }, { id: "flon", to: "flon", stops: M1.slice().reverse(), min: mins(15) }] },
  { id: "M2", dirs: [{ id: "croisettes", to: "croisettes", stops: M2, min: mins(14) }, { id: "ouchy", to: "ouchy", stops: M2.slice().reverse(), min: mins(14) }] },
]);
const ids = (ws) => ws.map((x) => x.dir.id).sort().join(",");
assert(ids(core.directionsAt(NET, "M2", "riponne")) === "croisettes,ouchy", "sens : deux sens à Riponne sur le M2");
assert(ids(core.directionsAt(NET, "M2", "croisettes")) === "ouchy", "sens : au terminus, seulement le retour");
assert(core.directionsAt(NET, "M1", "riponne").length === 0, "sens : arrêt hors de la ligne");
let rd = core.resolveDirection(NET, ["M1", "M2"], "flon", "ouchy", null);
assert(rd && rd.line === "M2" && rd.dir === "ouchy" && rd.seq === 8, "« Flon direction Ouchy » → M2 vers Ouchy");
rd = core.resolveDirection(NET, ["M1", "M2"], "epfl", "renens", null);
assert(rd && rd.line === "M1" && rd.dir === "renens", "« EPFL direction Renens » → M1 vers Renens");
assert(core.resolveDirection(NET, ["M2"], "riponne", "riponne", null) === null, "direction = arrêt lui-même : rien");
assert(core.resolveDirection(NET, ["M2"], "riponne", "malley", null) === null, "direction hors ligne : rien");

const close = (x, y) => Math.abs(x - y) < 1e-9;
const prior = core.learnRates([]);
assert(close(prior.net.rate, 1 / 3), "vitesse a priori : 1 arrêt / 3 min");
const learned = core.learnRates([{ line: "M1", direction: "renens", paires: 20, arrets: 30, minutes: 60 }]);
assert(close(learned.net.rate, 40 / 90), "vitesse du réseau : a priori + données");
assert(close(learned.lines.get("M1").rate, (30 * 40 / 90 + 30) / 90), "vitesse du M1 : rapprochée de celle du réseau");
assert(close(core.rateFor(learned, "M2"), 40 / 90), "ligne sans données : vitesse du réseau");
assert(core.paceText(1 / 3) === "environ 1 arrêt toutes les 3 min" && core.paceText(1 / 2.3) === "environ 1 arrêt toutes les 2,5 min"
  && core.paceText(1) === "environ 1 arrêt par minute", "texte de la vitesse");

const C1 = { kind: "controle", stopId: "riponne", line: "M2", dir: "croisettes", src: "app", by: "u1", at: now - 6 * min, id: "r1" };
const pr = core.project([C1], NET, prior, now);
const w6 = 0.6 * Math.pow(0.5, 6 / 20), pois = (k, mu) => Math.exp(-mu) * Math.pow(mu, k) / [1, 1, 2, 6, 24][k];
const at = (res, id) => (res.stops.find((s) => s.stopId === id) || { p: 0 }).p;
assert(close(at(pr, "bessieres"), w6 * pois(1, 2) * 0.85), "estimation : arrêt suivant = poids × Poisson × 0,85");
assert(close(at(pr, "chuv"), w6 * pois(3, 2) * Math.pow(0.85, 3)), "estimation : 3 arrêts plus loin");
assert(at(pr, "fourmi") === 0 && at(pr, "flon") === 0, "estimation : rien au-delà du seuil ni dans l'autre sens");
assert(pr.stops.map((s) => s.stopId).join(",") === "bessieres,ours,chuv,sallaz", "estimation : du plus probable au moins probable");
assert(pr.trails.length === 1 && pr.trails[0].stops.join(",") === "riponne,bessieres,ours,chuv,sallaz", "estimation : trajet depuis Riponne");
assert(pr.trails[0].peak === 1 && pr.trails[0].zone.join("-") === "1-2", "estimation : zone probable Bessières – Ours");
assert(close(pr.stops[0].rel, 1) && close(pr.stops[1].rel, 0.85), "estimation : probabilité relative au maximum du trajet");
const both = core.project([Object.assign({}, C1, { dir: null })], NET, prior, now);
assert(close(at(both, "bessieres"), at(pr, "bessieres") / 2) && close(at(both, "flon"), at(pr, "bessieres") / 2), "sens inconnu : moitié de chaque côté");
const cleared = core.project([C1, { kind: "fin", of: "controle", stopId: "ours", src: "app", by: "u2", at: now - min }], NET, prior, now);
assert(close(cleared.trails[0].p[2], pr.trails[0].p[2] * 0.25), "« plus là » à un arrêt estimé : présence divisée par 4");
assert(core.project([Object.assign({}, C1, { at: now - 50 * min })], NET, prior, now).stops.length === 0, "estimation : rien après 45 min");
assert(core.project([Object.assign({}, C1, { line: null })], NET, prior, now).stops.length === 0, "estimation : rien sans ligne");
const fast = core.project([C1], NET, { net: { rate: 1 }, lines: new Map() }, now);
assert(fast.stops.some((s) => s.stopId === "sallaz") && at(fast, "sallaz") > at(fast, "bessieres"), "vitesse apprise plus rapide : plus loin");
const two = core.project([C1, Object.assign({}, C1, { by: "u3", id: "r2" })], NET, prior, now);
assert(close(at(two, "bessieres"), 1 - Math.pow(1 - at(pr, "bessieres"), 2)), "deux personnes : 1 − Π(1 − p)");
const same = core.project([C1, Object.assign({}, C1, { at: now - 7 * min, id: "r0" })], NET, prior, now);
assert(close(at(same, "bessieres"), at(pr, "bessieres")), "même personne deux fois : une seule voix");
console.log(bad ? `${bad} échec(s)` : "tous les tests passent");
process.exit(bad ? 1 : 0);
