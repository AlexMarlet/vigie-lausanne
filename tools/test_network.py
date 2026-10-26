"""
python3 tools/test_network.py — teste build_network.py sur un petit GTFS fabriqué pour l'occasion
(métro à deux sens, bus avec courses partielles, branche, course de dépôt, service hors période, train d'un
autre opérateur) et le choix de l'année d'horaire de fetch_gtfs.py.
"""
import datetime as dt
import io
import json
import pathlib
import sys
import tempfile
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import build_network as bn  # noqa: E402
import fetch_gtfs  # noqa: E402

LEGACY = {s["id"]: s for s in json.loads((pathlib.Path(__file__).parent / "arrets.json").read_text(encoding="utf-8"))["arrets"]}
ok = bad = 0


def check(cond, label):
    global ok, bad
    print(("✓ " if cond else "✗ ") + label)
    ok += bool(cond)
    bad += not cond


def at(legacy_id, dlat=0.0, dlon=0.0):
    s = LEGACY[legacy_id]
    return round(s["lat"] + dlat, 6), round(s["lon"] + dlon, 6)


# zones d'arrêt : (id GTFS, nom officiel, position)
ZONES = [
    ("Parent1", "Lausanne, Ouchy-Olympique", at("ouchy")),
    ("Parent2", "Lausanne, Jordils", at("jordils")),
    ("Parent3", "Lausanne-Flon", at("flon")),                       # station du métro…
    ("Parent4", "Lausanne, Flon", at("flon", 0.0004, -0.0006)),     # … et arrêt de bus à 70 m : fusionnés
    ("Parent5", "Lausanne, Riponne-M. Béjart", at("riponne")),
    ("Parent6", "Epalinges, Croisettes", at("croisettes")),
    ("Parent10", "Prilly, Galicien", (46.5296, 6.6052)),
    ("Parent11", "Lausanne, Prélaz", at("prelaz")),
    ("Parent12", "Lausanne, Chauderon", at("chauderon")),
    ("Parent13", "Lausanne, St-François", at("stfrancois")),
    ("Parent14", "Lutry, Corniche", at("lutry")),
    ("Parent15", "Lutry, Dépôt", (46.5040, 6.6950)),
    ("Parent16", "Pully, gare", at("pully")),
    ("Parent17", "Renens VD, gare", (46.5372, 6.5788)),
    ("Parent18", "Prilly, gare", (46.5340, 6.6040)),
    ("Parent90", "Genève", (46.2101, 6.1424)),
]


def build_zip() -> pathlib.Path:
    files = {}
    files["agency.txt"] = ("agency_id,agency_name,agency_url,agency_timezone\n"
                           '"881","Transports publics de la Région lausannoise","https://t-l.ch","Europe/Zurich"\n'
                           '"11","Schweizerische Bundesbahnen SBB","https://sbb.ch","Europe/Zurich"\n')
    files["routes.txt"] = ("route_id,agency_id,route_short_name,route_long_name,route_desc,route_type\n"
                           "r-m2,881,M2,,M,401\nr-9,881,9,,B,700\nr-ic,11,IC1,,IC,102\n")
    st = ["stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station"]
    for zid, name, (lat, lon) in ZONES:
        st.append(f'{zid},"{name}",{lat},{lon},1,')
        num = zid.replace("Parent", "")
        st.append(f'{num}:0:A,"{name}",{lat},{lon},,{zid}')
        st.append(f'{num}:0:B,"{name}",{lat},{lon},,{zid}')
    files["stops.txt"] = "\n".join(st) + "\n"
    files["calendar.txt"] = ("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                             "tous,1,1,1,1,1,1,1,20251214,20261212\n"
                             "semaine,1,1,1,1,1,0,0,20251214,20261212\n"
                             "ancien,1,1,1,1,1,1,1,20240101,20241231\n")
    files["calendar_dates.txt"] = "service_id,date,exception_type\nsemaine,20261102,2\n"
    trips, times = ["route_id,service_id,trip_id,trip_headsign,direction_id"], ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"]

    def trip(tid, route, service, direction, zone_nums, gaps, headsign=""):
        trips.append(f"{route},{service},{tid},{headsign},{direction}")
        t = 8 * 3600
        for i, z in enumerate(zone_nums):
            if i:
                t += gaps[i - 1]
            hh = f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"
            times.append(f"{tid},{hh},{hh},{z}:0:{'A' if direction == '0' else 'B'},{i + 1}")

    # M2 : 10 courses par sens ; le métro s'arrête au Flon (quai du métro)
    up = [1, 2, 3, 5, 6]
    for k in range(10):
        trip(f"m2u{k}", "r-m2", "tous", "0", up, [80, 90 + k, 70, 120])
        trip(f"m2d{k}", "r-m2", "tous", "1", up[::-1], [120, 70, 90, 80])
    # bus 9 : parcours complet (8), courses partielles jusqu'au Flon (6, comptées dans le complet),
    # branche vers Pully (3), course de dépôt (1, ignorée), sens inverse (9)
    for k in range(8):
        trip(f"9a{k}", "r-9", "tous", "0", [10, 11, 12, 4, 13, 14], [120, 150, 180, 120, 300])
    for k in range(6):
        trip(f"9p{k}", "r-9", "semaine", "0", [10, 11, 12, 4], [120, 150, 180])
    for k in range(3):
        trip(f"9b{k}", "r-9", "tous", "0", [10, 11, 12, 4, 16], [120, 150, 180, 420])
    trip("9dep", "r-9", "tous", "0", [10, 11, 12, 4, 13, 14, 15], [120, 150, 180, 120, 300, 60])
    for k in range(9):
        trip(f"9r{k}", "r-9", "tous", "1", [14, 13, 4, 12, 11, 10], [300, 120, 180, 150, 120])
    # service hors période : parcours très fréquent mais ancien, à ignorer
    for k in range(30):
        trip(f"9old{k}", "r-9", "ancien", "0", [10, 18, 17], [200, 200])
    # train d'un autre opérateur
    trip("ic", "r-ic", "tous", "0", [3, 90], [3600])
    files["trips.txt"] = "\n".join(trips) + "\n"
    files["stop_times.txt"] = "\n".join(times) + "\n"
    path = pathlib.Path(tempfile.mkdtemp()) / "gtfs.zip"
    with zipfile.ZipFile(path, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return path


net = bn.build(build_zip(), dt.date(2026, 10, 26), 14, list(LEGACY.values()))
lines = {l["id"]: l for l in net["lines"]}
stops = {s["id"]: s for s in net["stops"]}

check(list(lines) == ["M2", "9"], "lignes tl seulement, M2 avant les bus (" + ", ".join(lines) + ")")
check(net["source"]["agencies"] == ["Transports publics de la Région lausannoise"], "opérateur tl reconnu, CFF ignorés")
m2 = lines["M2"]
check(m2["type"] == "metro" and lines["9"]["type"] == "bus", "types de ligne")
check(sorted(d["to"] for d in m2["dirs"]) == ["croisettes", "ouchy"], "M2 : deux sens, vers Croisettes et vers Ouchy")
up = next(d for d in m2["dirs"] if d["to"] == "croisettes")
check(up["stops"] == ["ouchy", "jordils", "flon", "riponne", "croisettes"], "M2 : ordre des arrêts")
check(up["label"] == "Epalinges, Croisettes" and up["id"] == "croisettes", "M2 : sens nommé d'après le terminus (avec la commune)")
check(up["min"][0] == 0 and up["min"][1] == 1.3 and up["min"][2] == 2.9, f"M2 : temps cumulés, médiane ({up['min']})")
nine = {d["to"]: d for d in lines["9"]["dirs"]}
check(sorted(nine) == ["galicien", "lutry", "pully"], f"bus 9 : sens principal, branche et retour ({sorted(nine)})")
check(nine["lutry"]["stops"] == ["galicien", "prelaz", "chauderon", "flon", "stfrancois", "lutry"],
      "bus 9 : parcours complet retenu malgré les courses partielles")
check(nine["lutry"]["share"] > nine["pully"]["share"] > 0.1, "bus 9 : courses partielles comptées dans le parcours complet")
check("depot" in stops and "9" in stops["depot"]["lines"], "arrêt desservi seulement par la course de dépôt : bien listé")
check(not any(d["to"] == "depot" for d in lines["9"]["dirs"]), "course de dépôt : pas un sens proposé")
check("flon" in stops and stops["flon"]["lines"] == ["M2", "9"], "Flon métro + Flon bus fusionnés, lignes M2 et 9")
check(len(stops["flon"]["official"]) == 2, "les deux noms officiels du Flon sont gardés")
check(all(i in stops for i in ("ouchy", "riponne", "croisettes", "prelaz", "chauderon", "stfrancois", "pully")),
      "identifiants historiques retrouvés par position")
check("galicien" in stops and stops["galicien"]["name"] == "Prilly, Galicien", "nouvel arrêt hors Lausanne : « Ville, Arrêt »")
check(stops["riponne"]["name"] == "Riponne-M. Béjart", "arrêt lausannois : nom court")
check("renens-gare" not in stops and "genève" not in stops and "geneve" not in stops,
      "arrêts desservis seulement hors période ou par un autre opérateur : absents")
check(stops["pully"]["name"] == "Pully, Gare", "minuscule initiale corrigée (gare -> Gare)")

check(bn.line_id("m1") == "M1" and bn.line_id("N3") == "N3", "noms de ligne : m1 -> M1, N3 inchangé")
check(bn.split_name("Chavannes-R., UNIL-Mouline", set()) == ("Chavannes", "UNIL-Mouline")
      and bn.split_name("Ecublens VD, EPFL", set()) == ("Ecublens", "EPFL"), "communes : abréviations et canton retirés")

# choix des parcours, quel que soit l'ordre de lecture (cas relevés en relecture)
P = bn.pick_patterns
A_Z, B_Z, A_M = tuple("abcdefz"), tuple("bcdefz"), tuple("abcd")
A_ZD = A_Z + ("depot",)
got = P({A_Z: 40, B_Z: 60})
check([g[0] for g in got] == [A_Z] and abs(got[0][1] - 1) < 1e-9, "course partielle plus fréquente vers le même terminus : parcours complet")
check([g[0] for g in P({A_Z: 30, A_M: 60})] == [A_Z], "courte plus fréquente : comptée dans le parcours complet, pas un sens à part")
check([g[0] for g in P({A_Z: 16, A_ZD: 2})] == [A_Z], "dépôt sur 2 courses sur 18 : pas un sens")
check([g[0] for g in P({A_Z: 50, A_ZD: 50})] == [A_ZD], "rallonge régulière (50 %) : le parcours le plus long")
P1, Q1 = tuple("pxyz"), tuple("qxyz")
check(sorted(g[0] for g in P({P1: 63, Q1: 37})) == sorted([P1, Q1]), "deux branches vers le même terminus : gardées toutes les deux")
check(len(P({tuple("axp"): 64, tuple("axq"): 36})) == 2, "deux branches vers deux terminus : deux sens")
check([g[0] for g in P({A_Z: 95, tuple("abxz"): 5})] == [A_Z], "variante rare (5 %) : ignorée")

# année d'horaire (changement le 2e dimanche de décembre)
check(fetch_gtfs.timetable_year(dt.date(2026, 10, 26)) == 2026, "horaire 2026 en octobre 2026")
check(fetch_gtfs.timetable_year(dt.date(2026, 12, 12)) == 2026, "horaire 2026 le samedi 12.12.2026")
check(fetch_gtfs.timetable_year(dt.date(2026, 12, 13)) == 2027, "horaire 2027 dès le dimanche 13.12.2026")
check(fetch_gtfs.timetable_year(dt.date(2025, 12, 14)) == 2026, "horaire 2026 dès le 14.12.2025")

print(f"\n{ok} OK, {bad} échec(s)")
sys.exit(1 if bad else 0)
