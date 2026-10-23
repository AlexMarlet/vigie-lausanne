/*
 * Vigie — moteur commun (navigateur + Node).
 * 1) parseMessage : transforme un message Telegram libre en signalement structuré
 * 2) computeClusters : regroupe les signalements par arrêt et calcule l'indice de confiance
 *
 * Indice de confiance (par arrêt et par type) :
 *   poids d'un signalement   w = base(source) × 0.5^(âge / demi-vie)
 *   un "plus là" postérieur  w ← w × (1 − poids_du_démenti)
 *   confiance de la zone     C = 1 − Π(1 − w)          (plusieurs signalements → C monte)
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
      const names = [s.name, s.short].concat(s.alias || []).filter(Boolean);
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
        used.push({ at: r.at, src: r.src, line: r.line || null, w });
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

  const api = { CFG, normalize, tokens, buildGazetteer, parseMessage, findLine, computeClusters, levelOf, colorFor, radiusFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VigieCore = api;
})(typeof self !== "undefined" ? self : this);
