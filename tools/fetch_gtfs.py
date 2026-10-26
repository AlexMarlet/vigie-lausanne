"""
Télécharge le dernier horaire officiel suisse au format GTFS (opentransportdata.swiss).

    python3 tools/fetch_gtfs.py gtfs.zip

Le jeu de données change chaque année au changement d'horaire de décembre (2e dimanche) :
« timetable-2026-gtfs2020 » jusqu'au 12.12.2026, puis « timetable-2027-gtfs2020 ». Le fichier le plus récent
est trouvé par l'API CKAN du portail (mis à jour deux fois par semaine). Lancé par GitHub Actions.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import shutil
import sys
import urllib.request

PORTAL = "https://data.opentransportdata.swiss"
UA = {"User-Agent": "vigie-lausanne (https://github.com/AlexMarlet/vigie-lausanne)"}


def timetable_year(today: dt.date) -> int:
    """Année d'horaire : à partir du 2e dimanche de décembre, c'est l'horaire de l'année suivante."""
    first = dt.date(today.year, 12, 1)
    second_sunday = first + dt.timedelta(days=(6 - first.weekday()) % 7 + 7)
    return today.year + 1 if today >= second_sunday else today.year


def get_json(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def newest_zip(year: int) -> tuple[str, str]:
    """(nom, url) du zip GTFS le plus récent du jeu de données de l'année."""
    pkg = get_json(f"{PORTAL}/api/3/action/package_show?id=timetable-{year}-gtfs2020")["result"]
    zips = [r for r in pkg.get("resources", []) if str(r.get("url", "")).lower().split("?")[0].endswith(".zip")
            or str(r.get("format", "")).lower() == "zip"]
    if not zips:
        raise RuntimeError(f"aucun zip dans timetable-{year}-gtfs2020")

    def key(r):
        # date dans le nom (GTFS_FP2026_20261022.zip ou GTFS_FP2026_2026-10-22.zip), sinon date de création
        m = re.search(r"(20\d\d)-?(\d\d)-?(\d\d)(?!\d)", str(r.get("name") or r.get("url")))
        return (m.group(1) + m.group(2) + m.group(3)) if m else str(r.get("created", ""))[:10].replace("-", "")
    best = max(zips, key=key)
    return str(best.get("name") or best["url"].rsplit("/", 1)[-1]), best["url"]


def main() -> None:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "gtfs.zip")
    year = timetable_year(dt.date.today())
    last_error = None
    for y in (year, year - 1 if year > dt.date.today().year else year + 1):
        try:
            name, url = newest_zip(y)
        except Exception as exc:  # jeu de données pas encore publié, portail indisponible…
            last_error = exc
            continue
        print(f"GTFS : {name} ({url})", flush=True)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, out.open("wb") as f:
            shutil.copyfileobj(r, f, length=1 << 20)
        size = out.stat().st_size // (1 << 20)
        print(f"::notice title=GTFS::{name} téléchargé ({size} Mo)", flush=True)
        pathlib.Path(str(out) + ".name").write_text(name, encoding="utf-8")
        return
    raise SystemExit(f"::error title=GTFS::téléchargement impossible : {last_error}")


if __name__ == "__main__":
    main()
