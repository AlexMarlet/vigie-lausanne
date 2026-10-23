"""
Construit stops.json (arrêts + alias) à partir du GTFS officiel suisse.

1. Télécharge le dernier zip GTFS sur https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020
   (fichiers GTFS_FP2026_AAAAMMJJ.zip, mis à jour deux fois par semaine).
2. python build_stops.py GTFS_FP2026_xxxxxxxx.zip
   options : --agency "lausann"   ne garder que les arrêts desservis par ces opérateurs (plus lent : lit stop_times.txt)
             --bbox 6.50,46.48,6.76,46.60   (lon_min,lat_min,lon_max,lat_max — Grand Lausanne par défaut)

Le résultat remplace stops.json (collecteur) et alimente la carte de l'app.
Les alias "maison" (argot du groupe : « st f », « poly », « blech »…) sont repris de aliases_extra.json
(clé = nom court de l'arrêt, ex. "St-François").
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import re
import unicodedata
import zipfile

HERE = pathlib.Path(__file__).parent


def slug(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def read_csv(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def served_stop_ids(z: zipfile.ZipFile, agency_pattern: str) -> set[str]:
    rx = re.compile(agency_pattern, re.I)
    agencies = {a["agency_id"] for a in read_csv(z, "agency.txt") if rx.search(a.get("agency_name", ""))}
    routes = {r["route_id"] for r in read_csv(z, "routes.txt") if r.get("agency_id") in agencies}
    trips = {t["trip_id"] for t in read_csv(z, "trips.txt") if t["route_id"] in routes}
    served = set()
    for st in read_csv(z, "stop_times.txt"):          # gros fichier : lecture en flux
        if st["trip_id"] in trips:
            served.add(st["stop_id"])
    return served


def aliases_for(name: str) -> list[str]:
    """'Lausanne, Chauderon' -> ['Chauderon', 'Lausanne Chauderon']; 'Renens VD, 14 Avril' -> ['14 Avril', 'Renens 14 Avril']"""
    out = []
    if "," in name:
        town, stop = [p.strip() for p in name.split(",", 1)]
        town = re.sub(r"\s+(VD|GE|FR|VS|NE)$", "", town)
        out += [stop, f"{town} {stop}"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("gtfs_zip")
    ap.add_argument("--bbox", default="6.50,46.48,6.76,46.60")
    ap.add_argument("--agency", default=None, help="regex sur agency_name, ex. 'lausann'")
    ap.add_argument("--out", default=str(HERE / "stops.json"))
    a = ap.parse_args()
    x0, y0, x1, y1 = map(float, a.bbox.split(","))

    with zipfile.ZipFile(a.gtfs_zip) as z:
        served = served_stop_ids(z, a.agency) if a.agency else None
        rows = list(read_csv(z, "stops.txt"))

    by_id = {r["stop_id"]: r for r in rows}
    stations: dict[str, dict] = {}
    for r in rows:
        try:
            lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except (KeyError, ValueError):
            continue
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        if served is not None and r["stop_id"] not in served:
            continue
        parent_id = r.get("parent_station") or r["stop_id"]
        parent = by_id.get(parent_id, r)
        key = parent.get("stop_name", r["stop_name"])
        st = stations.setdefault(key, {"name": key, "pts": [], "gtfs": set()})
        st["pts"].append((lat, lon))
        st["gtfs"].add(parent_id)

    extra_path = HERE / "aliases_extra.json"
    extra = json.loads(extra_path.read_text(encoding="utf-8")) if extra_path.exists() else {}

    out, used = [], set()
    for name, st in sorted(stations.items()):
        lat = sum(p[0] for p in st["pts"]) / len(st["pts"])
        lon = sum(p[1] for p in st["pts"]) / len(st["pts"])
        sid = slug(name)
        while sid in used:
            sid += "-b"
        used.add(sid)
        alias = aliases_for(name)
        short = alias[0] if alias else None
        alias += extra.get(name, []) + extra.get(short or "", [])
        out.append({"id": sid, "name": name, "short": short, "lat": round(lat, 6), "lon": round(lon, 6),
                    "alias": sorted(set(alias)), "gtfs": sorted(st["gtfs"])})

    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"{len(out)} arrêts écrits dans {a.out}")


if __name__ == "__main__":
    main()
