"""
Vérifie la page privée « Apprentissage » en ligne, avec la vraie clé d'accès, dans un Chrome mobile.
    VIGIE_TABLEAU_CLE=… python3 tools/check_tableau.py https://vigie-lausanne.ch/apprentissage/

Lancé par .github/workflows/tableau.yml. Le journal est public : ce test n'écrit que des vérifications
réussies ou non, jamais un chiffre des statistiques ni la clé (masquée par GitHub de toute façon).
Vérifie : statistiques chargées depuis le site (CORS et clé acceptés par la fonction « stats »), clé effacée de
l'adresse, chiffres et 6 graphiques remplis, aucun texte qui en chevauche un autre, temps réel branché,
aucune erreur JavaScript.
"""
import asyncio
import os
import pathlib
import sys

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
results = []


def check(cond, label, warn_only=False):
    if not warn_only:
        results.append(bool(cond))
    mark = "✓ " if cond else ("! " if warn_only else "✗ ")
    print(mark + label, flush=True)
    if not cond:
        print(f"::{'warning' if warn_only else 'error'} title=Tableau d'apprentissage::{label}", flush=True)


async def main(url: str, key: str):
    chev = (ROOT / "tools/test_tableau.py").read_text(encoding="utf-8").split('CHEVAUCHEMENTS = """', 1)[1].split('"""', 1)[0]
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
        status = {}
        page.on("response", lambda r: status.__setitem__("stats", r.status) if "/functions/v1/stats" in r.url and r.request.method == "GET" else None)

        loaded = False
        for attempt in range(2):          # fonction « endormie » : un second essai
            await page.goto(url + "#cle=" + key, wait_until="load")
            try:
                await page.wait_for_selector("#tableau:not([hidden]) [data-draw='chart-carte'] svg", timeout=60000)
                loaded = True
                break
            except Exception:
                if attempt == 0:
                    print("premier chargement trop lent ou refusé, nouvel essai", flush=True)
        check(loaded, "statistiques chargées depuis le site" + (f" (HTTP {status.get('stats')})" if status.get("stats") not in (None, 200) else ""))
        check(await page.is_hidden("#porte"), "clé acceptée par la fonction « stats »")
        check("cle=" not in page.url, "clé effacée de la barre d'adresse")
        if loaded:
            await page.wait_for_timeout(500)
            empty = await page.evaluate("[...document.querySelectorAll('#tableau [data-draw]')].filter((e) => e.textContent.trim() === '—').length")
            check(empty == 0, f"tous les chiffres remplis ({empty} vide{'s' if empty > 1 else ''})")
            charts = await page.evaluate("document.querySelectorAll('[data-draw^=\"chart-\"] svg').length")
            check(charts == 6, f"6 graphiques dessinés ({charts})")
            overlaps = await page.evaluate(chev)
            check(not overlaps, f"aucun texte qui en chevauche un autre ({len(overlaps)})")
            live = False
            for _ in range(40):
                if "en direct" in ((await page.text_content("#etat-texte")) or "").lower():
                    live = True
                    break
                await page.wait_for_timeout(500)
            check(live, "temps réel branché (« En direct »)", warn_only=True)
        check(not errors, f"aucune erreur JavaScript ({len(errors)})")
        await ctx.close()
        await browser.close()
    summary = f"{sum(results)}/{len(results)} vérifications OK"
    print(f"::notice title=Tableau d'apprentissage::{summary}", flush=True)
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    target = (sys.argv[1] if len(sys.argv) > 1 else "https://vigie-lausanne.ch/apprentissage/").split("#")[0]
    cle = os.environ.get("VIGIE_TABLEAU_CLE", "").strip()
    if not cle:
        sys.exit("VIGIE_TABLEAU_CLE absente")
    asyncio.run(main(target, cle))
