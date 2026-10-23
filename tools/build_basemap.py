"""
Fond de carte vectoriel embarqué (pour la démo, qui ne peut pas charger de tuiles).
Source : paquet npm `swiss-maps` (géodonnées swisstopo/OFS en LV95) — lac Léman + communes.
    npm pack swiss-maps@4.7.0 && tar -xzf swiss-maps-4.7.0.tgz
    python build_basemap.py package/2026 > basemap.json
"""
import json
import sys

import shapefile
from pyproj import Transformer
from shapely import transform as shp_transform
from shapely.geometry import box, mapping, shape

SRC = sys.argv[1] if len(sys.argv) > 1 else "package/2026"
BB = box(6.50, 46.47, 6.78, 46.61)
T = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)

# communes du Grand Lausanne (numéros OFS) -> nom affiché
COMMUNES = {
    5586: "Lausanne", 5591: "Renens", 5589: "Prilly", 5590: "Pully", 5635: "Ecublens",
    5627: "Chavannes-près-Renens", 5583: "Crissier", 5584: "Epalinges", 5587: "Le Mont-sur-Lausanne",
    5606: "Lutry", 5624: "Bussigny", 5648: "Saint-Sulpice", 5588: "Paudex", 5581: "Belmont-sur-Lausanne",
    5592: "Romanel-sur-Lausanne", 5585: "Jouxtens-Mézery", 5582: "Cheseaux-sur-Lausanne",
    5651: "Villars-Sainte-Croix",
}


def to_wgs(g):
    return shp_transform(g, lambda xy: __import__("numpy").column_stack(T.transform(xy[:, 0], xy[:, 1])))


def rings(geom, nd=5):
    gj = mapping(geom)
    polys = gj["coordinates"] if gj["type"] == "MultiPolygon" else [gj["coordinates"]]
    # [[ [lat, lon], ... ] par anneau extérieur] — Leaflet attend lat, lon
    return [[[round(y, nd), round(x, nd)] for x, y in poly[0]] for poly in polys]


out = {"lake": [], "communes": []}
lakes = shapefile.Reader(f"{SRC}/lakes")
for s, rec in zip(lakes.shapes(), lakes.records()):
    if rec["name"] == "Lac Léman":
        g = to_wgs(shape(s.__geo_interface__)).intersection(BB).simplify(0.00025)
        out["lake"] = rings(g)

mun = shapefile.Reader(f"{SRC}/municipalities")
for s, rec in zip(mun.shapes(), mun.records()):
    if rec["id"] in COMMUNES:
        g = to_wgs(shape(s.__geo_interface__)).simplify(0.0003)
        p = g.representative_point()
        out["communes"].append({"id": rec["id"], "name": COMMUNES[rec["id"]], "rings": rings(g),
                                "label": [round(p.y, 4), round(p.x, 4)]})

json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
