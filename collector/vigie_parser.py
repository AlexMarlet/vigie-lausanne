"""
Vigie — parseur de messages (portage Python de core/vigie-core.js).

Transforme un message libre du groupe Telegram en signalement structuré :
    {"kind": "controle"|"perturbation"|"fin"|"question"|"autre",
     "sub": ..., "of": ..., "stop_id": ..., "dir_stop_id": ..., "line": ..., "fuzzy": bool, "usable": bool}

Les deux implémentations partagent les cas de test de core/parser-cases.json.
"""
from __future__ import annotations

import re
import unicodedata

FILLER = {"de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "en", "sur", "et", "un", "une", "y"}

NOT_STOPS = set((
    "controle controles controleur controleurs control controleuse direction ligne lignes arret arrets "
    "devant apres avant entre metro metros bus quai quais sortie entree partis parti partie descendus descendu montes monte "
    "attention plusieurs beaucoup maintenant toujours encore civil civils uniforme uniformes bleus agents agent gilets "
    "minutes minute heure heures personne personnes ticket tickets billet billets check verification retard retards panne "
    "pannes deviation devie bloque bloquee accident travaux manif bonde plein vers dans pour avec sans sont etait cette"
).split())

DIR_WORDS = {"direction", "dir", "direc", "vers", "destination", "sens"}
# entre « direction » et le nom de l'arrêt visé, ces mots coupent : ce qui suit n'est plus le sens
DIR_BREAK = {"il", "ils", "elle", "elles", "iels", "ielxs", "on", "est", "ont", "arrivent", "arrive", "attendent"}

COUNT_WORDS = ("controleurs?|controleuses?|agents?|mecs?|gars|types?|personnes?|bleus?|schtroumpfs?|"
               "minutes?|min|mn|fois|chf|francs?|ans|avril")

RE_METRO = re.compile(r"\b(?:m|metro)\s?([123])\b")
RE_LINE = re.compile(r"\b(?:ligne|lignes|bus|trolley|trolleybus|l|n|no|num|numero|le|du|dans le)\s?(\d{1,2})\b"
                     r"(?!\s(?:" + COUNT_WORDS + r")\b)")
RE_LINE_DIR = re.compile(r"(?:^|\s)(\d{1,2})\s(?:direction|dir|vers)\b")
RE_LEB = re.compile(r"\b(?:leb|r ?20)\b")   # train Lausanne-Echallens-Bercher (R20 dans l'horaire)

RE_QUESTION = re.compile(r"\b(qqn|quelqu un|quelquun|y a t il|y a t|ya t il|est ce qu|savez|sait on|des nouvelles|vous avez vu|dispo|"
                         r"il y en a|y en a|y a des|ya des|il y a des|y a du|ya du|qui sait|des infos|des news|ou ca|ou sont|ou ils|"
                         r"ils sont ou|toujours la|encore la)\b")
RE_CLEAR = re.compile(r"\b(partis?|parties|descendus?|descendues?|sortis?|disparus?|plus de contr\w*|plus personne|plus rien|plus la|"
                      r"ras|rien a signaler|fausse alerte|c est bon|cest bon|termine|fini|ils sont plus|y a plus|y en a plus|ya plus)\b")
# « descendus à Délices » : avec un arrêt, ils y sont (un contrôle là) ; la fin d'un contrôle demande un de ces mots-là
RE_CLEAR_STRONG = re.compile(r"\b(partis?|parties|disparus?|plus de contr\w*|plus personne|plus rien|plus la|ras|rien a signaler|"
                             r"fausse alerte|c est bon|cest bon|termine|fini|ils sont plus|y a plus|y en a plus|ya plus)\b")
# « se dirigent vers Renens-Gare » : sans ligne, l'arrêt visé est l'endroit où ils vont à pied
RE_HEADING = re.compile(r"\b(se dirig\w*|vont vers|va vers|marchent vers|marche vers|en route vers|en chemin vers)\b")
# hors sujet : un fait d'hier, ou un long message sans un mot de contrôle ni de transport
RE_PAST = re.compile(r"\b(hier|avant hier|la semaine derniere|l autre jour)\b")
RE_CUE = re.compile(r"\b(contr\w*|agents?|bleus?|equipes?|team|groupe de|arrets?|metro|bus|tram|train|lignes?|direction|dir|vers|"
                    r"quai|monte\w*|descend\w*|sort\w*|pose\w*|chill\w*|attend\w*|schtroumpf\w*|civils?|uniformes?|gilets?|"
                    r"panne\w*|retard\w*|accident\w*|devi\w*|perturb\w*|bloque\w*|partis?)\b")
# tiret entre deux mots, avec une espace (« M2 fourmis- ouchy ») : un sens ; « Ouchy-Olympique » reste un nom
RE_DASH = re.compile(r"([^\W\d_])\s*[-\u2013\u2014]\s+(?=[^\W\d_])|([^\W\d_])\s+[-\u2013\u2014]\s*(?=[^\W\d_])")
RE_RESTORED = re.compile(r"\b(retabli\w*|reprise|circule a nouveau|circulent a nouveau|resolu\w*|repart\w*)\b")
RE_PERT = [
    ("panne", re.compile(r"\b(panne\w*|en rade|hs|hors service)\b")),
    ("accident", re.compile(r"\b(accident\w*|collision)\b")),
    ("deviation", re.compile(r"\b(devi\w*|detour\w*|ne dessert pas|non desservi\w*|travaux)\b")),
    ("retard", re.compile(r"\b(retard\w*|bouchon\w*|bloque\w*|interromp\w*|supprime\w*|annule\w*|ne passe pas|ne circule)\b")),
    ("bonde", re.compile(r"\b(bonde\w*|plein a craquer|blinde\w*)\b")),
    ("autre", re.compile(r"\b(perturb\w*|incident\w*|manif\w*)\b")),
]
RE_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿]")
RE_TIME = re.compile(r"\b\d{1,2}\s?[:hH]\s?\d{2}\b")


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[’'`´]", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def tokens(s: str, keep_filler: bool = False) -> list[str]:
    # « saint » et « st » : un même mot (« Saint-François », « direction saint François », « St-Sulpice »)
    t = [{"saint": "st", "sainte": "ste"}.get(w, w) for w in normalize(s).split(" ") if w]
    return t if keep_filler else [w for w in t if w not in FILLER]


class Gazetteer:
    def __init__(self, stops: list[dict]):
        self.exact: dict[str, str] = {}
        self.same: dict[str, list[str]] = {}   # tous les arrêts d'un même nom (homonymes), dans l'ordre
        self.single: list[tuple[str, str]] = []
        self.multi: dict[str, list[tuple[str, str, int]]] = {}   # mot → noms de plusieurs mots qui le contiennent
        self.by_id: dict[str, dict] = {}
        self.max_len = 1
        for s in stops:
            self.by_id[s["id"]] = s
            # nom court partagé par plusieurs arrêts (« Gare », « Centre ») : jamais seul, seulement avec la commune
            names = [s.get("name"), None if s.get("amb") else s.get("short")] + list(s.get("alias") or [])
            for n in filter(None, names):
                t = tokens(n)
                if not t:
                    continue
                key = " ".join(t)
                self.exact.setdefault(key, s["id"])
                if s["id"] not in self.same.setdefault(key, []):
                    self.same[key].append(s["id"])
                self.max_len = max(self.max_len, len(t))
                if len(t) == 1 and len(t[0]) >= 5:
                    self.single.append((t[0], s["id"]))
                if len(t) >= 2:
                    for w in dict.fromkeys(t):
                        lst = self.multi.setdefault(w, [])
                        if not any(x[0] == key for x in lst):
                            lst.append((key, s["id"], len(t)))
        self.max_len = min(self.max_len, 5)


def _lev(a: str, b: str, mx: int) -> int:
    if abs(len(a) - len(b)) > mx:
        return mx + 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        best = i
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
            best = min(best, cur[j])
        if best > mx:
            return mx + 1
        prev = cur
    return prev[len(b)]


def _find_stops(tok: list[str], gaz: Gazetteer) -> list[dict]:
    hits, used = [], [False] * len(tok)
    for n in range(gaz.max_len, 0, -1):
        for i in range(0, len(tok) - n + 1):
            if any(used[i:i + n]):
                continue
            key = " ".join(tok[i:i + n])
            sid = gaz.exact.get(key)
            if sid:
                hits.append({"id": sid, "i": i, "n": n, "fuzzy": False, "key": key})
                for k in range(i, i + n):
                    used[k] = True
    # faute de frappe dans un nom de plusieurs mots (« st frnçois », « halle de sebeillons ») : au moins un mot exact,
    # et une lettre d'écart (deux pour un nom de 12 lettres ou plus) sur l'ensemble
    for n in range(min(gaz.max_len, 4), 1, -1):
        for i in range(0, len(tok) - n + 1):
            if any(used[i:i + n]):
                continue
            ws = tok[i:i + n]
            if any(w in NOT_STOPS or w in DIR_WORDS or re.search(r"\d", w) for w in ws):
                continue
            key = " ".join(ws)
            if len(key) < 7:
                continue
            mx = 2 if len(key) >= 12 else 1
            best = None
            for w in dict.fromkeys(ws):
                for cand, sid, ln in gaz.multi.get(w, []):
                    if ln != n:
                        continue
                    d = _lev(key, cand, mx)
                    if 0 < d <= mx and (best is None or d < best[0]):
                        best = (d, sid, cand)
            if best:
                hits.append({"id": best[1], "i": i, "n": n, "fuzzy": True, "key": best[2]})
                for k in range(i, i + n):
                    used[k] = True
    for i, w in enumerate(tok):
        if used[i] or len(w) < 5 or w in NOT_STOPS or re.search(r"\d", w):
            continue
        mx = 2 if len(w) >= 8 else 1
        best = None
        for alias, sid in gaz.single:
            d = _lev(w, alias, mx)
            if d <= mx and (best is None or d < best[0]):
                best = (d, sid)
        if best:
            hits.append({"id": best[1], "i": i, "n": 1, "fuzzy": True})
            used[i] = True
    hits.sort(key=lambda h: h["i"])
    # sens : « direction » juste avant, ou un peu avant si un nom de plusieurs mots commence par un mot inconnu
    # (« direction prilly Marley ») ; un autre arrêt, un chiffre ou un mot courant coupe
    cover = [-1] * len(tok)
    for k, h in enumerate(hits):
        for j in range(h["i"], h["i"] + h["n"]):
            cover[j] = k
    for h in hits:
        h["is_direction"] = False
        for j in range(h["i"] - 1, max(0, h["i"] - 3) - 1, -1):
            if tok[j] in DIR_WORDS:
                h["is_direction"] = True
                break
            if cover[j] >= 0 or tok[j] in NOT_STOPS or tok[j] in DIR_BREAK or re.search(r"\d", tok[j]):
                break
    return hits


def find_line(norm: str) -> str | None:
    m = RE_METRO.search(norm)
    if m:
        return "M" + m.group(1)
    if RE_LEB.search(norm):
        return "LEB"
    m = RE_LINE.search(norm)
    if m and int(m.group(1)) > 0:
        return str(int(m.group(1)))
    m = RE_LINE_DIR.search(norm)
    if m and int(m.group(1)) > 0:
        return str(int(m.group(1)))
    return None


def parse_message(text: str, gaz: Gazetteer) -> dict:
    raw = str(text or "")
    prepared = RE_TIME.sub(" ", raw)
    # flèches, dont l'émoji ➡️ des messages du bot de signalement anonyme ; 🚌 🚇 🚊 : lignes concernées
    prepared = re.sub("->|→|=>|>|[\u27A1\u2B95\u2794\u279C\u279D\u279E\u21D2\u27F6]\uFE0F?", " direction ", prepared)
    prepared = RE_DASH.sub(lambda m: (m.group(1) or m.group(2)) + " direction ", prepared)
    prepared = re.sub("[\U0001F68C\U0001F68D\U0001F68E\U0001F687\U0001F688\U0001F68A\U0001F683\U0001F68B]\uFE0F?", " ligne ", prepared)
    norm = normalize(prepared)
    tok = tokens(prepared)
    hits = _find_stops(tok, gaz)
    line = find_line(norm)

    # deux arrêts du même nom : celui que dessert la ligne citée (« LEB Bel-Air » : la gare du LEB)
    def serves(sid):
        return line in (gaz.by_id.get(sid, {}).get("lines") or [])

    def on_line(h):
        if not h or not line or not h.get("key") or serves(h["id"]):
            return h
        alt = next((sid for sid in gaz.same.get(h["key"], []) if serves(sid)), None)
        return {**h, "id": alt} if alt else h

    loc_hit = next((h for h in hits if not h["is_direction"]), None)
    dir_hit = next((h for h in hits if h["is_direction"]), None)
    if not loc_hit and dir_hit and not line and RE_HEADING.search(norm):
        loc_hit, dir_hit = dir_hit, None
    loc, dirh = on_line(loc_hit), on_line(dir_hit)

    kind, sub, of = "controle", None, None
    ends_with_q = re.search(r"\?[\s\W]*$", RE_EMOJI.sub("", raw)) is not None
    words = len(norm.split(" ")) if norm else 0
    off_topic = bool(RE_PAST.search(norm)) or (words >= 12 and not line and not dirh and not RE_CUE.search(norm))
    stop_id = loc["id"] if loc else None
    if ends_with_q or ("?" in raw and RE_QUESTION.search(norm)):
        kind = "question"
    elif off_topic:
        kind = "autre"
    elif RE_RESTORED.search(norm):
        kind, of = "fin", "perturbation"
    elif RE_CLEAR.search(norm) and (RE_CLEAR_STRONG.search(norm) or not stop_id):
        kind, of = "fin", "controle"
    else:
        for k, rx in RE_PERT:
            if rx.search(norm):
                kind, sub = "perturbation", k
                break
    return {
        "kind": kind, "sub": sub, "of": of,
        "stop_id": stop_id,
        "dir_stop_id": dirh["id"] if dirh else None,
        "line": line,
        "fuzzy": bool(loc and loc["fuzzy"]),
        "usable": kind not in ("question", "autre") and stop_id is not None,
    }


# ---------- sens de circulation (comme resolveDirection dans core/vigie-core.js) ----------
def directions_at(lines: dict, line: str, stop_id: str) -> list[tuple[str, int]]:
    """Sens (identifiant, rang de l'arrêt) où l'on peut partir de cet arrêt sur cette ligne : pas celui dont l'arrêt
    est le terminus ; deux branches vers le même terminus : la première (la plus fréquente)."""
    out, seen = [], set()
    for d in lines.get(line, {}).get("dirs", []):
        to = d.get("to") or d["stops"][-1]
        if stop_id not in d["stops"] or to == stop_id or to in seen:
            continue
        i = d["stops"].index(stop_id)
        if i < len(d["stops"]) - 1:
            out.append((d["id"], i))
            seen.add(to)
    return out


def resolve_direction(lines: dict, stop_lines: list, stop_id: str, dir_stop_id: str, line: str | None):
    """« … direction X » : {line, dir, seq} si X vient après l'arrêt sur une seule ligne, sinon None.
    lines : {id_ligne: {"dirs": [{"id", "stops"}]}} (collector/lignes.json)."""
    if not stop_id or not dir_stop_id or stop_id == dir_stop_id:
        return None
    found = []
    def end(d):
        return d.get("to") or d["stops"][-1]

    for l in [line] if line else (stop_lines or []):
        dirs = lines[l]["dirs"]
        for did, seq in directions_at(lines, l, stop_id):
            d = next(x for x in dirs if x["id"] == did)
            if dir_stop_id in d["stops"][seq + 1:]:
                # part des courses : celles des branches vers ce terminus qui passent ici (comme directionsAt)
                share = sum(x.get("share", 1) for x in dirs
                            if end(x) == end(d) and stop_id in x["stops"][:-1] and end(x) != stop_id)
                found.append({"line": l, "dir": did, "seq": seq, "to": end(d), "grp": d.get("grp"), "share": share})
    if len({f["line"] for f in found}) != 1:
        return None

    def out(f):
        return {"line": f["line"], "dir": f["dir"], "seq": f["seq"]}
    if len(found) == 1:
        return out(found[0])
    # plusieurs sens passent par X (courses partielles, branches) : celui qui y finit ; sinon, s'ils vont tous du
    # même côté (même sens de circulation), le plus fréquent
    ends = [f for f in found if f["to"] == dir_stop_id]
    if len(ends) == 1:
        return out(ends[0])
    if all(f["grp"] is not None and f["grp"] == found[0]["grp"] for f in found):
        return out(max(found, key=lambda f: f["share"]))
    return {"line": found[0]["line"], "dir": None, "seq": None}
