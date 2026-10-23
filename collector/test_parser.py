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
sys.exit(1 if bad else 0)
