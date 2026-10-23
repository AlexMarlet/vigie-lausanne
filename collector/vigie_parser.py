"""
Vigie — parseur de messages (portage Python de core/vigie-core.js).

Transforme un message libre du groupe Telegram en signalement structuré :
    {"kind": "controle"|"perturbation"|"fin"|"question",
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

COUNT_WORDS = ("controleurs?|controleuses?|agents?|mecs?|gars|types?|personnes?|bleus?|schtroumpfs?|"
               "minutes?|min|mn|fois|chf|francs?|ans|avril")

RE_METRO = re.compile(r"\b(?:m|metro)\s?([123])\b")
RE_LINE = re.compile(r"\b(?:ligne|lignes|bus|trolley|trolleybus|l|n|no|num|numero|le|du|dans le)\s?(\d{1,2})\b"
                     r"(?!\s(?:" + COUNT_WORDS + r")\b)")
RE_LINE_DIR = re.compile(r"(?:^|\s)(\d{1,2})\s(?:direction|dir|vers)\b")

RE_QUESTION = re.compile(r"\b(qqn|quelqu un|quelquun|y a t il|y a t|ya t il|est ce qu|savez|sait on|des nouvelles|vous avez vu|dispo)\b")
RE_CLEAR = re.compile(r"\b(partis?|parties|descendus?|descendues?|sortis?|disparus?|plus de contr\w*|plus personne|plus rien|plus la|"
                      r"ras|rien a signaler|fausse alerte|c est bon|cest bon|termine|fini|ils sont plus|y a plus|y en a plus|ya plus)\b")
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
    t = [w for w in normalize(s).split(" ") if w]
    return t if keep_filler else [w for w in t if w not in FILLER]


class Gazetteer:
    def __init__(self, stops: list[dict]):
        self.exact: dict[str, str] = {}
        self.single: list[tuple[str, str]] = []
        self.by_id: dict[str, dict] = {}
        self.max_len = 1
        for s in stops:
            self.by_id[s["id"]] = s
            names = [s.get("name"), s.get("short")] + list(s.get("alias") or [])
            for n in filter(None, names):
                t = tokens(n)
                if not t:
                    continue
                key = " ".join(t)
                self.exact.setdefault(key, s["id"])
                self.max_len = max(self.max_len, len(t))
                if len(t) == 1 and len(t[0]) >= 5:
                    self.single.append((t[0], s["id"]))
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
            sid = gaz.exact.get(" ".join(tok[i:i + n]))
            if sid:
                hits.append({"id": sid, "i": i, "n": n, "fuzzy": False})
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
    for h in hits:
        h["is_direction"] = h["i"] > 0 and tok[h["i"] - 1] in DIR_WORDS
    return hits


def find_line(norm: str) -> str | None:
    m = RE_METRO.search(norm)
    if m:
        return "M" + m.group(1)
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
    prepared = re.sub(r"->|→|=>|>", " direction ", prepared)
    norm = normalize(prepared)
    tok = tokens(prepared)
    hits = _find_stops(tok, gaz)
    loc = next((h for h in hits if not h["is_direction"]), None)
    dirh = next((h for h in hits if h["is_direction"]), None)
    line = find_line(norm)

    kind, sub, of = "controle", None, None
    ends_with_q = re.search(r"\?[\s\W]*$", RE_EMOJI.sub("", raw)) is not None
    if ends_with_q or ("?" in raw and RE_QUESTION.search(norm)):
        kind = "question"
    elif RE_RESTORED.search(norm):
        kind, of = "fin", "perturbation"
    elif RE_CLEAR.search(norm):
        kind, of = "fin", "controle"
    else:
        for k, rx in RE_PERT:
            if rx.search(norm):
                kind, sub = "perturbation", k
                break
    stop_id = loc["id"] if loc else None
    return {
        "kind": kind, "sub": sub, "of": of,
        "stop_id": stop_id,
        "dir_stop_id": dirh["id"] if dirh else None,
        "line": line,
        "fuzzy": bool(loc and loc["fuzzy"]),
        "usable": kind != "question" and stop_id is not None,
    }
