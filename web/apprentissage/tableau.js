/*
 * Vigie — page privée « Apprentissage » (/apprentissage/).
 * Ce que le modèle apprend des signalements, en direct : statistiques de la fonction Supabase « stats »
 * (lecture seule, clé d'accès privée), recalculées à chaque nouveau signalement (temps réel de la table
 * signalements) et au moins toutes les 5 minutes. Le lien personnel …/apprentissage/#cle=… garde la clé sur
 * l'appareil (localStorage) et l'efface aussitôt de la barre d'adresse.
 * Mêmes calculs que le tableau publié dans Claude, et que le modèle : learnRates() (core/vigie-core.js),
 * vigie_private.apprendre() (supabase/schema.sql).
 */
(() => {
  "use strict";
  try {                                            // thème choisi dans l'app
    const t = JSON.parse(localStorage.getItem("vigie.theme"));
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* stockage indisponible : thème du système */ }

  const CONFIG = (() => { try { return JSON.parse(document.getElementById("vigie-config").textContent) || {}; } catch (e) { return {}; } })();
  const URL_STATS = CONFIG.supabaseUrl ? CONFIG.supabaseUrl.replace(/\/$/, "") + "/functions/v1/stats" : "";
  const STOCK = "vigie.tableau.cle";
  const PERIODE = 5 * 60000;

  // ------------------------------------------------------------------ mini moteur : données, calculs, dessins
  const dash = (() => {
    let raw = null, cache = {};
    const loaders = {}, calcs = {}, draws = {};
    const api = {
      colors: ["var(--s-telegram)", "var(--s-app)", "var(--s-partis)"],
      loader(id, o) { loaders[id] = o.fn; },
      calc(id, o) { calcs[id] = o; },
      draw(name, fn) { draws[name] = fn; },
      data(id) {
        if (!raw) return { status: "loading", data: null };
        if (id in cache) return cache[id];
        let out;
        try {
          if (loaders[id]) out = { status: "ok", data: loaders[id]({ answer: raw }) };
          else if (calcs[id]) {
            const ins = calcs[id].inputs.map((i) => api.data(i));
            const bad = ins.find((d) => d.status !== "ok");
            out = bad ? { status: bad.status, data: null } : { status: "ok", data: calcs[id].fn(...ins.map((d) => d.data)) };
          } else out = { status: "missing", data: null };
        } catch (e) {
          console.error("calcul " + id + " : " + e.message);
          out = { status: "error", data: null };
        }
        return (cache[id] = out);
      },
      has: () => raw != null,
      set(next) { raw = next; cache = {}; },
      render() {
        for (const [name, fn] of Object.entries(draws)) {
          document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => {
            try { fn(el); } catch (e) { console.error("dessin " + name + " : " + e.message); }
          });
        }
      },
    };
    return api;
  })();

  // ------------------------------------------------------------------ données brutes -> parties du tableau
  // (même transformation que pour le tableau publié dans Claude : noms d'arrêt de l'app, positions, rangs)
  function transformer(d, net) {
    const nom = (id) => (id && net.noms[id]) || id;
    const pos = (id) => net.pos[id] || null;
    const auRang = (ligne, sens, seq) => {
      const s = (net.sens[ligne] || {})[sens];
      return s && seq != null && seq >= 0 && seq < s.length ? nom(s[seq]) : null;
    };
    return {
      entrees: d.totaux.map((r) => ({ source: r.src, type: r.kind, fin_de: r.of_kind || null, n: r.n, premier: r.premier, dernier: r.dernier })),
      jours: (d.jours || []).map((r) => ({ jour: r.jour, source: r.src, type: r.kind, n: r.n })),
      telegram: d.telegram.map((r) => ({ heure: r.heure, type: r.kind, n: r.n })),
      arrets: d.arrets.map((r) => {
        const p = pos(r.stop_id);
        return { arret: r.stop_id, nom: nom(r.stop_id), lat: p ? p[0] : null, lon: p ? p[1] : null, source: r.src, type: r.kind,
          n: r.n, jours: r.jours, dernier: r.dernier };
      }),
      lignes: d.lignes.map((r) => ({ ligne: r.line || null, source: r.src, type: r.kind, n: r.n, avec_sens: r.avec_sens })),
      paires: d.paires.map((r) => ({ ligne: r.line, sens: nom(r.direction), de: auRang(r.line, r.direction, r.seq),
        a: auRang(r.line, r.direction, r.seq2), rang_de: r.seq, rang_a: r.seq2, le: r.at, arrets: r.k, minutes: r.dt })),
      tendances: d.tendances.map((r) => ({ ligne: r.line, sens: nom(r.direction), paires: r.paires, arrets: r.arrets,
        minutes: r.minutes, calcule_le: r.maj })),
      confirmations: d.confirmations.map((r) => ({ source: r.src, controles: r.n, confirment: r.confirment })),
      presence: d.presence.map((r) => ({ arret: r.stop_id, nom: nom(r.stop_id), source: r.src, le: r.at,
        depuis_premier: r.depuis_premier, depuis_dernier: r.depuis_dernier, signalements: r.n })),
      trace: net.trace,
      genere: d.genere,
    };
  }

  for (const key of ["entrees", "jours", "telegram", "arrets", "lignes", "paires", "tendances", "confirmations", "presence", "trace"]) {
    dash.loader(key, { fn: ({ answer }) => answer[key] || [] });
  }

  // ------------------------------------------------------------------ calculs
  const MODELE = { PRIOR: 30, PACE: 3, MIN_PACE: 1, MAX_PACE: 15 };   // core/vigie-core.js, CFG.move
  const borne = (r) => Math.min(1 / MODELE.MIN_PACE, Math.max(1 / MODELE.MAX_PACE, r));

  dash.calc("tg", {
    inputs: ["entrees"],
    fn: (entrees) => {
      const t = entrees.filter((r) => r.source === "telegram");
      const n = (type) => t.filter((r) => r.type === type).reduce((s, r) => s + r.n, 0);
      const premier = d3.min(t, (r) => r.premier), dernier = d3.max(t, (r) => r.dernier);
      return [{ messages: d3.sum(t, (r) => r.n), controles: n("controle"), partis: n("fin"), perturbations: n("perturbation"),
        premier, dernier, heures: premier ? Math.round((new Date(dernier) - new Date(premier)) / 3.6e6) : 0 }];
    },
  });

  dash.calc("app", {
    inputs: ["entrees"],
    fn: (entrees) => {
      const t = entrees.filter((r) => r.source === "app");
      return [{ messages: d3.sum(t, (r) => r.n), premier: d3.min(t, (r) => r.premier), dernier: d3.max(t, (r) => r.dernier) }];
    },
  });

  dash.calc("dernier", {
    inputs: ["entrees"],
    fn: (entrees) => [{ dernier: d3.max(entrees, (r) => r.dernier) || null }],
  });

  // Vitesse apprise : même calcul que learnRates() dans core/vigie-core.js, sur la table tendances (recalculée chaque heure)
  dash.calc("vitesse", {
    inputs: ["tendances"],
    fn: (tendances) => {
      const { PRIOR, PACE } = MODELE;
      const parLigne = new Map();
      let K = 0, T = 0, P = 0;
      for (const r of tendances) {
        const k = +r.arrets, t = +r.minutes, p = +r.paires;
        if (!r.ligne || !(t > 0) || !(k >= 0) || !(p > 0)) continue;
        const x = parLigne.get(r.ligne) || { k: 0, t: 0, p: 0 };
        x.k += k; x.t += t; x.p += p; parLigne.set(r.ligne, x);
        K += k; T += t; P += p;
      }
      const reseau = borne((PRIOR / PACE + K) / (PRIOR + T));
      const rows = [{ portee: "Réseau", min_par_arret: 1 / reseau, paires: P, arrets: K, minutes: T,
        part_donnees: T / (PRIOR + T), mesure_brute: K > 0 ? T / K : null }];
      for (const [ligne, x] of parLigne) {
        const rate = borne((PRIOR * reseau + x.k) / (PRIOR + x.t));
        rows.push({ portee: ligne, min_par_arret: 1 / rate, paires: x.p, arrets: x.k, minutes: x.t,
          part_donnees: x.t / (PRIOR + x.t), mesure_brute: x.k > 0 ? x.t / x.k : null });
      }
      return rows;
    },
  });

  dash.calc("calcule", {
    inputs: ["tendances"],
    fn: (tendances) => [{ le: d3.max(tendances, (r) => r.calcule_le) || null }],
  });

  // Décision du modèle pour chaque couple : mêmes règles que vigie_private.apprendre() (supabase/schema.sql)
  dash.calc("paires_jugees", {
    inputs: ["paires"],
    fn: (paires) => {
      const jour = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });
      const parJour = new Map();
      return [...paires].sort((a, b) => (a.le < b.le ? -1 : 1)).map((p) => {
        const k = +p.arrets, dt = +p.minutes;
        let decision = null;
        if (k < 0) decision = "Écarté : à rebours";
        else if (dt <= 2) decision = "Écarté : moins de 2 min";
        else if (dt > 40) decision = "Écarté : plus de 40 min";
        else if (k > 10) decision = "Écarté : plus de 10 arrêts";
        else if (k > 1.5 * dt) decision = "Écarté : trop rapide";
        if (!decision) {
          const cle = p.ligne + "|" + p.sens + "|" + jour.format(new Date(p.le));
          const n = (parJour.get(cle) || 0) + 1;
          parJour.set(cle, n);
          decision = n > 20 ? "Écarté : plus de 20 ce jour-là" : "Retenu";
        }
        return { le: p.le, ligne: p.ligne, sens: p.sens, de: p.de, a: p.a, arrets: k, minutes: dt, decision, retenu: decision === "Retenu" };
      });
    },
  });

  dash.calc("bilan_paires", {
    inputs: ["paires_jugees"],
    fn: (jugees) => [{ total: jugees.length, retenus: jugees.filter((p) => p.retenu).length }],
  });

  // Estimation du réseau après chaque couple retenu, dans l'ordre où ils sont arrivés
  dash.calc("courbe", {
    inputs: ["paires_jugees"],
    fn: (jugees) => {
      const { PRIOR, PACE } = MODELE;
      let K = 0, T = 0, i = 0;
      const rows = [{ etape: 0, le: null, ligne: null, min_par_arret: PACE, part_donnees: 0 }];
      for (const p of jugees) {
        if (!p.retenu) continue;
        K += p.arrets; T += p.minutes; i += 1;
        rows.push({ etape: i, le: p.le, ligne: p.ligne, min_par_arret: 1 / borne((PRIOR / PACE + K) / (PRIOR + T)), part_donnees: T / (PRIOR + T) });
      }
      return rows;
    },
  });

  dash.calc("heures_tg", {
    inputs: ["telegram"],
    fn: (telegram) => {
      if (!telegram.length) return [];
      const parHeure = new Map();
      for (const r of telegram) {
        const h = new Date(r.heure).getTime();
        const x = parHeure.get(h) || { controles: 0, partis: 0, perturbations: 0 };
        if (r.type === "controle") x.controles += r.n; else if (r.type === "fin") x.partis += r.n; else x.perturbations += r.n;
        parHeure.set(h, x);
      }
      const debut = d3.min([...parHeure.keys()]), fin = d3.max([...parHeure.keys()]);
      const rows = [];
      for (let h = debut; h <= fin; h += 3.6e6) rows.push({ heure: new Date(h).toISOString(), ...(parHeure.get(h) || { controles: 0, partis: 0, perturbations: 0 }) });
      return rows;
    },
  });

  dash.calc("pic", {
    inputs: ["heures_tg"],
    fn: (heures) => (heures.length ? [heures.reduce((a, b) => (b.controles > a.controles ? b : a))] : []),
  });

  // Jour par jour (heure de Lausanne), du plus récent au plus ancien, jours sans signalement compris ; 14 jours
  dash.calc("par_jour", {
    inputs: ["jours"],
    fn: (jours) => {
      if (!jours.length) return [];
      const par = new Map();
      for (const r of jours) {
        const x = par.get(r.jour) || { jour: r.jour, controles_tg: 0, partis_tg: 0, controles_app: 0 };
        if (r.source === "telegram" && r.type === "controle") x.controles_tg += r.n;
        else if (r.source === "telegram" && r.type === "fin") x.partis_tg += r.n;
        else if (r.source === "app" && r.type === "controle") x.controles_app += r.n;
        par.set(r.jour, x);
      }
      const cles = [...par.keys()].sort();
      const auj = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date());   // AAAA-MM-JJ
      const dernier = cles[cles.length - 1] > auj ? cles[cles.length - 1] : auj;
      const rows = [];
      for (let t = Date.parse(cles[0] + "T12:00:00Z"), fin = Date.parse(dernier + "T12:00:00Z"); t <= fin; t += 864e5) {
        const j = new Date(t).toISOString().slice(0, 10);
        rows.push(par.get(j) || { jour: j, controles_tg: 0, partis_tg: 0, controles_app: 0 });
      }
      return rows.reverse().slice(0, 14);
    },
  });

  dash.calc("top_arrets", {
    inputs: ["arrets"],
    fn: (arrets) => {
      const par = new Map();
      for (const r of arrets) {
        if (r.type !== "controle") continue;
        const x = par.get(r.arret) || { arret: r.arret, nom: r.nom, lat: r.lat, lon: r.lon, telegram: 0, app: 0, total: 0 };
        x[r.source === "telegram" ? "telegram" : "app"] += r.n;
        x.total += r.n;
        par.set(r.arret, x);
      }
      return [...par.values()].sort((a, b) => b.total - a.total || b.telegram - a.telegram || (a.nom < b.nom ? -1 : 1));
    },
  });

  dash.calc("par_ligne", {
    inputs: ["lignes"],
    fn: (lignes) => {
      const par = new Map();
      for (const r of lignes) {
        if (r.type !== "controle") continue;
        const nom = r.ligne || "Sans ligne";
        const x = par.get(nom) || { ligne: nom, telegram: 0, app: 0, total: 0, avec_sens: 0 };
        x[r.source === "telegram" ? "telegram" : "app"] += r.n;
        x.total += r.n; x.avec_sens += r.avec_sens;
        par.set(nom, x);
      }
      return [...par.values()].sort((a, b) => (a.ligne === "Sans ligne") - (b.ligne === "Sans ligne") || b.total - a.total);
    },
  });

  dash.calc("qualite", {
    inputs: ["lignes", "confirmations"],
    fn: (lignes, confirmations) => ["telegram", "app"].map((source) => {
      const c = lignes.filter((r) => r.source === source && r.type === "controle");
      const total = d3.sum(c, (r) => r.n), avecLigne = d3.sum(c.filter((r) => r.ligne), (r) => r.n), avecSens = d3.sum(c, (r) => r.avec_sens);
      const conf = confirmations.find((r) => r.source === source) || { controles: 0, confirment: 0 };
      return { source, controles: total, avec_ligne: avecLigne, avec_sens: avecSens, confirment: conf.confirment,
        part_ligne: total ? avecLigne / total : null, part_sens: total ? avecSens / total : null,
        part_confirme: conf.controles ? conf.confirment / conf.controles : null };
    }),
  });

  dash.calc("presence_tg", {
    inputs: ["presence"],
    fn: (presence) => {
      const t = presence.filter((r) => r.source === "telegram");
      return [{ cas: t.length, mediane_minutes: t.length ? d3.median(t, (r) => r.depuis_premier) : null }];
    },
  });

  // ------------------------------------------------------------------ textes et tableaux
  const F = {
    n: new Intl.NumberFormat("fr-CH"),
    d1: new Intl.NumberFormat("fr-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    pct: new Intl.NumberFormat("fr-CH", { style: "percent", maximumFractionDigits: 0 }),
    jour: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long" }),
    jourH: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }),
    jourSemLong: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long" }),
    court: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    hm: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" }),
    hms: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    jourSem: new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric" }),
    jourTable: new Intl.DateTimeFormat("fr-CH", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }),
  };
  const rows = (id) => { const d = dash.data(id); return d.status === "ok" && Array.isArray(d.data) ? d.data : null; };

  function texte(name, id, get, fmt) {
    dash.draw(name, (el) => {
      const r = rows(id);
      const v = r ? get(r) : null;
      el.textContent = v == null || (typeof v === "number" && !Number.isFinite(v)) ? "—" : fmt ? fmt(v) : String(v);
    });
  }
  const reseau = (r) => r.find((x) => x.portee === "Réseau");
  const r0 = (k) => (r) => r[0] && r[0][k];
  texte("tg-messages", "tg", r0("messages"), F.n.format);
  texte("tg-heures", "tg", r0("heures"), F.n.format);
  texte("tg-controles", "tg", r0("controles"), F.n.format);
  texte("tg-partis", "tg", r0("partis"), F.n.format);
  texte("tg-debut", "tg", r0("premier"), (v) => F.jourH.format(new Date(v)));
  texte("app-messages", "app", r0("messages"), F.n.format);
  texte("app-debut", "app", r0("premier"), (v) => F.jour.format(new Date(v)));
  texte("app-fin", "app", r0("dernier"), (v) => F.jour.format(new Date(v)));
  texte("dernier-heure", "dernier", r0("dernier"), (v) => F.hm.format(new Date(v)));
  texte("dernier-jour", "dernier", r0("dernier"), (v) => F.jourSemLong.format(new Date(v)));
  texte("res-paires", "vitesse", (r) => reseau(r) && reseau(r).paires, F.n.format);
  texte("res-part", "vitesse", (r) => reseau(r) && reseau(r).part_donnees, F.pct.format);
  texte("res-pace", "vitesse", (r) => reseau(r) && reseau(r).min_par_arret, F.d1.format);
  texte("res-minutes", "vitesse", (r) => reseau(r) && reseau(r).minutes, F.d1.format);
  texte("calcule-le", "calcule", r0("le"), (v) => F.jourH.format(new Date(v)));
  texte("pj-retenus", "bilan_paires", r0("retenus"), F.n.format);
  texte("pj-total", "bilan_paires", r0("total"), F.n.format);
  texte("pic-heure", "pic", r0("heure"), (v) => F.jourH.format(new Date(v)));
  texte("pic-n", "pic", r0("controles"), F.n.format);
  const tgQ = (r) => r.find((x) => x.source === "telegram");
  texte("q-ligne", "qualite", (r) => tgQ(r) && tgQ(r).part_ligne, F.pct.format);
  texte("q-sens", "qualite", (r) => tgQ(r) && tgQ(r).part_sens, F.pct.format);
  texte("q-confirme", "qualite", (r) => tgQ(r) && tgQ(r).part_confirme, F.pct.format);
  texte("presence-n", "presence_tg", r0("cas"), F.n.format);
  dash.draw("presence-avis", (el) => {
    const r = rows("presence_tg"), x = r && r[0];
    el.textContent = !x ? "" : x.cas < 10 ? ", trop peu pour une durée typique"
      : ", durée médiane " + F.d1.format(x.mediane_minutes) + " min depuis le premier signalement";
  });

  // pastilles de légende : couleur des séries
  const C = { telegram: () => dash.colors[0], app: () => dash.colors[1], partis: () => dash.colors[2] };
  for (const [name, col] of [["cle-controles", C.telegram], ["cle-telegram", C.telegram], ["cle-app", C.app], ["cle-partis", C.partis]]) {
    dash.draw(name, (el) => { el.style.background = col(); });
  }
  dash.draw("cle-carte", (el) => { el.style.color = C.telegram(); });
  dash.draw("cle-estimation", (el) => { el.style.background = C.telegram(); });
  dash.draw("cle-mesure", (el) => { el.style.color = C.telegram(); });

  // une tuile par ligne observée
  dash.draw("tuiles-lignes", (el) => {
    const r = rows("vitesse");
    el.replaceChildren();
    if (!r) return;
    for (const x of r.filter((y) => y.portee !== "Réseau")) {
      const tile = document.createElement("div"); tile.className = "vg-tile";
      const lab = document.createElement("div"); lab.className = "vg-tile-label"; lab.textContent = "Vitesse estimée, ligne " + x.portee;
      const val = document.createElement("div"); val.className = "vg-tile-value";
      const num = document.createElement("span"); num.textContent = F.d1.format(x.min_par_arret);
      const unit = document.createElement("span"); unit.className = "vg-unit"; unit.textContent = " min par arrêt";
      val.append(num, unit);
      const sub = document.createElement("div"); sub.className = "vg-tile-sub";
      sub.textContent = x.paires + " déplacement" + (x.paires > 1 ? "s" : "") + ", " + x.arrets + " arrêt" + (x.arrets > 1 ? "s" : "") +
        " en " + F.d1.format(x.minutes) + " min observées";
      tile.append(lab, val, sub);
      el.append(tile);
    }
  });

  // couples : les plus récents d'abord ; ceux arrivés depuis l'ouverture de la page sont surlignés
  const clePaire = (p) => p.le + "|" + p.ligne + "|" + p.sens;
  let pairesVues = null, pairesNouvelles = new Set();
  function noterNouveautes() {
    const r = rows("paires_jugees");
    if (!r) return;
    const cles = new Set(r.map(clePaire));
    if (pairesVues) for (const k of cles) if (!pairesVues.has(k)) pairesNouvelles.add(k);
    pairesVues = cles;
  }
  dash.draw("table-paires", (tb) => {
    const r = rows("paires_jugees");
    tb.replaceChildren();
    if (!r) return;
    for (const p of [...r].reverse()) {
      const tr = document.createElement("tr");
      if (pairesNouvelles.has(clePaire(p))) { tr.className = "vg-nouveau"; tr.title = "Arrivé depuis l'ouverture de la page"; }
      const cells = [F.court.format(new Date(p.le)), p.ligne, "vers " + p.sens, p.de || "—", p.a || "—", F.n.format(p.arrets), F.d1.format(p.minutes)];
      cells.forEach((t, i) => { const td = document.createElement("td"); td.textContent = t; if (i >= 5) td.className = "vg-num"; tr.append(td); });
      const td = document.createElement("td"); const pill = document.createElement("span");
      pill.className = "vg-pill " + (p.retenu ? "vg-ok" : "vg-no"); pill.textContent = p.decision; td.append(pill); tr.append(td);
      tb.append(tr);
    }
  });

  dash.draw("table-jours", (tb) => {
    const r = rows("par_jour");
    tb.replaceChildren();
    if (!r) return;
    for (const j of r) {
      const tr = document.createElement("tr");
      const cells = [F.jourTable.format(new Date(j.jour + "T12:00:00Z")), F.n.format(j.controles_tg), F.n.format(j.partis_tg), F.n.format(j.controles_app)];
      cells.forEach((t, i) => { const td = document.createElement("td"); td.textContent = t; if (i >= 1) td.className = "vg-num"; tr.append(td); });
      tb.append(tr);
    }
  });

  // ------------------------------------------------------------------ graphiques (d3) : marges mesurées, info-bulle dans le graphique
  const VG_TIP = {
    show(el, ev, lines) {
      let tip = el.querySelector(".vg-tip");
      if (!tip) { tip = document.createElement("div"); tip.className = "vg-tip"; el.append(tip); }
      tip.replaceChildren(...lines.map(([t, cls]) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = t; return d; }));
      tip.hidden = false;
      const b = el.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.max(0, Math.min(b.width - w, x + 12 + w > b.width ? x - w - 12 : x + 12)) + "px";
      tip.style.top = Math.max(0, y - h - 10) + "px";
    },
    hide(el) { const tip = el.querySelector(".vg-tip"); if (tip) tip.hidden = true; },
  };
  const svgIn = (el, H, label) => d3.select(el).append("svg").attr("width", "100%").attr("height", H)
    .attr("viewBox", `0 0 ${el.clientWidth || 340} ${H}`).attr("role", "img").attr("aria-label", label);
  const vide = (el, status, msg) => {
    el.replaceChildren();
    const p = document.createElement("p"); p.className = "vg-cap";
    p.textContent = status === "error" ? "Calcul impossible." : status === "loading" ? "Chargement…" : (msg || "Pas encore de données.");
    el.append(p);
  };
  // barre arrondie (4 px) au bout de la valeur seulement
  const vbar = (x, y, w, h, r) => { r = Math.max(0, Math.min(r, w / 2, h)); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
  const hbar = (x, y, w, h, r) => { r = Math.max(0, Math.min(r, h / 2, w)); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };
  const textWidth = (svg, strings, cls) => {
    const g = svg.append("g").attr("class", cls || "vg-axis");
    const w = d3.max(strings, (s) => g.append("text").text(s).node().getComputedTextLength()) || 0;
    g.remove();
    return w;
  };

  // Telegram par heure : barres empilées contrôles + « partis »
  dash.draw("chart-heures", (el) => {
    const d = dash.data("heures_tg");
    if (d.status !== "ok" || !d.data || !d.data.length) return vide(el, d.status);
    el.replaceChildren();
    const data = d.data, W = el.clientWidth || 340, H = 210;
    const svg = svgIn(el, H, "Contrôles et « partis » signalés sur Telegram, heure par heure");
    const yMax = d3.max(data, (r) => r.controles + r.partis) || 1;
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([H - 40, 10]);
    const ticks = y.ticks(Math.min(4, y.domain()[1]));
    const m = { l: textWidth(svg, ticks.map(String)) + 10, r: 4 };
    const x = d3.scaleBand().domain(data.map((r) => r.heure)).range([m.l, W - m.r]).paddingInner(0.18);
    svg.append("g").attr("class", "vg-grid").selectAll("line").data(ticks).join("line")
      .attr("x1", m.l).attr("x2", W - m.r).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    svg.append("g").attr("class", "vg-axis").selectAll("text").data(ticks).join("text")
      .attr("x", m.l - 6).attr("y", (v) => y(v)).attr("dy", "0.32em").attr("text-anchor", "end").text((v) => F.n.format(v));
    const bw = x.bandwidth();
    const g = svg.append("g").selectAll("g").data(data).join("g");
    g.filter((r) => r.controles > 0).append("path").style("fill", C.telegram())
      .attr("d", (r) => r.partis > 0 ? `M${x(r.heure)},${y(r.controles)}h${bw}V${y(0)}h${-bw}Z` : vbar(x(r.heure), y(r.controles), bw, y(0) - y(r.controles), 4));
    g.filter((r) => r.partis > 0).append("path").style("fill", C.partis())
      .attr("d", (r) => vbar(x(r.heure), y(r.controles + r.partis), bw, Math.max(0, y(r.controles) - y(r.controles + r.partis) - 2), 4));
    svg.append("line").attr("class", "vg-base").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    // heures : un intervalle qui divise 24 (mêmes repères chaque jour) et laisse la place au texte, sinon aucune ;
    // jours : à minuit, un sur deux ou un par semaine si la place manque ; le premier jour, entamé, seulement
    // s'il ne touche pas le suivant ; rien qui déborde du graphique ou touche les graduations de gauche
    const heureDe = (r) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "numeric", hourCycle: "h23" }).format(new Date(r.heure)));
    const pos = data.map((r, i) => ({ r, i, h: heureDe(r), left: x(r.heure), cx: x(r.heure) + bw / 2 }));
    const step = x.step(), hw = textWidth(svg, ["23 h"]);
    const ax = svg.append("g").attr("class", "vg-axis");
    const every = [1, 2, 3, 4, 6, 8, 12].find((k) => k * step >= hw + 10);
    if (every) pos.filter((o) => o.h % every === 0 && o.cx - hw / 2 >= m.l - 2 && o.cx + hw / 2 <= W).forEach((o) =>
      ax.append("text").attr("x", o.cx).attr("y", H - 26).attr("text-anchor", "middle").text(o.h + " h"));
    const nomJour = (o) => F.jourSem.format(new Date(o.r.heure));
    const dw = textWidth(svg, pos.filter((o) => o.h === 0 || o.i === 0).map(nomJour)) + 10;
    const parJours = [1, 2, 7].find((k) => k * 24 * step >= dw) || 14;
    const jours = pos.filter((o) => o.h === 0).filter((o, k) => k % parJours === 0 && o.left + dw - 10 <= W);
    if (pos[0].h !== 0 && pos[0].left + dw - 10 <= W && (!jours.length || pos[0].left + dw <= jours[0].left)) jours.unshift(pos[0]);
    jours.forEach((o) => ax.append("text").attr("x", o.left).attr("y", H - 8).attr("text-anchor", "start")
      .style("fill", "var(--ink)").text(nomJour(o)));
    // survol : une colonne entière
    svg.append("g").selectAll("rect").data(data).join("rect")
      .attr("x", (r) => x(r.heure) - (x.step() - bw) / 2).attr("width", x.step()).attr("y", 0).attr("height", H - 34)
      .style("fill", "transparent")
      .on("pointerenter pointermove", (ev, r) => VG_TIP.show(el, ev, [[F.jourH.format(new Date(r.heure)), "vg-tip-sub"],
        [r.controles + " contrôle" + (r.controles > 1 ? "s" : "")], [r.partis + " « partis »"]]))
      .on("pointerleave", () => VG_TIP.hide(el));
  });

  // Hypothèse, mesure, estimations : une ligne par portée (réseau, puis lignes de la plus observée à la moins observée)
  dash.draw("chart-balance", (el) => {
    const d = dash.data("vitesse");
    if (d.status !== "ok" || !d.data || !d.data.length) return vide(el, d.status);
    el.replaceChildren();
    const lignes = [...d.data].sort((a, b) => (a.portee === "Réseau" ? -1 : b.portee === "Réseau" ? 1 : b.minutes - a.minutes));
    const noms = lignes.map((r) => (r.portee === "Réseau" ? "Tout le réseau" : "Ligne " + r.portee));
    const W = el.clientWidth || 340, rh = 30, top = 24, H = top + lignes.length * rh + 24;
    const svg = svgIn(el, H, "Minutes par arrêt estimées et mesurées, pour le réseau et chaque ligne observée, avec l'hypothèse de départ");
    const vals = lignes.flatMap((r) => [r.min_par_arret, r.mesure_brute]).filter((v) => v != null).concat([3]);
    const xmax = Math.min(15, Math.max(6, Math.ceil(d3.max(vals)) + 1));
    const m = { l: Math.max(textWidth(svg, noms), textWidth(svg, noms.slice(0, 1), "vg-lbl-strong")) + 12,   // « Tout le réseau » en gras
      r: textWidth(svg, lignes.map((r) => F.d1.format(r.min_par_arret) + " min"), "vg-lbl-strong") + 12 };
    const x = d3.scaleLinear().domain([1, xmax]).range([m.l, W - m.r]);
    const ticks = x.ticks(Math.max(2, Math.min(xmax - 1, Math.floor((W - m.l - m.r) / 36))));
    const bas = top + lignes.length * rh;
    svg.append("g").attr("class", "vg-grid").selectAll("line").data(ticks).join("line").attr("x1", (t) => x(t)).attr("x2", (t) => x(t)).attr("y1", top - 6).attr("y2", bas);
    svg.append("g").attr("class", "vg-axis").selectAll("text").data(ticks).join("text").attr("x", (t) => x(t)).attr("y", bas + 16).attr("text-anchor", "middle").text((t) => F.n.format(t));
    svg.append("line").attr("class", "vg-ref").attr("x1", x(3)).attr("x2", x(3)).attr("y1", top - 10).attr("y2", bas);
    svg.append("text").attr("class", "vg-lbl").attr("x", x(3) + 4).attr("y", top - 12).text("hypothèse : 3 min");
    lignes.forEach((r, i) => {
      const y = top + i * rh + rh / 2, g = svg.append("g");
      g.append("text").attr("class", r.portee === "Réseau" ? "vg-lbl-strong" : "vg-lbl").attr("x", m.l - 10).attr("y", y).attr("dy", "0.32em").attr("text-anchor", "end").text(noms[i]);
      if (r.mesure_brute != null) {
        const xm = x(Math.min(xmax, r.mesure_brute));
        g.append("line").attr("x1", x(r.min_par_arret)).attr("x2", xm).attr("y1", y).attr("y2", y).style("stroke", "var(--rail)").style("stroke-width", 2);
        g.append("circle").attr("cx", xm).attr("cy", y).attr("r", 5).style("fill", "var(--surface)").style("stroke", C.telegram()).style("stroke-width", 2);
      }
      g.append("circle").attr("cx", x(r.min_par_arret)).attr("cy", y).attr("r", 6).style("fill", C.telegram()).style("stroke", "var(--surface)").style("stroke-width", 2);
      g.append("text").attr("class", "vg-lbl-strong").attr("x", W - m.r + 8).attr("y", y).attr("dy", "0.32em").text(F.d1.format(r.min_par_arret) + " min");
      g.append("rect").attr("x", 0).attr("width", W).attr("y", y - rh / 2).attr("height", rh).style("fill", "transparent")
        .on("pointerenter pointermove", (ev) => VG_TIP.show(el, ev, [[noms[i], "vg-tip-sub"],
          ["Estimation : " + F.d1.format(r.min_par_arret) + " min par arrêt"],
          [r.mesure_brute != null ? "Mesure brute : " + F.d1.format(r.mesure_brute) + " min par arrêt" : "Pas encore d'arrêt parcouru"],
          [r.paires + " déplacement" + (r.paires > 1 ? "s" : "") + ", " + F.d1.format(r.minutes) + " min observées (" + F.pct.format(r.part_donnees) + " du poids)", "vg-tip-sub"]]))
        .on("pointerleave", () => VG_TIP.hide(el));
    });
  });

  // Courbe : estimation du réseau après chaque couple retenu
  dash.draw("chart-courbe", (el) => {
    const d = dash.data("courbe");
    if (d.status !== "ok" || !d.data || !d.data.length) return vide(el, d.status);
    el.replaceChildren();
    const data = d.data, W = el.clientWidth || 340, H = 190;
    const svg = svgIn(el, H, "Minutes par arrêt estimées pour le réseau, au départ puis après chaque déplacement retenu");
    const vals = data.map((r) => r.min_par_arret).concat([3]);
    const y = d3.scaleLinear().domain([Math.max(1, Math.floor(d3.min(vals) - 0.5)), Math.ceil(d3.max(vals) + 0.5)]).range([H - 34, 14]);
    const ticks = y.ticks(4);
    const m = { l: textWidth(svg, ticks.map((t) => F.n.format(t))) + 10, r: 70 };
    const x = d3.scalePoint().domain(data.map((r) => r.etape)).range([m.l + 6, W - m.r]).padding(data.length > 1 ? 0 : 0.5);
    svg.append("g").attr("class", "vg-grid").selectAll("line").data(ticks).join("line").attr("x1", m.l).attr("x2", W - m.r + 60).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    svg.append("g").attr("class", "vg-axis").selectAll("text").data(ticks).join("text").attr("x", m.l - 6).attr("y", (v) => y(v)).attr("dy", "0.32em").attr("text-anchor", "end").text((v) => F.n.format(v));
    svg.append("line").attr("class", "vg-ref").attr("x1", m.l).attr("x2", W - m.r + 60).attr("y1", y(3)).attr("y2", y(3));
    svg.append("text").attr("class", "vg-lbl").attr("x", W - 2).attr("y", y(3) - 6).attr("text-anchor", "end").text("hypothèse : 3 min");
    svg.append("path").datum(data).style("fill", "none").style("stroke", C.telegram()).style("stroke-width", 2)
      .attr("d", d3.line().x((r) => x(r.etape)).y((r) => y(r.min_par_arret)));
    svg.append("g").selectAll("circle").data(data).join("circle").attr("cx", (r) => x(r.etape)).attr("cy", (r) => y(r.min_par_arret)).attr("r", 5)
      .style("fill", C.telegram()).style("stroke", "var(--surface)").style("stroke-width", 2);
    const last = data[data.length - 1];
    svg.append("text").attr("class", "vg-lbl-strong").attr("x", x(last.etape) + 10).attr("y", y(last.min_par_arret)).attr("dy", "0.32em").text(F.d1.format(last.min_par_arret) + " min");
    // repères : tous si la place suffit, sinon un sur 2, 5, 10… ; aucun ne touche « départ » ni ne déborde
    const noms = data.map((r) => (r.etape === 0 ? "départ" : r.etape === 1 ? "1er" : r.etape + "e"));
    const lw = textWidth(svg, noms.slice(1).concat(["0e"])) + 8, dep = textWidth(svg, ["départ"]) / 2;
    const tous = data.length > 1 ? x.step() : Infinity;
    const k = [1, 2, 5, 10, 20, 50, 100].find((n) => n * tous >= lw) || 200;
    const xl = svg.append("g").attr("class", "vg-axis");
    data.forEach((r, i) => {
      const cx = x(r.etape);
      if (i % k !== 0 || (i > 0 && cx - x(data[0].etape) < dep + lw / 2) || cx + lw / 2 - 4 > W) return;
      xl.append("text").attr("x", cx).attr("y", H - 14).attr("text-anchor", "middle").text(noms[i]);
    });
    svg.append("g").selectAll("circle").data(data).join("circle").attr("cx", (r) => x(r.etape)).attr("cy", (r) => y(r.min_par_arret)).attr("r", 16).style("fill", "transparent")
      .on("pointerenter pointermove", (ev, r) => VG_TIP.show(el, ev, r.etape === 0
        ? [["Départ", "vg-tip-sub"], ["Hypothèse : 3 min par arrêt"]]
        : [[F.jourH.format(new Date(r.le)) + " · " + r.ligne, "vg-tip-sub"], [F.d1.format(r.min_par_arret) + " min par arrêt"], ["observations : " + F.pct.format(r.part_donnees) + " du poids"]]))
      .on("pointerleave", () => VG_TIP.hide(el));
  });

  // Barres horizontales empilées Telegram + app
  function barresH(el, id, label, nomDe, max) {
    const d = dash.data(id);
    if (d.status !== "ok" || !d.data || !d.data.length) return vide(el, d.status);
    el.replaceChildren();
    const data = d.data.slice(0, max), W = el.clientWidth || 340, bh = 18, gap = 8, H = data.length * (bh + gap) + 8;
    const svg = svgIn(el, H, label);
    const m = { l: Math.min(W * 0.45, textWidth(svg, data.map(nomDe)) + 10), r: textWidth(svg, data.map((r) => F.n.format(r.total)), "vg-lbl-strong") + 10 };
    const x = d3.scaleLinear().domain([0, d3.max(data, (r) => r.total) || 1]).range([m.l, W - m.r]);
    const g = svg.append("g").selectAll("g").data(data).join("g").attr("transform", (r, i) => `translate(0,${i * (bh + gap) + 4})`);
    g.append("text").attr("class", "vg-lbl").attr("x", m.l - 8).attr("y", bh / 2).attr("dy", "0.32em").attr("text-anchor", "end")
      .text((r) => nomDe(r)).each(function () {   // nom trop long : coupé avec « … »
        let s = this.textContent;
        while (this.getComputedTextLength() > m.l - 10 && s.length > 4) { s = s.slice(0, -1); this.textContent = s + "…"; }
      });
    g.filter((r) => r.telegram > 0).append("path").style("fill", C.telegram())
      .attr("d", (r) => r.app > 0 ? `M${x(0)},0H${x(r.telegram)}V${bh}H${x(0)}Z` : hbar(x(0), 0, x(r.telegram) - x(0), bh, 4));
    g.filter((r) => r.app > 0).append("path").style("fill", C.app())
      .attr("d", (r) => hbar(x(r.telegram) + (r.telegram > 0 ? 2 : 0), 0, Math.max(0, x(r.total) - x(r.telegram) - (r.telegram > 0 ? 2 : 0)), bh, 4));
    g.append("text").attr("class", "vg-lbl-strong").attr("x", (r) => x(r.total) + 6).attr("y", bh / 2).attr("dy", "0.32em").text((r) => F.n.format(r.total));
    g.append("rect").attr("x", 0).attr("width", W).attr("y", -gap / 2).attr("height", bh + gap).style("fill", "transparent")
      .on("pointerenter pointermove", (ev, r) => VG_TIP.show(el, ev, [[nomDe(r), "vg-tip-sub"], ["Telegram : " + r.telegram], ["App : " + r.app]]))
      .on("pointerleave", () => VG_TIP.hide(el));
  }
  dash.draw("chart-arrets", (el) => barresH(el, "top_arrets", "Les arrêts où le plus de contrôles ont été signalés", (r) => r.nom, 10));
  dash.draw("chart-lignes", (el) => barresH(el, "par_ligne", "Contrôles signalés par ligne citée", (r) => (r.ligne === "Sans ligne" ? r.ligne : "Ligne " + r.ligne), 16));

  // Carte : arrêts signalés, taille selon le nombre de contrôles ; M1, M2 et LEB en gris
  dash.draw("chart-carte", (el) => {
    const a = dash.data("top_arrets"), t = dash.data("trace");
    if (a.status !== "ok" || t.status !== "ok" || !a.data || !a.data.length) return vide(el, a.status === "ok" ? t.status : a.status);
    el.replaceChildren();
    const pts = a.data.filter((r) => r.lat != null && r.lon != null);
    const W = el.clientWidth || 340, H = Math.round(Math.min(460, Math.max(260, W * 0.8)));
    const svg = svgIn(el, H, "Carte des arrêts où un contrôle a été signalé, avec les lignes M1, M2 et LEB");
    const fit = pts.map((r) => [r.lon, r.lat]).concat(t.data.filter((r) => r.ligne !== "LEB").map((r) => [r.lon, r.lat]));
    const proj = d3.geoMercator().fitExtent([[18, 18], [W - 18, H - 18]], { type: "MultiPoint", coordinates: fit });
    const parLigne = d3.group(t.data, (r) => r.ligne);
    const line = d3.line().x((r) => proj([r.lon, r.lat])[0]).y((r) => proj([r.lon, r.lat])[1]);
    // boîtes des textes déjà posés (mesurées, jambages compris) : un nom ne se pose pas sur un autre
    const boxes = [], boite = (n) => { const b = n.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const touche = (q) => boxes.some((b) => q.x < b.x + b.w + 4 && q.x + q.w + 4 > b.x && q.y < b.y + b.h + 2 && q.y + q.h + 2 > b.y);
    for (const [ligne, rs] of parLigne) {
      const s = [...rs].sort((p, q) => p.ordre - q.ordre);
      svg.append("path").attr("class", "vg-rail").attr("d", line(s));
      // nom de la ligne à son bout visible le plus éloigné du centre
      const inside = s.map((r) => proj([r.lon, r.lat])).filter(([px, py]) => px > 10 && px < W - 30 && py > 10 && py < H - 10);
      const p = d3.greatest(inside, ([px, py]) => Math.hypot(px - W / 2, py - H / 2));
      if (!p) continue;
      const lt = svg.append("text").attr("class", "vg-lbl").attr("x", p[0] + 6).attr("y", p[1] - 8).text(ligne);
      const b = boite(lt.node());
      if (touche(b)) lt.remove(); else boxes.push(b);
    }
    const r = d3.scaleSqrt().domain([0, d3.max(pts, (p) => p.total) || 1]).range([0, 12]);
    const sorted = [...pts].sort((p, q) => q.total - p.total);
    svg.append("g").selectAll("circle").data(sorted).join("circle")
      .attr("cx", (p) => proj([p.lon, p.lat])[0]).attr("cy", (p) => proj([p.lon, p.lat])[1]).attr("r", (p) => Math.max(4, r(p.total)))
      .style("fill", C.telegram()).style("fill-opacity", 0.75).style("stroke", "var(--surface)").style("stroke-width", 2)
      .on("pointerenter pointermove", (ev, p) => VG_TIP.show(el, ev, [[p.nom, "vg-tip-sub"], [p.total + " contrôle" + (p.total > 1 ? "s" : "") + " signalé" + (p.total > 1 ? "s" : "")], ["Telegram : " + p.telegram + " · App : " + p.app]]))
      .on("pointerleave", () => VG_TIP.hide(el));
    // noms des arrêts les plus signalés, là où ils ne touchent pas un autre nom
    for (const p of sorted.slice(0, 4)) {
      const [px, py] = proj([p.lon, p.lat]), rad = Math.max(4, r(p.total));
      const lab = svg.append("text").attr("class", "vg-lbl-strong vg-halo").text(p.nom);
      const w = lab.node().getComputedTextLength();
      const spots = [[px + rad + 4, py + 4], [px - rad - 4 - w, py + 4], [px - w / 2, py - rad - 6], [px - w / 2, py + rad + 14]];
      const ok = spots.find(([lx, ly]) => {
        lab.attr("x", lx).attr("y", ly);
        const b = boite(lab.node());
        return b.x >= 0 && b.x + b.w <= W && b.y >= 0 && b.y + b.h <= H && !touche(b);
      });
      if (!ok) { lab.remove(); continue; }
      lab.attr("x", ok[0]).attr("y", ok[1]);
      boxes.push(boite(lab.node()));
    }
  });

  // ------------------------------------------------------------------ accès privé
  const $ = (id) => document.getElementById(id);
  const porte = $("porte"), tableau = $("tableau");
  const lireCle = () => { try { return localStorage.getItem(STOCK) || ""; } catch (e) { return ""; } };
  const garderCle = (c) => { try { localStorage.setItem(STOCK, c); } catch (e) { /* gardée pour cette visite seulement */ } };
  const oublierCle = () => { try { localStorage.removeItem(STOCK); } catch (e) { /* rien à effacer */ } };
  const FORMAT_CLE = /^[0-9a-f]{16,128}$/;

  let cle = "";
  {
    // lien personnel …/apprentissage/#cle=… : la clé est gardée sur l'appareil et quitte la barre d'adresse
    const m = /(?:^#|&)cle=([0-9a-fA-F]{16,128})(?:&|$)/.exec(location.hash);
    if (m) {
      cle = m[1].toLowerCase();
      garderCle(cle);
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      const c = lireCle();
      cle = FORMAT_CLE.test(c) ? c : "";
    }
  }

  function montrerPorte(message) {
    arreter();
    tableau.hidden = true;
    porte.hidden = false;
    $("porte-erreur").hidden = !message;
    $("porte-erreur").textContent = message || "";
    $("porte-cle").value = "";
    $("porte-cle").focus();
  }
  $("porte-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = $("porte-cle").value.trim();
    const m = /cle=([0-9a-fA-F]+)/.exec(v);            // le lien complet collé tel quel
    const k = (m ? m[1] : v).toLowerCase();
    if (!FORMAT_CLE.test(k)) {
      $("porte-erreur").hidden = false;
      $("porte-erreur").textContent = "Cette clé n'a pas le bon format : colle le lien complet ou la clé seule.";
      return;
    }
    cle = k;
    garderCle(k);
    demarrer();
  });
  $("oublier").addEventListener("click", () => { oublierCle(); cle = ""; montrerPorte(""); });

  // ------------------------------------------------------------------ chargement et mise à jour en direct
  function etat(code, message) {
    $("etat").dataset.etat = code;
    $("etat-texte").textContent = message;
  }

  let net = null;
  async function chargerReseau() {
    if (net) return net;
    const r = await fetch("reseau.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("réseau introuvable (" + r.status + ")");
    return (net = await r.json());
  }
  async function chargerStats() {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(URL_STATS, { headers: { "x-vigie-cle": cle }, cache: "no-store", signal: ctl.signal });
      if (r.status === 401) { const e = new Error("clé refusée"); e.code = 401; throw e; }
      if (!r.ok) throw new Error("serveur " + r.status);
      return await r.json();
    } finally {
      clearTimeout(minuteur);
    }
  }

  let enCours = null, encore = false, minuterie = null, prochain = 0, dernierChargement = 0;
  let annonces = 0, essais = 0, totalVu = -1, direct = false;

  // une seule mise à jour programmée à la fois : la plus proche l'emporte
  function planifier(ms) {
    const t = Date.now() + ms;
    if (minuterie && prochain <= t) return;
    clearTimeout(minuterie);
    prochain = t;
    minuterie = setTimeout(() => { minuterie = null; prochain = 0; rafraichir(); }, ms);
  }

  async function rafraichir() {
    if (!cle || !URL_STATS) return;
    if (enCours) { encore = true; return; }
    etat("charge", dash.has() ? "Mise à jour…" : "Chargement des statistiques…");
    enCours = (async () => {
      try {
        const [reseau, stats] = await Promise.all([chargerReseau(), chargerStats()]);
        const total = d3.sum(stats.totaux || [], (r) => r.n);
        porte.hidden = true;
        tableau.hidden = false;
        dash.set(transformer(stats, reseau));
        noterNouveautes();
        dash.render();
        dernierChargement = Date.now();
        // signalement annoncé en temps réel mais pas encore compté (la fonction garde son résultat 15 s) : nouvel essai
        if (annonces > 0 && total <= totalVu && essais < 3) { essais += 1; planifier(16000); } else { annonces = 0; essais = 0; }
        totalVu = Math.max(totalVu, total);
        etat("direct", (direct ? "En direct" : "Actualisée toutes les 5 minutes") + " · mise à jour à " + F.hms.format(new Date()));
      } catch (e) {
        if (e.code === 401) {
          oublierCle();
          cle = "";
          montrerPorte("Clé refusée : ouvre ton lien personnel, ou colle la clé à nouveau.");
          return;
        }
        etat("erreur", "Mise à jour impossible (" + (e.name === "AbortError" ? "délai dépassé" : e.message) + "). Nouvel essai dans une minute.");
        planifier(60000);
      } finally {
        enCours = null;
        if (encore) { encore = false; planifier(1500); }
      }
    })();
    return enCours;
  }

  // temps réel : chaque signalement ajouté à la table publique (app ou Telegram) relance le calcul
  let client = null, canal = null, periodique = null;
  function ecouter() {
    if (canal || !window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseKey) return;
    try {
      client = client || window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      canal = client.channel("tableau-apprentissage")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "signalements" }, () => {
          annonces += 1;
          essais = 0;
          planifier(4000);
        })
        .subscribe((status) => {
          direct = status === "SUBSCRIBED";
          if (dash.has() && $("etat").dataset.etat === "direct") {
            etat("direct", (direct ? "En direct" : "Actualisée toutes les 5 minutes") + " · mise à jour à " + F.hms.format(new Date(dernierChargement)));
          }
        });
    } catch (e) {
      console.warn("temps réel indisponible : " + e.message);
    }
  }

  function arreter() {
    clearTimeout(minuterie); minuterie = null; prochain = 0;
    clearInterval(periodique); periodique = null;
    if (client && canal) client.removeChannel(canal);
    canal = null; direct = false;
  }

  function demarrer() {
    porte.hidden = true;
    tableau.hidden = false;
    ecouter();
    if (!periodique) periodique = setInterval(() => { if (!document.hidden) rafraichir(); }, PERIODE);
    rafraichir();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && cle && Date.now() - dernierChargement > 60000) rafraichir();
  });

  // largeur changée (rotation, fenêtre) : graphiques redessinés à la nouvelle taille
  let largeur = 0, dessin = 0;
  new ResizeObserver(() => {
    const w = tableau.clientWidth;
    if (!w || Math.abs(w - largeur) < 4) return;
    largeur = w;
    if (!dash.has()) return;
    cancelAnimationFrame(dessin);
    dessin = requestAnimationFrame(() => dash.render());
  }).observe(tableau);

  if (!URL_STATS) {
    porte.hidden = false;
    $("porte-form").hidden = true;
    $("porte-erreur").hidden = false;
    $("porte-erreur").textContent = "Statistiques indisponibles : ce site a été construit sans base Supabase.";
  } else if (cle) {
    demarrer();
  } else {
    montrerPorte("");
  }
})();
