"""python3 test_parser.py — mêmes cas que core/test-core.js (core/parser-cases.json)."""
import json
import pathlib
import sys

from vigie_parser import Gazetteer, parse_message

HERE = pathlib.Path(__file__).parent
CASES = json.loads((HERE.parent / "core" / "parser-cases.json").read_text(encoding="utf-8"))
gaz = Gazetteer(json.loads((HERE / "stops.json").read_text(encoding="utf-8")))
KEYS = {"stopId": "stop_id", "dirStopId": "dir_stop_id"}

bad = 0
for c in CASES:
    r = parse_message(c["msg"], gaz)
    diffs = {k: (r[KEYS.get(k, k)], v) for k, v in c["exp"].items() if r[KEYS.get(k, k)] != v}
    if diffs:
        bad += 1
        print("✗", c["msg"], "→", diffs)
print(f"parseur Python : {len(CASES) - bad}/{len(CASES)} OK")

# sens déduit de « direction X » (même logique que resolveDirection en JavaScript)
from vigie_parser import resolve_direction  # noqa: E402
LINES = {l["id"]: l for l in json.loads((HERE / "lignes.json").read_text(encoding="utf-8"))}
for text, exp in (("🚨 Contrôleurs au Flon direction Ouchy", ("M2", "ouchy")),
                  ("Contrôle en civil EPFL quai direction Renens 10h45", ("M1", "renens")),
                  ("Contrôle M1 UNIL Sorge → EPFL", ("M1", "renens"))):
    p = parse_message(text, gaz)
    way = resolve_direction(LINES, gaz.by_id[p["stop_id"]]["lines"], p["stop_id"], p["dir_stop_id"], p["line"])
    got = (way["line"], way["dir"]) if way else None
    if got != exp:
        bad += 1
        print("✗ sens", text, "→", got, "attendu", exp)
print("sens déduits : " + ("OK" if not bad else "échec"))
sys.exit(1 if bad else 0)
