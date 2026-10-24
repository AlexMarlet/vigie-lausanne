"""
Test du site en ligne, en lecture seule (aucun signalement envoyé).
    pip install playwright==1.63.0 && python -m playwright install --with-deps chromium
    python3 tools/smoke_test.py https://alexmarlet.github.io/vigie-lausanne/

Ouvre l'app dans un Chrome mobile et vérifie : chargement, connexion à Supabase (« en direct »),
service worker, installabilité, page Confidentialité, absence d'erreur JavaScript.
Lancé par GitHub Actions après chaque déploiement.
"""
import asyncio
import sys
import tempfile

from playwright.async_api import async_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else "https://alexmarlet.github.io/vigie-lausanne/").rstrip("/") + "/"
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/141.0.0.0 Mobile Safari/537.36")
results = []
LABELS = []


def check(cond, label):
    results.append(bool(cond))
    LABELS.append(("✓ " if cond else "✗ ") + label)
    print(("✓ " if cond else "✗ ") + label, flush=True)
    if not cond:
        print(f"::error title=Site en ligne::{label}", flush=True)


async def main():
    async with async_playwright() as p:
        # profil persistant : un contexte « navigation privée » n'est jamais installable
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), viewport={"width": 390, "height": 844}, user_agent=ANDROID_UA,
            is_mobile=True, has_touch=True, locale="fr-CH")
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        # le site ne doit jamais écrire pendant ce test
        async def no_write(route):
            try:
                if "/rest/v1/rpc/" in route.request.url or route.request.method in ("POST", "PATCH", "DELETE") and "supabase.co" in route.request.url:
                    return await route.abort()
                await route.continue_()
            except Exception:  # requête annulée par la page entre-temps
                pass
        await page.route("**/*", no_write)

        resp = None
        for _ in range(6):                         # le CDN de GitHub Pages peut mettre quelques secondes
            try:
                resp = await page.goto(URL, wait_until="load")
            except Exception as exc:
                if "ERR_NAME_NOT_RESOLVED" not in str(exc):
                    raise
                # nouveau domaine pas encore actif : avertir sans faire échouer le déploiement
                print(f"::warning title=Domaine::{URL} ne répond pas encore (DNS pas configuré ou en cours de propagation). "
                      "Test reporté au prochain déploiement.", flush=True)
                await ctx.close()
                sys.exit(0)
            if resp is not None and resp.ok:
                break
            await page.wait_for_timeout(10000)
        check(resp is not None and resp.ok, f"page d'accueil servie (HTTP {resp.status if resp else '—'})")
        check(await page.title() == "Vigie Lausanne", "titre « Vigie Lausanne »")

        status = ""
        for _ in range(30):                       # jusqu'à 15 s pour joindre Supabase
            status = await page.evaluate("document.querySelector('#status')?.textContent || ''")
            if "en direct" in status:
                break
            await page.wait_for_timeout(500)
        check("en direct" in status, f"connectée à Supabase (« {status} »)")
        check(await page.evaluate("document.querySelector('#chipDemo').hidden"), "démo masquée")
        fond = ""
        for _ in range(40):                       # jusqu'à 20 s pour afficher le fond de carte
            fond = await page.evaluate("document.documentElement.dataset.fond || ''")
            if fond == "ok":
                break
            await page.wait_for_timeout(500)
        check(fond == "ok", f"fond de carte affiché (état : {fond or 'inconnu'})")

        sw = await page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)")
        check(sw, "service worker actif (ouverture hors ligne)")
        cdp = await ctx.new_cdp_session(page)
        inst = await cdp.send("Page.getInstallabilityErrors")
        errs = [e.get("errorId") for e in inst.get("installabilityErrors", [])]
        check(not errs, "installable sur Android" + (f" — {errs}" if errs else ""))

        resp = await page.goto(URL + "confidentialite.html")
        check(resp is not None and resp.ok, "page Confidentialité servie")

        real = [e for e in errors if "favicon" not in e]
        check(not real, "aucune erreur JavaScript" + (f" : {real[:3]}" if real else ""))
        await ctx.close()

    summary = f"{sum(results)}/{len(results)} vérifications OK"
    print(f"\n{summary}", flush=True)
    print(f"::notice title=Site en ligne::{summary} — " + " · ".join(LABELS), flush=True)
    sys.exit(0 if all(results) else 1)


try:
    asyncio.run(main())
except SystemExit:
    raise
except Exception as exc:  # erreur du test lui-même : la rendre visible dans GitHub
    import traceback
    where = " / ".join(line.strip() for line in traceback.format_exc().strip().splitlines()[-5:])
    print(f"::error title=Test du site en ligne::{type(exc).__name__} : {str(exc)[:300]} | {where[:600]}", flush=True)
    sys.exit(1)
