"""
Construit le site dans dist/ (et, avec --artifact, l'aperçu autonome publié dans Claude).

    npm ci                              # librairies et polices (versions figées dans package-lock.json)
    python3 tools/build_app.py          # site  -> dist/
    python3 tools/build_app.py --artifact   # aperçu -> build/vigie-artifact.html

Connexion à Supabase : vigie.config.json (valeurs publiques), ou les variables SUPABASE_URL / SUPABASE_KEY
qui le remplacent. VIGIE_OFFLINE=1 construit une version locale, sans base.

Variables d'environnement, toutes facultatives :
    SUPABASE_URL       https://<id-du-projet>.supabase.co
    SUPABASE_KEY       clé « publishable » (sb_publishable_…). Le build refuse une clé secrète.
    VIGIE_OFFLINE      1 = ignorer Supabase (signalements gardés sur l'appareil, démo active)
    SITE_URL           adresse publique du site (aperçu des liens partagés)
    VIGIE_CONTACT      responsable affiché dans la page Confidentialité (ex. « Prénom Nom, e-mail »)
    GITHUB_REPOSITORY  owner/repo, fourni par GitHub Actions : liens « Code source » et contact
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
NM = ROOT / "node_modules"
read = lambda p: (ROOT / p).read_text(encoding="utf-8")

LEAFLET_CDN = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"
SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"
GOOGLE_FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,500..900'
    '&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">'
)
FONTS = {  # fichier source dans node_modules -> nom publié
    "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2": "archivo-latin-wdth-normal.woff2",
    "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2": "atkinson-hyperlegible-latin-400-normal.woff2",
    "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2": "atkinson-hyperlegible-latin-700-normal.woff2",
    "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2": "ibm-plex-mono-latin-400-normal.woff2",
    "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2": "ibm-plex-mono-latin-500-normal.woff2",
}
FONT_FACES = (
    '@font-face{font-family:"Archivo";font-style:normal;font-display:swap;font-weight:100 900;font-stretch:62% 125%;'
    'src:url(fonts/archivo-latin-wdth-normal.woff2) format("woff2")}'
    '@font-face{font-family:"Atkinson Hyperlegible";font-style:normal;font-display:swap;font-weight:400;'
    'src:url(fonts/atkinson-hyperlegible-latin-400-normal.woff2) format("woff2")}'
    '@font-face{font-family:"Atkinson Hyperlegible";font-style:normal;font-display:swap;font-weight:700;'
    'src:url(fonts/atkinson-hyperlegible-latin-700-normal.woff2) format("woff2")}'
    '@font-face{font-family:"IBM Plex Mono";font-style:normal;font-display:swap;font-weight:400;'
    'src:url(fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}'
    '@font-face{font-family:"IBM Plex Mono";font-style:normal;font-display:swap;font-weight:500;'
    'src:url(fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2")}'
)
METRO = {
    "M1": ["flon", "vigie", "montelly", "provence", "malley", "bourdonnette", "chamberonne", "mouline", "sorge",
           "epfl", "bassenges", "cerisaie", "crochy", "epenex", "renens"],
    "M2": ["ouchy", "jordils", "delices", "grancy", "gare", "flon", "riponne", "bessieres", "ours", "chuv",
           "sallaz", "fourmi", "vennes", "croisettes"],
}


def fail(msg: str) -> None:
    sys.exit("build : " + msg)


def check_key(key: str) -> None:
    """Le site est public : n'y injecter que la clé publishable (ou l'ancienne clé anon)."""
    if key.startswith("sb_secret_"):
        fail("SUPABASE_KEY est une clé secrète. Utilise la clé publishable (sb_publishable_…).")
    if key.startswith("eyJ"):
        try:
            payload = json.loads(base64.urlsafe_b64decode(key.split(".")[1] + "=="))
        except Exception:
            payload = {}
        if payload.get("role") == "service_role":
            fail("SUPABASE_KEY est la clé service_role. Utilise la clé publishable (ou anon).")


def public_config() -> tuple[str, str]:
    """URL et clé publishable : variables d'environnement, sinon vigie.config.json."""
    if os.environ.get("VIGIE_OFFLINE", "").strip() in ("1", "true", "yes"):
        return "", ""
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_KEY", "").strip()
    cfg = ROOT / "vigie.config.json"
    if not url and not key and cfg.exists():
        c = json.loads(cfg.read_text(encoding="utf-8"))
        url = str(c.get("supabaseUrl", "")).strip().rstrip("/")
        key = str(c.get("supabaseKey", "")).strip()
    if bool(url) != bool(key):
        fail("renseigne l'URL et la clé Supabase ensemble (ou aucune des deux).")
    if key:
        check_key(key)
    return url, key


def load_data(repo_url: str | None) -> tuple[dict, list]:
    base = json.loads(subprocess.check_output(
        ["node", "-e", "process.stdout.write(JSON.stringify(require('./core/stops-base.js')))"], cwd=ROOT))
    coords = json.loads(read("tools/stop_coords.json"))
    basemap = json.loads(read("tools/basemap.json"))
    stops, missing = [], []
    for s in base:
        c = coords["stops"].get(s["id"])
        if c:
            stops.append({**s, "lat": c["lat"], "lon": c["lon"]})
        else:
            missing.append(s["id"])
    if missing:
        print("arrêts sans coordonnées (ignorés) :", ", ".join(missing))
    labels = coords.get("commune_labels", {})
    for c in basemap["communes"]:
        if str(c["id"]) in labels:
            c["labelAt"] = labels[str(c["id"])]
        c["showLabel"] = c["name"] in coords.get("show_communes", [])
    data = {"stops": stops, "basemap": basemap, "metro": METRO,
            "meta": {"note": coords.get("note", ""), "repo": repo_url}}
    return {"data": data, "colors": coords["colors"]}, stops


def render_app(template: str, head: str, data: dict, colors: dict, config: dict, leaflet: str, supabase: str) -> str:
    out = template
    out = out.replace("<!--@HEAD@-->", head)
    out = out.replace("/*@LEAFLET_CSS@*/", read("web/vendor/leaflet-1.9.4.css"))
    out = out.replace("/*@CORE@*/", read("core/vigie-core.js"))
    out = out.replace("/*@DATA@*/",
                      "window.VIGIE_CONFIG = " + json.dumps(config, ensure_ascii=False) + ";\n"
                      "window.VIGIE_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";")
    out = out.replace("/*@M1@*/", colors["M1"]).replace("/*@M2@*/", colors["M2"])
    out = out.replace("__LEAFLET_JS__", leaflet).replace("__SUPABASE_JS__", supabase)
    for marker in ("<!--@", "/*@", "__LEAFLET_JS__", "__SUPABASE_JS__"):
        if marker in out:
            fail(f"marqueur non remplacé : {marker}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Construit Vigie")
    ap.add_argument("--artifact", action="store_true", help="aperçu autonome (CDN, sans service worker)")
    a = ap.parse_args()

    url, key = public_config()
    site = os.environ.get("SITE_URL", "").strip().rstrip("/")
    contact = os.environ.get("VIGIE_CONTACT", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    repo_url = f"https://github.com/{repo}" if repo else None
    config = {"supabaseUrl": url, "supabaseKey": key} if url else {}

    bundle, stops = load_data(repo_url)
    template = read("web/index.template.html")
    (ROOT / "collector/stops.json").write_text(json.dumps(stops, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")

    if a.artifact:
        page = render_app(template, GOOGLE_FONTS, bundle["data"], bundle["colors"], {}, LEAFLET_CDN, SUPABASE_CDN)
        out = ROOT / "build/vigie-artifact.html"
        out.parent.mkdir(exist_ok=True)
        out.write_text(page, encoding="utf-8")
        print(f"{out.relative_to(ROOT)} : {len(page) // 1024} Ko · {len(stops)} arrêts")
        return

    for src in list(FONTS) + ["leaflet/dist/leaflet.js", "@supabase/supabase-js/dist/umd/supabase.js"]:
        if not (NM / src).exists():
            fail(f"node_modules/{src} introuvable : lance d'abord « npm ci ».")

    dist = ROOT / "dist"
    shutil.rmtree(dist, ignore_errors=True)
    (dist / "fonts").mkdir(parents=True)
    (dist / "vendor").mkdir()
    shutil.copytree(WEB / "icons", dist / "icons")
    shutil.copy(WEB / "manifest.webmanifest", dist / "manifest.webmanifest")
    shutil.copy(NM / "leaflet/dist/leaflet.js", dist / "vendor/leaflet.js")
    shutil.copy(NM / "@supabase/supabase-js/dist/umd/supabase.js", dist / "vendor/supabase.js")
    for src, name in FONTS.items():
        shutil.copy(NM / src, dist / "fonts" / name)
    for lic in (WEB / "fonts").glob("OFL-*.txt"):
        shutil.copy(lic, dist / "fonts" / lic.name)

    common_head = (
        f"<style>{FONT_FACES}</style>\n"
        '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">\n'
        '<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">\n'
        '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">'
    )
    og = ""
    if site:
        og = ("\n" + f'<meta property="og:title" content="Vigie Lausanne">\n'
              f'<meta property="og:description" content="Contrôles et perturbations signalés en direct sur le réseau du Grand Lausanne.">\n'
              f'<meta property="og:type" content="website">\n<meta property="og:url" content="{html.escape(site)}/">\n'
              f'<meta property="og:image" content="{html.escape(site)}/icons/icon-512.png">')
    app_head = (common_head + "\n"
                '<link rel="manifest" href="manifest.webmanifest">\n'
                '<meta name="mobile-web-app-capable" content="yes">\n'
                '<meta name="apple-mobile-web-app-capable" content="yes">\n'
                '<meta name="apple-mobile-web-app-title" content="Vigie">\n'
                '<meta name="apple-mobile-web-app-status-bar-style" content="default">' + og)

    page = render_app(template, app_head, bundle["data"], bundle["colors"], config, "vendor/leaflet.js", "vendor/supabase.js")
    cut = page.index('<div class="app">')
    doc = ('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
           '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
           '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>\n'
           + page[:cut] + '</head>\n<body>\n' + page[cut:] + '\n</body>\n</html>\n')
    (dist / "index.html").write_text(doc, encoding="utf-8")

    contact_html = ""
    if contact or repo_url:
        parts = ["<h2>Questions et demandes</h2>"]
        if contact:
            parts.append(f"<p>Responsable : {html.escape(contact)}.</p>")
        if repo_url:
            parts.append(f'<p>Pour une question ou une demande sur tes données, écris sur '
                         f'<a href="{repo_url}/issues">la page du projet</a>.</p>')
        contact_html = "\n  ".join(parts)
    privacy = read("web/confidentialite.html").replace("<!--@HEAD@-->", common_head).replace("<!--@CONTACT@-->", contact_html)
    (dist / "confidentialite.html").write_text(privacy, encoding="utf-8")

    # service worker : cache versionné par le contenu du site
    files = sorted(p for p in dist.rglob("*") if p.is_file() and not p.name.endswith(".txt"))
    digest = hashlib.sha256()
    for p in files:
        digest.update(p.relative_to(dist).as_posix().encode())
        digest.update(p.read_bytes())
    version = digest.hexdigest()[:12]
    shell = ["./"] + [p.relative_to(dist).as_posix() for p in files if p.name != "index.html"]
    sw = read("web/sw.js").replace("__VERSION__", version).replace("__SHELL__", json.dumps(shell, indent=2))
    (dist / "sw.js").write_text(sw, encoding="utf-8")

    mode = "Supabase" if config else "local (sans Supabase)"
    size = sum(p.stat().st_size for p in dist.rglob("*") if p.is_file()) // 1024
    print(f"dist/ : {len(stops)} arrêts · mode {mode} · version {version} · {size} Ko")


if __name__ == "__main__":
    main()
