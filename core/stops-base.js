/*
 * Arrêts principaux du réseau (prototype). Les coordonnées sont injectées par build-data.py
 * depuis des sources vérifiées ; ce fichier ne contient que noms, alias et lignes.
 * La version complète remplace cette liste par stops.json généré depuis le GTFS officiel.
 */
(function (root) {
  const S = [
    // ---- M2 (Ouchy -> Croisettes)
    { id: "ouchy", major: true, name: "Ouchy-Olympique", short: "Ouchy", lines: ["M2"], alias: ["ouchy", "ouchy olympique", "port ouchy"] },
    { id: "jordils", name: "Jordils", lines: ["M2"] },
    { id: "delices", name: "Délices", lines: ["M2"] },
    { id: "grancy", name: "Grancy", lines: ["M2"] },
    { id: "gare", major: true, name: "Lausanne-Gare", short: "Gare", lines: ["M2"], alias: ["gare", "lausanne gare", "gare lausanne", "gare cff", "gare centrale", "place gare"] },
    { id: "flon", major: true, name: "Lausanne-Flon", short: "Flon", lines: ["M1", "M2"], alias: ["flon", "lausanne flon", "place europe", "europe"] },
    { id: "riponne", name: "Riponne-M. Béjart", short: "Riponne", lines: ["M2"], alias: ["riponne", "riponne bejart", "riponne maurice bejart", "place riponne"] },
    { id: "bessieres", name: "Bessières", lines: ["M2"], alias: ["pont bessieres"] },
    { id: "ours", name: "Ours", lines: ["M2"], alias: ["place ours"] },
    { id: "chuv", major: true, name: "CHUV", lines: ["M2"], alias: ["hopital"] },
    { id: "sallaz", major: true, name: "Sallaz", lines: ["M2"], alias: ["place sallaz"] },
    { id: "fourmi", name: "Fourmi", lines: ["M2"] },
    { id: "vennes", name: "Vennes", lines: ["M2"] },
    { id: "croisettes", major: true, name: "Croisettes", lines: ["M2"], alias: ["epalinges croisettes"] },
    // ---- M1 (Flon -> Renens)
    { id: "vigie", name: "Vigie", lines: ["M1"] },
    { id: "montelly", name: "Montelly", lines: ["M1"] },
    { id: "provence", name: "Provence", lines: ["M1"] },
    { id: "malley", major: true, name: "Malley", lines: ["M1"], alias: ["prilly malley"] },
    { id: "bourdonnette", name: "Bourdonnette", lines: ["M1"] },
    { id: "chamberonne", name: "UNIL-Chamberonne", short: "Chamberonne", lines: ["M1"], alias: ["unil chamberonne", "unil dorigny", "dorigny"] },
    { id: "mouline", name: "UNIL-Mouline", short: "Mouline", lines: ["M1"], alias: ["unil mouline", "unil"] },
    { id: "sorge", name: "UNIL-Sorge", short: "Sorge", lines: ["M1"], alias: ["unil sorge"] },
    { id: "epfl", major: true, name: "EPFL", lines: ["M1"], alias: ["poly"] },
    { id: "bassenges", name: "Bassenges", lines: ["M1"] },
    { id: "cerisaie", name: "Cerisaie", lines: ["M1"] },
    { id: "crochy", name: "Crochy", lines: ["M1"] },
    { id: "epenex", name: "Epenex", lines: ["M1"] },
    { id: "renens", major: true, name: "Renens-Gare", short: "Renens", lines: ["M1"], alias: ["renens", "renens gare", "gare renens", "renens cff"] },
    // ---- pôles bus
    { id: "chauderon", name: "Chauderon", alias: ["place chauderon"] },
    { id: "belair", name: "Bel-Air", alias: ["bel air", "belair"] },
    { id: "stfrancois", name: "St-François", alias: ["st francois", "saint francois", "st f", "stf", "place st francois"] },
    { id: "georgette", name: "Georgette" },
    { id: "tunnel", name: "Tunnel", alias: ["place tunnel"] },
    { id: "maladiere", name: "Maladière" },
    { id: "prelaz", name: "Prélaz" },
    { id: "pully", major: true, name: "Pully-Gare", short: "Pully", alias: ["pully", "pully gare", "gare pully"] },
    { id: "lutry", major: true, name: "Lutry-Corniche", short: "Lutry", alias: ["lutry", "lutry corniche"] },
    { id: "bellevaux", name: "Bellevaux" },
    { id: "blecherette", name: "Blécherette", alias: ["blech"] },
    { id: "beaulieu", name: "Beaulieu" },
    { id: "chailly", name: "Chailly-Village", short: "Chailly", alias: ["chailly", "chailly village"] },
    { id: "ruffy", name: "Victor-Ruffy", alias: ["victor ruffy", "ruffy"] },
    { id: "vidy", name: "Vidy-Port", short: "Vidy", alias: ["vidy", "vidy port"] },
    { id: "montoie", name: "Montoie" },
    { id: "stade", name: "Stade Olympique", alias: ["pontaise", "stade olympique"] },
    { id: "14avril", name: "Renens-14 Avril", short: "14 Avril", alias: ["14 avril", "renens 14 avril", "quatorze avril"] },
    { id: "crissier", name: "Crissier, Place Centrale", short: "Crissier", alias: ["crissier", "crissier place centrale"] },
    { id: "croset", name: "Ecublens, Croset", short: "Croset", alias: ["croset", "ecublens croset", "ecublens"] },
    { id: "lemont", name: "Le Mont, Grand-Mont", short: "Grand-Mont", alias: ["le mont", "mont sur lausanne", "grand mont"] },
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = S;
  else root.VIGIE_STOPS_BASE = S;
})(typeof self !== "undefined" ? self : this);
