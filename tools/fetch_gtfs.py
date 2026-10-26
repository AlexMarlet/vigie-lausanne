"""
Télécharge le dernier horaire officiel suisse au format GTFS.

    python3 tools/fetch_gtfs.py gtfs.zip

Sources, dans l'ordre :
1. opentransportdata.swiss (producteur officiel) : lien permanent vers le dernier fichier, puis API CKAN du
   portail. Le jeu de données change chaque année au changement d'horaire de décembre (2e dimanche) :
   « timetable-2026-gtfs2020 » jusqu'au 12.12.2026, puis « timetable-2027-gtfs2020 ».
2. gtfs.geops.ch : copie quotidienne des mêmes données, période d'horaire en cours.
Le nom de la source retenue est écrit dans gtfs.zip.name. Lancé par GitHub Actions.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import shutil
import sys
import urllib.request
import zipfile

PORTAL = "https://data.opentransportdata.swiss"
GEOPS = "https://gtfs.geops.ch/dl/gtfs_complete.zip"
UA = {"User-Agent": "Mozilla/5.0 (compatible; vigie-lausanne/1.0; +https://github.com/AlexMarlet/vigie-lausanne)",
      "Accept": "*/*"}


def timetable_year(today: dt.date) -> int:
    """Année d'horaire : à partir du 2e dimanche de décembre, c'est l'horaire de l'année suivante."""
    first = dt.date(today.year, 12, 1)
    second_sunday = first + dt.timedelta(days=(6 - first.weekday()) % 7 + 7)
    return today.year + 1 if today >= second_sunday else today.year


def open_url(url: str, timeout: int = 60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


def ckan_newest_zip(year: int) -> str:
    with open_url(f"{PORTAL}/api/3/action/package_show?id=timetable-{year}-gtfs2020") as r:
        pkg = json.load(r)["result"]
    zips = [x for x in pkg.get("resources", []) if str(x.get("url", "")).lower().split("?")[0].endswith(".zip")]
    if not zips:
        raise RuntimeError("aucun zip dans le jeu de données")

    def key(x):
        m = re.search(r"(20\d\d)-?(\d\d)-?(\d\d)(?!\d)", str(x.get("name") or x.get("url")))
        return (m.group(1) + m.group(2) + m.group(3)) if m else str(x.get("created", ""))[:10].replace("-", "")
    return max(zips, key=key)["url"]


def download(url: str, out: pathlib.Path) -> str:
    """Télécharge et vérifie que c'est bien un GTFS ; renvoie le nom du fichier final."""
    with open_url(url, timeout=900) as r, out.open("wb") as f:
        final = r.geturl()
        shutil.copyfileobj(r, f, length=1 << 20)
    with zipfile.ZipFile(out) as z:
        missing = {"stops.txt", "stop_times.txt", "trips.txt", "routes.txt"} - set(z.namelist())
        if missing:
            raise RuntimeError(f"zip incomplet ({', '.join(sorted(missing))} manquant)")
    return final.rsplit("/", 1)[-1].split("?")[0] or url


def main() -> None:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "gtfs.zip")
    year = timetable_year(dt.date.today())
    sources = [
        (f"opentransportdata {year} (lien permanent)", lambda: f"{PORTAL}/dataset/timetable-{year}-gtfs2020/permalink"),
        (f"opentransportdata {year} (API)", lambda: ckan_newest_zip(year)),
        ("gtfs.geops.ch (copie quotidienne)", lambda: GEOPS),
    ]
    for label, get_url in sources:
        try:
            name = download(get_url(), out)
        except Exception as exc:
            print(f"::warning title=GTFS::{label} : {type(exc).__name__} {exc}", flush=True)
            continue
        size = out.stat().st_size // (1 << 20)
        print(f"::notice title=GTFS::{label} : {name} ({size} Mo)", flush=True)
        pathlib.Path(str(out) + ".name").write_text(f"{name} ({label.split(' ')[0]})", encoding="utf-8")
        return
    sys.exit("::error title=GTFS::aucune source n'a répondu")


if __name__ == "__main__":
    main()
