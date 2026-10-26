/*
 * Vigie — moteur commun (navigateur + Node).
 * 1) parseMessage : transforme un message Telegram libre en signalement structuré
 * 2) computeClusters : regroupe les signalements par arrêt et calcule l'indice de confiance
 *
 * 3) réseau : sens possibles d'une ligne à un arrêt, sens déduit de « direction X »
 * 4) project : position probable des contrôleurs depuis leur dernier signalement
 *
 * Indice de confiance (par arrêt et par type) :
 *   poids d'un signalement   w = base(source) × 0.5^(âge / demi-vie)
 *   un "plus là" postérieur  w ← w × (1 − poids_du_démenti)
 *   confiance de la zone     C = 1 − Π(1 − w)          (plusieurs signalements → C monte)
 *
 * Position estimée (contrôles signalés avec une ligne, voir project) :
 *   arrêts parcourus en a minutes   k ~ Poisson(λ × a)   λ = arrêts par minute sur la ligne (appris)
 *   restés sur la ligne et le sens   × keep^k            (sinon : autre ligne, demi-tour, fin du contrôle)
 *   présence à k arrêts plus loin    p = w × P(k) × keep^k
 */
(function (root) {
  "use strict";

  const CFG = {
    controle: { half: 20, maxAge: 120 },      // minutes
    perturbation: { half: 45, maxAge: 240 },
    base: { app: 0.6, telegram: 0.45, demo: 0.45 },
    clear: { app: 0.75, telegram: 0.65, demo: 0.65 },
    minShow: 0.08,
    levels: [[0.65, "forte"], [0.35, "moyenne"], [0, "faible"]],
    move: {
      pace: 3,        // min par arrêt avant tout apprentissage (hypothèse de départ)
      prior: 30,      // poids de cette hypothèse, en minutes d'observation : les données la remplacent peu à peu
      keep: 0.85,     // à chaque arrêt, probabilité qu'ils restent sur la même ligne et dans le même sens
      horizon: 45,    // min : au-delà, plus d'estimation
      ahead: 12,      // arrêts au plus
      minShow: 0.02,  // présence estimée minimale pour prolonger le trajet jusqu'à un arrêt
      minPace: 1, maxPace: 15,   // bornes de la vitesse apprise (min par arrêt)
    },
  };

  // ---------- normalisation ----------
  const FILLER = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "en", "sur", "et", "un", "une", "y"]);

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[’'`´]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  function tokens(s, keepFiller) {
    const t = normalize(s).split(" ").filter(Boolean);
    return keepFiller ? t : t.filter((w) => !FILLER.has(w));
  }

  // ---------- répertoire d'arrêts ----------
  function buildGazetteer(stops) {
    const exact = new Map();   // "tok tok" -> stopId
    const single = [];          // alias à un seul mot, pour le flou
    const byId = new Map();
    let maxLen = 1;
    for (const s of stops) {
      byId.set(s.id, s);
      // nom court partagé par plusieurs arrêts (« Gare », « Centre ») : jamais seul, seulement avec la commune
      const names = [s.name, s.amb ? null : s.short].concat(s.alias || []).filter(Boolean);
      for (const n of names) {
        const t = tokens(n);
        if (!t.length) continue;
        const key = t.join(" ");
        if (!exact.has(key)) exact.set(key, s.id);
        maxLen = Math.max(maxLen, t.length);
        if (t.length === 1 && t[0].length >= 5) single.push([t[0], s.id]);
      }
    }
    return { exact, single, byId, maxLen: Math.min(maxLen, 5) };
  }

  // mots courants qui ne doivent jamais être pris pour un arrêt mal orthographié
  const NOT_STOPS = new Set(("controle controles controleur controleurs control controleuse direction ligne lignes arret arrets " +
    "devant apres avant entre metro metros bus quai quais sortie entree partis parti partie descendus descendu montes monte " +
    "attention plusieurs beaucoup maintenant toujours encore civil civils uniforme uniformes bleus agents agent gilets " +
    "minutes minute heure heures personne personnes ticket tickets billet billets check verification retard retards panne " +
    "pannes deviation devie bloque bloquee accident travaux manif bonde plein vers dans pour avec sans sont etait cette").split(" "));

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = cur[0];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  const DIR_WORDS = new Set(["direction", "dir", "direc", "vers", "destination", "sens"]);

  function findStops(tok, gaz) {
    const hits = [];
    const used = new Array(tok.length).fill(false);
    for (let n = gaz.maxLen; n >= 1; n--) {
      for (let i = 0; i + n <= tok.length; i++) {
        if (used.slice(i, i + n).some(Boolean)) continue;
        const id = gaz.exact.get(tok.slice(i, i + n).join(" "));
        if (id) { hits.push({ id, i, n, fuzzy: false }); for (let k = i; k < i + n; k++) used[k] = true; }
      }
    }
    for (let i = 0; i < tok.length; i++) {
      const w = tok[i];
      if (used[i] || w.length < 5 || NOT_STOPS.has(w) || /\d/.test(w)) continue;
      const max = w.length >= 8 ? 2 : 1;
      let best = null;
      for (const [alias, id] of gaz.single) {
        const d = lev(w, alias, max);
        if (d <= max && (!best || d < best.d)) best = { id, d };
      }
      if (best) { hits.push({ id: best.id, i, n: 1, fuzzy: true }); used[i] = true; }
    }
    hits.sort((a, b) => a.i - b.i);
    for (const h of hits) {
      const prev = tok[h.i - 1];
      h.isDirection = !!prev && DIR_WORDS.has(prev);
    }
    return hits;
  }

  // ---------- lignes ----------
  const COUNT_WORDS = "controleurs?|controleuses?|agents?|mecs?|gars|types?|personnes?|bleus?|schtroumpfs?|minutes?|min|mn|fois|chf|francs?|ans|avril";
  function findLine(norm) {
    let m = norm.match(/\b(?:m|metro)\s?([123])\b/);
    if (m) return "M" + m[1];
    const re = new RegExp("\\b(?:ligne|lignes|bus|trolley|trolleybus|l|n|no|num|numero|le|du|dans le)\\s?(\\d{1,2})\\b(?!\\s(?:" + COUNT_WORDS + ")\\b)");
    m = norm.match(re);
    if (m && +m[1] > 0) return String(+m[1]);
    m = norm.match(new RegExp("(?:^|\\s)(\\d{1,2})\\s(?:direction|dir|vers)\\b"));
    if (m && +m[1] > 0) return String(+m[1]);
    return null;
  }

  // ---------- type de message ----------
  const RE_QUESTION = /\b(qqn|quelqu un|quelquun|y a t il|y a t|ya t il|est ce qu|savez|sait on|des nouvelles|vous avez vu|dispo)\b/;
  const RE_CLEAR = /\b(partis?|parties|descendus?|descendues?|sortis?|disparus?|plus de contr\w*|plus personne|plus rien|plus la|ras|rien a signaler|fausse alerte|c est bon|cest bon|termine|fini|ils sont plus|y a plus|y en a plus|ya plus)\b/;
  const RE_RESTORED = /\b(retabli\w*|reprise|circule a nouveau|circulent a nouveau|resolu\w*|repart\w*)\b/;
  const RE_PERT = [
    ["panne", /\b(panne\w*|en rade|hs|hors service)\b/],
    ["accident", /\b(accident\w*|collision)\b/],
    ["deviation", /\b(devi\w*|detour\w*|ne dessert pas|non desservi\w*|travaux)\b/],
    ["retard", /\b(retard\w*|bouchon\w*|bloque\w*|interromp\w*|supprime\w*|annule\w*|ne passe pas|ne circule)\b/],
    ["bonde", /\b(bonde\w*|plein a craquer|blinde\w*)\b/],
    ["autre", /\b(perturb\w*|incident\w*|manif\w*)\b/],
  ];

  function parseMessage(text, gaz) {
    const raw = String(text || "");
    const prepared = raw
      .replace(/\b\d{1,2}\s?[:h]\s?\d{2}\b/gi, " ")   // heures 10h30 / 10:30
      .replace(/->|→|=>|>/g, " direction ");
    const norm = normalize(prepared);
    const tok = tokens(prepared);
    const hits = findStops(tok, gaz);
    const loc = hits.find((h) => !h.isDirection) || null;
    const dir = hits.find((h) => h.isDirection) || null;
    const line = findLine(norm);

    let kind = "controle", sub = null, of = null;
    const endsWithQ = /\?[\s\W]*$/u.test(raw.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ""));
    const isQuestion = endsWithQ || (/\?/.test(raw) && RE_QUESTION.test(norm));
    if (isQuestion) kind = "question";
    else if (RE_RESTORED.test(norm)) { kind = "fin"; of = "perturbation"; }
    else if (RE_CLEAR.test(norm)) { kind = "fin"; of = "controle"; }
    else {
      for (const [k, re] of RE_PERT) if (re.test(norm)) { kind = "perturbation"; sub = k; break; }
    }
    const stopId = loc ? loc.id : null;
    return {
      kind, sub, of,
      stopId,
      dirStopId: dir ? dir.id : null,
      line,
      fuzzy: !!(loc && loc.fuzzy),
      usable: kind !== "question" && !!stopId,
    };
  }

  // ---------- indice de confiance ----------
  function levelOf(c) {
    for (const [min, name] of CFG.levels) if (c >= min) return name;
    return "faible";
  }

  function computeClusters(reports, now, cfg) {
    cfg = cfg || CFG;
    const groups = new Map(), clears = new Map();
    for (const r of reports) {
      if (!r || !r.stopId || !r.at) continue;
      const age = (now - r.at) / 60000;
      if (age < -5) continue;
      if (r.kind === "fin") {
        const of = r.of || "controle";
        if (age <= cfg[of].maxAge) {
          const k = of + ":" + r.stopId;
          if (!clears.has(k)) clears.set(k, []);
          clears.get(k).push(r);
        }
        continue;
      }
      const k = cfg[r.kind];
      if (!k || age > k.maxAge) continue;
      const key = r.kind + ":" + r.stopId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [];
    for (const [key, rs] of groups) {
      const kind = rs[0].kind, k = cfg[kind];
      const cl = clears.get(key) || [];
      // une personne = une voix : on garde son signalement le plus récent
      const latest = new Map();
      for (const r of rs) {
        const who = r.by ? r.src + ":" + r.by : "id:" + (r.id || Math.random());
        const p = latest.get(who);
        if (!p || r.at > p.at) latest.set(who, r);
      }
      let notC = 1, lastAt = 0;
      const lines = new Set(), subs = new Set(), src = { app: 0, telegram: 0, demo: 0 };
      const used = [];
      for (const r of latest.values()) {
        const age = Math.max(0, (now - r.at) / 60000);
        let w = (cfg.base[r.src] != null ? cfg.base[r.src] : 0.5) * Math.pow(0.5, age / k.half);
        for (const c of cl) if (c.at > r.at) w *= 1 - (cfg.clear[c.src] != null ? cfg.clear[c.src] : 0.5);
        notC *= 1 - w;
        lastAt = Math.max(lastAt, r.at);
        if (r.line) lines.add(r.line);
        if (r.sub) subs.add(r.sub);
        src[r.src] = (src[r.src] || 0) + 1;
        used.push({ at: r.at, src: r.src, line: r.line || null, dir: r.dir || null, w });
      }
      const c = 1 - notC;
      if (c < cfg.minShow) continue;
      used.sort((a, b) => b.at - a.at);
      const lastClear = cl.reduce((m, x) => Math.max(m, x.at), 0);
      out.push({
        key, kind, stopId: rs[0].stopId, confidence: c, level: levelOf(c),
        count: latest.size, lastAt, lines: [...lines], subs: [...subs], src,
        reports: used, clearedAfterLast: lastClear > lastAt, lastClear,
      });
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  // ---------- réseau : lignes, sens et ordre des arrêts ----------
  // lines : [{ id, dirs: [{ id, to, label, stops: [id…], min: [minutes cumulées…] }] }]
  function buildNetwork(lines) {
    const byLine = new Map();
    for (const l of lines || []) {
      const dirs = (l.dirs || []).map((d) => {
        const at = new Map();
        d.stops.forEach((s, i) => { if (!at.has(s)) at.set(s, i); });
        return Object.assign({}, d, { at, to: d.to || d.stops[d.stops.length - 1] });
      });
      byLine.set(l.id, Object.assign({}, l, { dirs }));
    }
    return { byLine };
  }

  // sens où l'on peut partir de cet arrêt sur cette ligne : { dir, seq (rang de l'arrêt), share (part des courses) }.
  // Pas le sens dont l'arrêt est le terminus (même s'il y passe avant, boucle finale) ; deux branches vers le même
  // terminus qui passent toutes deux ici : un seul choix, la plus fréquente (les données sont triées ainsi).
  function directionsAt(net, line, stopId) {
    const l = net && net.byLine.get(line);
    if (!l) return [];
    const out = [], byTo = new Map();
    for (const d of l.dirs) {
      const i = d.at.get(stopId);
      if (i == null || i >= d.stops.length - 1 || d.to === stopId) continue;
      const share = d.share > 0 ? d.share : 1;
      if (byTo.has(d.to)) { byTo.get(d.to).share += share; continue; }
      const way = { dir: d, seq: i, share };
      byTo.set(d.to, way); out.push(way);
    }
    return out;
  }

  function dirById(net, line, dirId) {
    const l = net && net.byLine.get(line);
    return (l && l.dirs.find((d) => d.id === dirId)) || null;
  }

  // « … direction X » : sens (et ligne, si elle manque) où X vient après l'arrêt. Null si ambigu.
  function resolveDirection(net, stopLines, stopId, dirStopId, line) {
    if (!net || !stopId || !dirStopId || stopId === dirStopId) return null;
    const found = [];
    for (const l of line ? [line] : (stopLines || [])) {
      for (const { dir, seq } of directionsAt(net, l, stopId)) {
        if (dir.stops.indexOf(dirStopId, seq + 1) !== -1) found.push({ line: l, dir: dir.id, seq });
      }
    }
    const lines = new Set(found.map((f) => f.line));
    if (lines.size !== 1) return null;
    const dirs = new Set(found.map((f) => f.dir));
    return dirs.size === 1 ? found[0] : { line: found[0].line, dir: null, seq: null };
  }

  // ---------- vitesse des contrôleurs, apprise ----------
  // rows : tendances calculées par la base, [{ line, direction, paires, arrets, minutes }]
  // Vitesse en arrêts par minute, a priori 1 arrêt / pace min, puis :
  //   réseau  λ = (prior/pace + Σarrêts) / (prior + Σminutes)
  //   ligne   λL = (prior × λ + arrêtsL) / (prior + minutesL)     (peu de données → proche du réseau)
  function learnRates(rows, cfg) {
    const m = (cfg || CFG).move;
    const clamp = (r) => Math.min(1 / m.minPace, Math.max(1 / m.maxPace, r));
    const per = new Map();
    let K = 0, T = 0, P = 0;
    for (const r of rows || []) {
      const k = +r.arrets, t = +r.minutes, p = +r.paires;
      if (!r.line || !(t > 0) || !(k >= 0) || !(p > 0)) continue;
      const x = per.get(r.line) || { k: 0, t: 0, p: 0 };
      x.k += k; x.t += t; x.p += p; per.set(r.line, x);
      K += k; T += t; P += p;
    }
    const net = clamp((m.prior / m.pace + K) / (m.prior + T));
    const lines = new Map();
    for (const [line, x] of per) lines.set(line, { rate: clamp((m.prior * net + x.k) / (m.prior + x.t)), pairs: x.p, minutes: x.t });
    return { net: { rate: net, pairs: P, minutes: T }, lines };
  }
  function rateFor(rates, line, cfg) {
    const m = (cfg || CFG).move;
    const l = rates && rates.lines && rates.lines.get(line);
    return l ? l.rate : rates && rates.net ? rates.net.rate : 1 / m.pace;
  }

  // ---------- position estimée des contrôleurs ----------
  // Pour chaque signalement de contrôle avec ligne : présence probable aux arrêts suivants (voir en-tête).
  // Renvoie
  //   trails : un trajet par signalement et par sens, { line, dir, from, at, stops: [départ, …], p: [poids, p1, p2…],
  //            peak : rang le plus probable, zone : [début, fin] des arrêts à au moins la moitié du maximum }
  //   stops  : arrêts estimés, { stopId, p (1 − Π(1 − p) sur tous les trajets), rel (p / maximum de son trajet),
  //            line, dir, dirGiven (sens signalé ou supposé), from, at, k, rate }
  function project(reports, net, rates, now, cfg) {
    cfg = cfg || CFG;
    const m = cfg.move;
    const clears = new Map();
    for (const r of reports) {
      // comme computeClusters : un « plus là » daté de plus de 5 min dans le futur (horloge fausse) est ignoré
      if (r && r.kind === "fin" && (r.of || "controle") === "controle" && r.stopId && (now - r.at) / 60000 >= -5) {
        if (!clears.has(r.stopId)) clears.set(r.stopId, []);
        clears.get(r.stopId).push(r);
      }
    }
    // une personne = une voix par arrêt : son signalement le plus récent
    const latest = new Map();
    for (const r of reports) {
      if (!r || r.kind !== "controle" || !r.line || !r.stopId || !r.at) continue;
      const who = (r.by ? r.src + ":" + r.by : "id:" + (r.id || Math.random())) + "@" + r.stopId;
      const p = latest.get(who);
      if (!p || r.at > p.at) latest.set(who, r);
    }
    const acc = new Map(), trails = [];
    for (const r of latest.values()) {
      const age = Math.max(0, (now - r.at) / 60000);
      if (age > m.horizon || (now - r.at) / 60000 < -5) continue;
      // « plus là » à l'arrêt du signalement : ils en sont partis, l'estimation plus loin reste valable
      const w = (cfg.base[r.src] != null ? cfg.base[r.src] : 0.5) * Math.pow(0.5, age / cfg.controle.half);
      let ways = [];
      const given = r.dir && dirById(net, r.line, r.dir);
      const dirGiven = !!(given && given.at.has(r.stopId) && given.at.get(r.stopId) < given.stops.length - 1);
      if (dirGiven) ways = [{ dir: given, seq: given.at.get(r.stopId), share: 1, part: 1 }];
      else {
        // sens inconnu : moitié pour chaque sens de circulation, puis selon la part des courses de chaque branche
        ways = directionsAt(net, r.line, r.stopId);
        const groups = new Map();
        for (const x of ways) groups.set(x.dir.grp, (groups.get(x.dir.grp) || 0) + x.share);
        for (const x of ways) x.part = (1 / groups.size) * (x.share / groups.get(x.dir.grp));
      }
      if (!ways.length) continue;
      const rate = rateFor(rates, r.line, cfg), mu = rate * age;
      for (const { dir, seq, part } of ways) {
        const share = w * part;
        const trail = { line: r.line, dir: dir.id, dirGiven, from: r.stopId, at: r.at, stops: [r.stopId], p: [share] };
        let pk = Math.exp(-mu);                        // P(k = 0)
        for (let k = 1; k <= m.ahead && seq + k < dir.stops.length; k++) {
          pk *= mu / k;                                 // P(k) = e^−μ μ^k / k!
          let p = dir.stops[seq + k] === r.stopId ? 0 : share * pk * Math.pow(m.keep, k);   // boucle : pas l'arrêt de départ
          for (const c of clears.get(dir.stops[seq + k]) || []) if (c.at > r.at) p *= 1 - (cfg.clear[c.src] != null ? cfg.clear[c.src] : 0.5);
          trail.stops.push(dir.stops[seq + k]); trail.p.push(p);
        }
        // trajet affiché jusqu'au dernier arrêt encore assez probable
        let last = 0, peak = 0;
        trail.p.forEach((p, i) => { if (i && p >= m.minShow) last = i; if (i && (!peak || p > trail.p[peak])) peak = i; });
        if (!last) continue;
        trail.stops = trail.stops.slice(0, last + 1); trail.p = trail.p.slice(0, last + 1);
        let a = peak, b = peak;
        while (a > 1 && trail.p[a - 1] >= trail.p[peak] / 2) a--;
        while (b < last && trail.p[b + 1] >= trail.p[peak] / 2) b++;
        Object.assign(trail, { peak, zone: [a, b], rate });
        const ti = trails.push(trail) - 1;
        for (let k = 1; k <= last; k++) {
          const stopId = trail.stops[k], p = trail.p[k];
          const s = acc.get(stopId) || { notP: 1, best: null };
          s.notP *= 1 - p;
          if (!s.best || p > s.best.p) s.best = { p, rel: p / trail.p[peak], line: r.line, dir: dir.id, dirGiven, from: r.stopId, at: r.at, k, rate, trail: ti };
          acc.set(stopId, s);
        }
      }
    }
    const stops = [];
    for (const [stopId, s] of acc) {
      const p = 1 - s.notP;
      if (p >= m.minShow) stops.push(Object.assign({ stopId }, s.best, { p }));
    }
    stops.sort((x, y) => y.p - x.p);
    return { stops, trails };
  }

  // « 1 arrêt toutes les 3 min »
  function paceText(rate) {
    const pace = 1 / rate;
    if (pace < 1.25) return "environ 1 arrêt par minute";
    const v = pace < 10 ? Math.round(pace * 2) / 2 : Math.round(pace);
    return "environ 1 arrêt toutes les " + String(v).replace(".", ",") + " min";
  }

  // ---------- rendu ----------
  const RAMP = [[0, [242, 193, 78]], [0.5, [238, 123, 48]], [1, [215, 38, 61]]];
  function colorFor(c) {
    c = Math.max(0, Math.min(1, c));
    for (let i = 1; i < RAMP.length; i++) {
      const [x1, c1] = RAMP[i], [x0, c0] = RAMP[i - 1];
      if (c <= x1) {
        const t = (c - x0) / (x1 - x0);
        const v = c0.map((a, j) => Math.round(a + (c1[j] - a) * t));
        return "rgb(" + v.join(",") + ")";
      }
    }
    return "rgb(215,38,61)";
  }
  function radiusFor(c) { return Math.round(9 + 15 * Math.max(0, Math.min(1, c))); }

  const api = { CFG, normalize, tokens, buildGazetteer, parseMessage, findLine, computeClusters, levelOf, colorFor, radiusFor,
    buildNetwork, directionsAt, dirById, resolveDirection, learnRates, rateFor, project, paceText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VigieCore = api;
})(typeof self !== "undefined" ? self : this);
