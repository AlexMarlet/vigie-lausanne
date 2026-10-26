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
// même déduction que le collecteur Python, sur le vrai réseau (collector/lignes.json)
const REAL = core.buildNetwork(require("../collector/lignes.json"));
const byStop = new Map(STOPS.map((s) => [s.id, s]));
for (const [text, line, dir] of [["🚨 Contrôleurs au Flon direction Ouchy", "M2", "ouchy"],
  ["Contrôle en civil EPFL quai direction Renens 10h45", "M1", "renens"], ["Contrôle M1 UNIL Sorge → EPFL", "M1", "renens"]]) {
  const p = core.parseMessage(text, gaz);
  const w = core.resolveDirection(REAL, byStop.get(p.stopId).lines, p.stopId, p.dirStopId, p.line);
  assert(w && w.line === line && w.dir === dir, "sens déduit : " + text);
}

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

// cas relevés en relecture
const leftOrigin = core.project([C1, { kind: "fin", of: "controle", stopId: "riponne", src: "app", by: "u2", at: now - min }], NET, prior, now);
assert(close(at(leftOrigin, "bessieres"), at(pr, "bessieres")), "« plus là » à l'arrêt de départ : l'estimation plus loin ne change pas");
const future = core.project([C1, { kind: "fin", of: "controle", stopId: "ours", src: "app", by: "u2", at: now + 60 * min }], NET, prior, now);
assert(close(future.trails[0].p[2], pr.trails[0].p[2]), "« plus là » daté dans le futur (horloge fausse) : ignoré");
const NET2 = core.buildNetwork([
  { id: "32", dirs: [
    { id: "z", to: "z", grp: "0", share: 0.63, stops: ["a", "b", "x", "y", "z"] },
    { id: "z-2", to: "z", grp: "0", share: 0.37, stops: ["q", "x", "y", "z"] },
    { id: "a", to: "a", grp: "1", share: 1, stops: ["z", "y", "x", "b", "a"] }] },
  { id: "19", dirs: [
    { id: "c", to: "c", grp: "0", share: 1, stops: ["m", "c", "n", "o", "c"] },
    { id: "m", to: "m", grp: "1", share: 1, stops: ["c", "o", "n", "m"] },
    { id: "d", to: "d", grp: "2", share: 1, stops: ["c", "b", "c", "d"] }] },
]);
assert(ids(core.directionsAt(NET2, "32", "x")) === "a,z", "deux branches vers le même terminus : un seul choix sur le tronc commun");
assert(ids(core.directionsAt(NET2, "32", "q")) === "z-2", "arrêt d'une seule branche : son sens");
assert(ids(core.directionsAt(NET2, "19", "c")) === "d,m", "boucle finale : pas « → C » à l'arrêt C");
const C2 = { kind: "controle", stopId: "x", line: "32", src: "app", by: "u9", at: now - 6 * min, id: "r9" };
const sp = core.project([C2], NET2, prior, now);
assert(close(at(sp, "y"), at(sp, "b")), "sens inconnu : moitié par sens de circulation, quelles que soient les branches");
const rd2 = core.resolveDirection(NET2, ["19"], "b", "c", null);
assert(rd2 && rd2.dir === "d", "direction X qui repasse plus loin : trouvée");

// ---- sens signalé, confirmations et déplacements (groupes de sens comme dans les vraies données)
const NET3 = core.buildNetwork([{ id: "M2", dirs: [
  { id: "croisettes", to: "croisettes", grp: "0", share: 1, stops: M2 },
  { id: "ouchy", to: "ouchy", grp: "1", share: 1, stops: M2.slice().reverse() }] }]);
const K = (o) => Object.assign({ kind: "controle", line: "M2", src: "app" }, o);
const fresh = core.project([K({ stopId: "riponne", dir: "croisettes", by: "u1", at: now - 2 * min, id: "f1" })], NET3, prior, now);
const w2 = 0.6 * Math.pow(0.5, 2 / 20), mu2 = 2 / 3, p1 = mu2 * Math.exp(-mu2);
assert(close(at(fresh, "bessieres"), w2 * 0.85 * p1 * 0.85), "sens signalé : 85 % de l'estimation dans ce sens");
assert(close(at(fresh, "flon"), w2 * 0.15 * p1 * 0.85), "sens signalé : 15 % dans l'autre sens (demi-tour)");
const flon = fresh.stops.find((x) => x.stopId === "flon"), bes = fresh.stops.find((x) => x.stopId === "bessieres");
assert(flon.rel < 0.5 && !flon.main && bes.main && close(bes.rel, 1), "l'autre sens reste pâle : pas d'anneau");

const r1 = K({ stopId: "riponne", dir: "croisettes", by: "u1", at: now - 10 * min, id: "m1" });
const r2 = K({ stopId: "chuv", by: "u2", at: now - 3 * min, id: "m2" });
const links = core.linkMovements([r1, r2], NET3, now);
const dirsOf = (c) => (c || []).map((x) => x.dir.id).sort().join(",");
assert(links.moved.get(r1) && links.moved.get(r1).next === r2 && dirsOf(links.confirmed.get(r2)) === "croisettes",
  "revus 3 arrêts plus loin 7 min après : déplacement, sens confirmé pour le nouveau signalement");
const conf = core.project([r1, r2], NET3, prior, now);
assert(conf.trails.length === 1 && conf.trails[0].from === "chuv" && conf.trails[0].dir === "croisettes",
  "estimation : seulement depuis le dernier signalement, dans le sens confirmé");
assert(at(conf, "fourmi") > 0 && at(conf, "ours") === 0, "sens confirmé : plus rien dans l'autre sens");
const before = core.computeClusters([r1], now).find((c) => c.stopId === "riponne").confidence;
const afterCl = core.computeClusters([r1, r2], now, undefined, links).find((c) => c.stopId === "riponne");
assert(close(afterCl.confidence, before * 0.25) && afterCl.movedTo === "chuv", "point d'origine réduit : ils sont partis plus loin");
const noDir = Object.assign({}, r1, { dir: null, id: "m3" });
const l2 = core.linkMovements([noDir, r2], NET3, now);
assert(l2.moved.has(noDir) && dirsOf(l2.confirmed.get(r2)) === "croisettes", "origine sans sens : le sens vient du déplacement");
const tooFast = K({ stopId: "sallaz", by: "u3", at: r1.at + min, id: "m4" });
assert(!core.linkMovements([r1, tooFast], NET3, now).moved.size, "4 arrêts en 1 min : pas un déplacement");
const otherWay = K({ stopId: "chuv", dir: "ouchy", by: "u4", at: now - 3 * min, id: "m5" });
assert(!core.linkMovements([r1, otherWay], NET3, now).moved.size, "signalé dans l'autre sens : pas un déplacement");
const behind = K({ stopId: "flon", by: "u5", at: now - 3 * min, id: "m6" });
assert(!core.linkMovements([r1, behind], NET3, now).moved.size, "revus en arrière : pas un déplacement");
const later = K({ stopId: "chuv", by: "u6", at: r1.at + 50 * min, id: "m7" });
assert(!core.linkMovements([r1, later], NET3, now + 60 * min).moved.size, "50 min plus tard : trop tard pour relier");
const back = K({ stopId: "riponne", by: "u7", at: now - 1 * min, id: "m8" });
const l3 = core.linkMovements([r1, r2, back], NET3, now);
const backCl = core.computeClusters([r1, r2, back], now, undefined, l3).find((c) => c.stopId === "riponne");
assert(!l3.moved.has(back) && backCl.movedTo === null && backCl.confidence > afterCl.confidence,
  "revus ici après le déplacement : nouveau signalement à plein poids, pas de « partis d'ici »");

// cas relevés en relecture (2)
// sens déjà confirmé : un signalement suivant en arrière ne le renverse pas
const r3 = K({ stopId: "bessieres", by: "u8", at: now - 1 * min, id: "m9" });
const l4 = core.linkMovements([r1, r2, r3], NET3, now);
assert(l4.moved.has(r1) && !l4.moved.has(r2) && !l4.confirmed.has(r3), "sens confirmé : revus en arrière ensuite, pas un déplacement");
const p4 = core.project([r1, r2, r3], NET3, prior, now, undefined, l4);
assert(p4.trails.some((t) => t.from === "chuv" && t.dir === "croisettes" && t.confirmed), "le signalement confirmé garde son sens");
// tronc commun à deux branches (même groupe de sens) : la confirmation garde les deux, selon leur part des courses
const NET4 = core.buildNetwork([{ id: "47", dirs: [
  { id: "p", to: "p", grp: "0", share: 0.5, stops: ["s", "t1", "t2", "t3", "p1", "p"] },
  { id: "l", to: "l", grp: "0", share: 0.5, stops: ["s", "t1", "t2", "t3", "l1", "l"] },
  { id: "s", to: "s", grp: "1", share: 1, stops: ["p", "p1", "t3", "t2", "t1", "s"] }] }]);
const T = (o) => Object.assign({ kind: "controle", line: "47", src: "app" }, o);
const ta = T({ stopId: "t1", by: "v1", at: now - 8 * min, id: "t-a" }), tb = T({ stopId: "t2", by: "v2", at: now - 2 * min, id: "t-b" });
const l5 = core.linkMovements([ta, tb], NET4, now);
assert(dirsOf(l5.confirmed.get(tb)) === "l,p", "tronc commun : les deux branches restent possibles");
const p5 = core.project([ta, tb], NET4, { net: { rate: 1 }, lines: new Map() }, now, undefined, l5);
assert(at(p5, "p1") > 0 && close(at(p5, "p1"), at(p5, "l1")), "tronc commun : chaque branche selon sa part des courses (50/50)");
assert(at(p5, "t1") === 0, "tronc commun : rien en arrière");
// boucle : l'estimation part de la position de l'arrêt dans le parcours, pas de son premier passage
const NET5 = core.buildNetwork([{ id: "32", dirs: [
  { id: "en", to: "en", grp: "0", share: 1, stops: ["g", "rn", "ao", "rn", "v", "en"] },
  { id: "g", to: "g", grp: "1", share: 1, stops: ["en", "v", "rn", "g"] }] }]);
const B = (o) => Object.assign({ kind: "controle", line: "32", src: "app" }, o);
const la = B({ stopId: "ao", by: "w1", at: now - 6 * min, id: "b-a" }), lb = B({ stopId: "rn", by: "w2", at: now - 2 * min, id: "b-b" });
const l6 = core.linkMovements([la, lb], NET5, now);
assert(l6.moved.has(la) && l6.confirmed.get(lb)[0].seq === 3, "boucle : position de l'arrêt après le passage signalé");
const p6 = core.project([la, lb], NET5, prior, now, undefined, l6);
assert(at(p6, "v") > 0 && at(p6, "ao") === 0, "boucle : l'estimation continue (V), pas en arrière (1er-Août)");
// boucle parcourue dans les deux sens (Renens, 1er-Août, Renens) : le déplacement donne la position, pas le sens
const NET6 = core.buildNetwork([{ id: "32", dirs: [
  { id: "en", to: "en", grp: "0", share: 1, stops: ["g", "rn", "ao", "rn", "v", "en"] },
  { id: "g", to: "g", grp: "1", share: 1, stops: ["en", "v", "rn", "ao", "rn", "g"] }] }]);
const l8 = core.linkMovements([la, lb], NET6, now);
assert(l8.moved.has(la) && dirsOf(l8.confirmed.get(lb)) === "en,g", "boucle dans les deux sens : déplacement compatible avec les deux");
const p8 = core.project([la, lb], NET6, prior, now, undefined, l8);
assert(at(p8, "v") > 0 && at(p8, "g") > 0 && at(p8, "ao") === 0 && p8.trails.every((t) => !t.confirmed && !t.dirKnown),
  "boucle dans les deux sens : estimation des deux côtés, sens non confirmé");
// confirmation datée dans le futur (horloge du téléphone) : pas de lien tant qu'elle n'est pas arrivée
const fut = K({ stopId: "chuv", by: "u9", at: now + 3 * min, id: "m10" });
const l7 = core.linkMovements([r1, fut], NET3, now);
assert(!l7.moved.size && core.project([r1, fut], NET3, prior, now, undefined, l7).trails.some((t) => t.from === "riponne"),
  "confirmation datée dans le futur : l'estimation d'origine reste");
console.log(bad ? `${bad} échec(s)` : "tous les tests passent");
process.exit(bad ? 1 : 0);
