"""
Construit tools/reseau.json : le réseau tl (arrêts, lignes, sens, ordre des arrêts, temps de parcours)
à partir de l'horaire officiel suisse au format GTFS (opentransportdata.swiss).

    python3 tools/fetch_gtfs.py gtfs.zip       # dernier GTFS (GitHub Actions le fait chaque semaine)
    python3 tools/build_network.py gtfs.zip    # -> tools/reseau.json

Méthode
- Lignes : celles des opérateurs tl (voir TL_AGENCY), circulant pendant la période de référence
  (14 jours à partir d'aujourd'hui).
- Arrêts : les zones d'arrêt (parent_station) desservies ; une même zone sous deux noms officiels proches
  (« Lausanne-Flon » métro et « Lausanne, Flon » bus) est fusionnée.
- Sens : pour chaque ligne, les parcours réguliers (≥ 10 % des courses de leur sens). Un parcours compris
  dans un plus long (course partielle) est ignoré ; une branche vers un autre terminus devient un sens à part.
- Temps : médiane, entre deux arrêts, des écarts de départ des courses du parcours.
- Identifiants : ceux de tools/arrets.json (arrêts historiques, retrouvés par position) sinon dérivés du nom.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import io
import json
import math
import pathlib
import re
import statistics
import sys
import unicodedata
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "reseau.json"
ARRETS = ROOT / "tools" / "arrets.json"

TL_AGENCY = re.compile(r"r[ée]gion lausannoise|^tl\b|\(tl\)", re.I)
MIN_SHARE = 0.10          # part minimale des courses d'un sens pour qu'un parcours compte
MERGE_M = 300             # fusion de deux zones d'arrêt de même nom à moins de 300 m
LEGACY_M = 350            # un arrêt historique est retrouvé à moins de 350 m
CANTONS = r"\s+(?:VD|GE|FR|VS|NE|JU|BE)$"
COLORS = {"M1": "#2B6CB0", "M2": "#7A4FC0", "M3": "#2F8F6B", "t1": "#C2410C"}


# ------------------------------------------------------------------ outils
def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def slug(s: str) -> str:
    return norm(s).replace(" ", "-")


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    la = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * math.cos(la))


def rows(z: zipfile.ZipFile, name: str):
    """Lecture en flux d'un fichier du zip : (index des colonnes, itérateur de lignes)."""
    if name not in z.namelist():
        return {}, iter(())
    f = io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline="")
    r = csv.reader(f)
    head = next(r, [])
    return {h.strip(): i for i, h in enumerate(head)}, r


def seconds(t: str) -> int | None:
    try:
        h, m, s = t.strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except (ValueError, AttributeError):
        return None


def line_type(route_type: str, short: str) -> str:
    try:
        t = int(route_type)
    except ValueError:
        t = -1
    if t == 1 or 400 <= t <= 405 or re.fullmatch(r"M\d", short):
        return "metro"
    if t == 0 or 900 <= t <= 906:
        return "tram"
    if t == 2 or 100 <= t <= 117:
        return "train"
    if t in (6, 7) or 1300 <= t <= 1400:
        return "funiculaire"
    return "bus"


def line_sort_key(short: str):
    m = re.fullmatch(r"([A-Za-z]*)(\d*)([A-Za-z]*)", short)
    prefix, num, suffix = (m.groups() if m else (short, "", ""))
    group = 0 if prefix == "M" else 1 if prefix in ("", "t") and num else 2
    return (group, prefix, int(num) if num else 0, suffix)


def split_name(name: str, towns: set[str]) -> tuple[str, str]:
    """« Lausanne, Riponne-M. Béjart » -> (« Lausanne », « Riponne-M. Béjart »)."""
    if "," in name:
        town, short = (p.strip() for p in name.split(",", 1))
        return re.sub(CANTONS, "", town), short
    clean = re.sub(CANTONS, "", name.strip())
    for t in sorted(towns, key=len, reverse=True):
        if clean.startswith(t + "-") and len(clean) > len(t) + 1:
            return t, clean[len(t) + 1:]
    return clean, clean


def cap(s: str) -> str:
    return s[:1].upper() + s[1:]


# ------------------------------------------------------------------ calendrier
def active_days(z: zipfile.ZipFile, services: set[str], start: dt.date, days: int) -> dict[str, int]:
    """Nombre de jours de circulation de chaque service pendant la période de référence."""
    window = [start + dt.timedelta(days=i) for i in range(days)]
    keys = {d.strftime("%Y%m%d"): d for d in window}
    on: dict[str, set[str]] = collections.defaultdict(set)
    col, it = rows(z, "calendar.txt")
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for r in it:
        sid = r[col["service_id"]]
        if sid not in services:
            continue
        a, b = r[col["start_date"]], r[col["end_date"]]
        for k, d in keys.items():
            if a <= k <= b and r[col[wd[d.weekday()]]] == "1":
                on[sid].add(k)
    col, it = rows(z, "calendar_dates.txt")
    for r in it:
        sid, k = r[col["service_id"]], r[col["date"]]
        if sid not in services or k not in keys:
            continue
        if r[col["exception_type"]] == "1":
            on[sid].add(k)
        else:
            on[sid].discard(k)
    return {sid: len(ks) for sid, ks in on.items() if ks}


def runs_per_trip(z: zipfile.ZipFile, trips: set[str]) -> dict[str, float]:
    """frequencies.txt : nombre de départs que représente une course modèle."""
    out: dict[str, float] = collections.defaultdict(float)
    col, it = rows(z, "frequencies.txt")
    for r in it:
        tid = r[col["trip_id"]]
        if tid not in trips:
            continue
        a, b, h = seconds(r[col["start_time"]]), seconds(r[col["end_time"]]), r[col["headway_secs"]]
        if a is not None and b is not None and h.isdigit() and int(h) > 0:
            out[tid] += max(1.0, (b - a) / int(h))
    return out


# ------------------------------------------------------------------ choix des parcours
def is_sub(short: tuple, long: tuple) -> bool:
    """short est-il une suite d'arrêts consécutifs de long ?"""
    n = len(short)
    return n <= len(long) and any(long[i:i + n] == short for i in range(len(long) - n + 1))


def pick_patterns(weights: dict[tuple, float]) -> list[tuple[tuple, float]]:
    """Parcours réguliers d'un sens, du plus fréquent au moins fréquent : une course partielle (comprise dans un
    parcours déjà retenu) compte pour ce parcours ; un parcours qui pèse moins de MIN_SHARE des courses
    (dépôt, course spéciale) est ignoré ; un seul parcours par terminus."""
    total = sum(weights.values())
    kept: dict[tuple, float] = {}
    for p in sorted((p for p in weights if len(p) >= 2), key=lambda p: (-weights[p], -len(p), p)):
        owners = [k for k in kept if is_sub(p, k)]
        if owners:
            kept[max(owners, key=lambda k: kept[k])] += weights[p]
        else:
            kept[p] = weights[p]
    out, termini = [], set()
    for k in sorted(kept, key=lambda k: -kept[k]):
        if not total or kept[k] / total < MIN_SHARE:
            continue
        if k[-1] in termini:            # même terminus par un autre chemin : on garde le principal
            continue
        termini.add(k[-1])
        out.append((k, kept[k] / total))
    return out


# ------------------------------------------------------------------ construction
def build(zpath: pathlib.Path, start: dt.date, days: int, legacy: list[dict]) -> dict:
    z = zipfile.ZipFile(zpath)

    # opérateurs et lignes
    col, it = rows(z, "agency.txt")
    agencies = {}
    lausanne_like = []
    for r in it:
        name = r[col["agency_name"]]
        if TL_AGENCY.search(name):
            agencies[r[col["agency_id"]]] = name
        if "lausann" in name.lower():
            lausanne_like.append(name)
    if not agencies:
        raise SystemExit(f"aucun opérateur tl trouvé (opérateurs « lausann… » : {lausanne_like})")
    col, it = rows(z, "routes.txt")
    routes = {}
    for r in it:
        if r[col["agency_id"]] not in agencies:
            continue
        short = (r[col["route_short_name"]] if "route_short_name" in col else "").strip()
        if not short:
            short = (r[col["route_long_name"]] if "route_long_name" in col else "").strip()
        if not short:
            continue
        routes[r[col["route_id"]]] = (short, r[col["route_type"]] if "route_type" in col else "",
                                      (r[col["route_color"]] if "route_color" in col else "").strip())

    # courses de la période de référence
    col, it = rows(z, "trips.txt")
    trips, services = {}, set()
    for r in it:
        rid = r[col["route_id"]]
        if rid not in routes:
            continue
        sid = r[col["service_id"]]
        services.add(sid)
        trips[r[col["trip_id"]]] = (rid, sid, (r[col["direction_id"]] if "direction_id" in col else "").strip() or "0",
                                    (r[col["trip_headsign"]] if "trip_headsign" in col else "").strip())
    days_on = active_days(z, services, start, days)
    trips = {t: v for t, v in trips.items() if days_on.get(v[1])}
    runs = runs_per_trip(z, set(trips))

    # arrêts (zones et quais)
    col, it = rows(z, "stops.txt")
    stops_raw = {}
    for r in it:
        try:
            lat, lon = float(r[col["stop_lat"]]), float(r[col["stop_lon"]])
        except ValueError:
            lat = lon = float("nan")
        stops_raw[r[col["stop_id"]]] = (r[col["stop_name"]].strip(), lat, lon,
                                        (r[col["parent_station"]] if "parent_station" in col else "").strip())

    def station(sid: str) -> str:
        parent = stops_raw.get(sid, ("", 0, 0, ""))[3]
        return parent if parent and parent in stops_raw else sid

    # horaires des courses retenues (gros fichier : lecture en flux)
    times: dict[str, list] = collections.defaultdict(list)
    col, it = rows(z, "stop_times.txt")
    i_trip, i_seq, i_stop = col["trip_id"], col["stop_sequence"], col["stop_id"]
    i_arr, i_dep = col.get("arrival_time"), col.get("departure_time")
    for r in it:
        tid = r[i_trip]
        if tid in trips:
            dep = seconds(r[i_dep]) if i_dep is not None and r[i_dep] else None
            arr = seconds(r[i_arr]) if i_arr is not None and r[i_arr] else None
            times[tid].append((int(r[i_seq]), r[i_stop], dep if dep is not None else arr))

    # zones d'arrêt desservies
    used: set[str] = set()
    trip_seq: dict[str, list[tuple[str, int | None]]] = {}
    for tid, st in times.items():
        st.sort()
        seq: list[tuple[str, int | None]] = []
        for _, sid, t in st:
            s = station(sid)
            if seq and seq[-1][0] == s:
                continue
            seq.append((s, t))
        if len(seq) >= 2:
            trip_seq[tid] = seq
            used.update(s for s, _ in seq)

    def coords(sid: str) -> tuple[float, float]:
        name, lat, lon, _ = stops_raw[sid]
        if not math.isnan(lat) and (lat or lon):
            return lat, lon
        kids = [(v[1], v[2]) for v in stops_raw.values() if v[3] == sid and not math.isnan(v[1])]
        return (sum(k[0] for k in kids) / len(kids), sum(k[1] for k in kids) / len(kids)) if kids else (0.0, 0.0)

    towns = {re.sub(CANTONS, "", stops_raw[s][0].split(",", 1)[0].strip()) for s in used if "," in stops_raw[s][0]}
    zones = []
    for sid in sorted(used):
        name = stops_raw[sid][0]
        town, short = split_name(name, towns)
        lat, lon = coords(sid)
        uic = re.sub(r"^Parent", "", sid).split(":")[0] if not sid.startswith("Parentch:") else sid[len("Parent"):]
        zones.append({"gtfs": sid, "official": name, "town": town, "short": cap(short), "lat": lat, "lon": lon, "uic": uic})

    # fusion des zones de même nom très proches
    groups: list[list[dict]] = []
    for zn in zones:
        key = (norm(zn["town"]), norm(zn["short"]))
        home = next((g for g in groups if (norm(g[0]["town"]), norm(g[0]["short"])) == key
                     and dist_m((g[0]["lat"], g[0]["lon"]), (zn["lat"], zn["lon"])) < MERGE_M), None)
        if home:
            home.append(zn)
        else:
            groups.append([zn])
    zone_to_stop: dict[str, int] = {}
    merged = []
    for gi, g in enumerate(groups):
        for zn in g:
            zone_to_stop[zn["gtfs"]] = gi
        merged.append({
            "town": g[0]["town"], "short": g[0]["short"],
            "lat": round(sum(z_["lat"] for z_ in g) / len(g), 6), "lon": round(sum(z_["lon"] for z_ in g) / len(g), 6),
            "official": sorted({z_["official"] for z_ in g}), "uic": sorted({z_["uic"] for z_ in g}),
        })

    # identifiants : historiques (par position et nom) puis dérivés du nom
    ids: dict[int, str] = {}
    for old in legacy:
        if "lat" not in old or "lon" not in old:   # entrée « alias seulement »
            continue
        names = {norm(x) for x in [old.get("name", ""), old.get("short", "")] + list(old.get("alias", [])) if x}
        best, bd = None, LEGACY_M
        for i, m in enumerate(merged):
            if i in ids:
                continue
            d = dist_m((old["lat"], old["lon"]), (m["lat"], m["lon"]))
            mine = {norm(m["short"]), norm(m["town"] + " " + m["short"])} | {norm(o) for o in m["official"]}
            share_word = any(set(a.split()) & set(b.split()) - {"lausanne", "gare"} for a in names for b in mine) \
                or any(a in b or b in a for a in names for b in mine)
            if d < bd and share_word:
                best, bd = i, d
        if best is not None:
            ids[best] = old["id"]
    by_short = collections.Counter(norm(m["short"]) for m in merged)
    taken = set(ids.values())
    for i, m in enumerate(merged):
        if i in ids:
            continue
        base = slug(m["short"]) if by_short[norm(m["short"])] == 1 else slug(m["town"] + " " + m["short"])
        cand, n = base or "arret", 2
        while cand in taken:
            cand, n = f"{base}-{n}", n + 1
        ids[i] = cand
        taken.add(cand)

    # lignes et sens
    per_line: dict[str, dict] = {}
    for tid, seq in trip_seq.items():
        rid, sid, direction, headsign = trips[tid]
        short, rtype, color = routes[rid]
        ln = per_line.setdefault(short, {"type": line_type(rtype, short), "color": color, "dirs": collections.defaultdict(dict),
                                         "times": collections.defaultdict(list), "headsigns": collections.defaultdict(collections.Counter)})
        weight = days_on[sid] * runs.get(tid, 1.0)
        pattern, stamps = [], []
        for s, t in seq:
            st = ids[zone_to_stop[s]]
            if pattern and pattern[-1] == st:      # deux zones fusionnées à la suite : un seul arrêt
                stamps[-1] = t if t is not None else stamps[-1]
                continue
            pattern.append(st)
            stamps.append(t)
        pattern = tuple(pattern)
        if len(pattern) < 2:
            continue
        ln["dirs"][direction][pattern] = ln["dirs"][direction].get(pattern, 0) + weight
        ln["headsigns"][pattern][headsign] += weight
        if all(t is not None for t in stamps):
            ln["times"][pattern].append(stamps)

    lines_out, served = [], collections.defaultdict(set)
    short_of = {ids[i]: m["short"] for i, m in enumerate(merged)}
    for short in sorted(per_line, key=line_sort_key):
        ln = per_line[short]
        dirs = []
        for direction in sorted(ln["dirs"]):
            for pattern, share in pick_patterns(ln["dirs"][direction]):
                samples = ln["times"].get(pattern, [])
                mins = [0.0]
                for k in range(1, len(pattern)):
                    gaps = [(s[k] - s[k - 1]) / 60 for s in samples if s[k] >= s[k - 1]]
                    mins.append(round(mins[-1] + (statistics.median(gaps) if gaps else 1.5), 1))
                to = pattern[-1]
                label = short_of[to]
                if pattern[0] == to:            # ligne circulaire : la destination affichée sur le véhicule
                    sign = ln["headsigns"][pattern].most_common(1)[0][0]
                    label = cap(split_name(sign, towns)[1]) if sign else label
                did = to if to not in {d["id"] for d in dirs} else f"{to}-{len(dirs) + 1}"
                dirs.append({"id": did, "to": to, "label": label, "stops": list(pattern), "min": mins,
                             "share": round(share, 2)})
        if not dirs:
            continue
        # tous les arrêts desservis par la ligne, y compris par des courses peu fréquentes
        for direction in ln["dirs"]:
            for pattern in ln["dirs"][direction]:
                for st in pattern:
                    served[st].add(short)
        color = ("#" + ln["color"]) if re.fullmatch(r"[0-9A-Fa-f]{6}", ln["color"] or "") else COLORS.get(short)
        lines_out.append({"id": short, "type": ln["type"], "color": color, "dirs": dirs})

    line_order = {l["id"]: i for i, l in enumerate(lines_out)}
    stops_out = []
    for i, m in enumerate(merged):
        sid = ids[i]
        lines = sorted(served.get(sid, ()), key=lambda l: line_order.get(l, 999))
        if not lines:
            continue
        name = m["short"] if norm(m["town"]) == "lausanne" or norm(m["town"]) == norm(m["short"]) else f"{m['town']}, {m['short']}"
        stops_out.append({"id": sid, "name": name, "short": m["short"], "town": m["town"],
                          "lat": m["lat"], "lon": m["lon"], "lines": lines, "official": m["official"], "uic": m["uic"]})
    stops_out.sort(key=lambda s: s["id"])
    legacy_ids = {o["id"] for o in legacy if "lat" in o}
    matched = sorted(set(ids.values()) & legacy_ids)
    return {
        "source": {"agencies": sorted(agencies.values()), "lausanne_agencies": sorted(set(lausanne_like)),
                   "period": [start.isoformat(), (start + dt.timedelta(days=days - 1)).isoformat()],
                   "legacy_matched": len(matched), "legacy_missing": sorted(legacy_ids - set(matched))},
        "lines": lines_out,
        "stops": stops_out,
    }


def write(net: dict, path: pathlib.Path, feed: str) -> None:
    """Une ligne JSON par ligne de bus et par arrêt : diffs lisibles dans git."""
    net["source"] = {"feed": feed, **net["source"]}
    parts = ['{\n"source": ' + json.dumps(net["source"], ensure_ascii=False) + ',\n"lines": [\n']
    parts.append(",\n".join(json.dumps(l, ensure_ascii=False, separators=(",", ":")) for l in net["lines"]))
    parts.append('\n],\n"stops": [\n')
    parts.append(",\n".join(json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in net["stops"]))
    parts.append("\n]\n}\n")
    path.write_text("".join(parts), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("gtfs", type=pathlib.Path)
    ap.add_argument("--date", type=dt.date.fromisoformat, default=dt.date.today())
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    a = ap.parse_args()
    legacy = json.loads(ARRETS.read_text(encoding="utf-8"))["arrets"] if ARRETS.exists() else []
    net = build(a.gtfs, a.date, a.days, legacy)
    feed_name = pathlib.Path(str(a.gtfs) + ".name")
    write(net, a.out, feed_name.read_text(encoding="utf-8").strip() if feed_name.exists() else a.gtfs.name)
    n_dirs = sum(len(l["dirs"]) for l in net["lines"])
    n_legacy = sum(1 for o in legacy if "lat" in o)
    print(f"::notice title=Réseau tl::{len(net['lines'])} lignes ({n_dirs} sens), {len(net['stops'])} arrêts · "
          f"opérateurs : {', '.join(net['source']['agencies'])} · arrêts historiques retrouvés : "
          f"{net['source']['legacy_matched']}/{n_legacy}"
          + (f" (manquants : {', '.join(net['source']['legacy_missing'])})" if net['source']['legacy_missing'] else ""), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # visible dans GitHub sans accès aux journaux
        import traceback
        where = " / ".join(x.strip() for x in traceback.format_exc().strip().splitlines()[-6:])
        print(f"::error title=Réseau tl::{type(exc).__name__} : {str(exc)[:300]} | {where[:700]}", flush=True)
        sys.exit(1)
