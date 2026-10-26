"""
Test du site en ligne, en lecture seule (aucun signalement envoyé).
    pip install playwright==1.63.0 && python -m playwright install --with-deps chromium
    python3 tools/smoke_test.py https://vigie-lausanne.ch/

Vérifie d'abord le DNS d'un domaine personnalisé (adresses de GitHub Pages), puis ouvre l'app dans un
Chrome mobile : chargement, connexion à Supabase (« en direct »), réseau complet, choix du sens dans le
formulaire (sans rien envoyer), fond de carte, service worker, installabilité, page Confidentialité,
absence d'erreur JavaScript.
Lancé par GitHub Actions après chaque déploiement ; les résultats s'affichent en annotations.
"""
import asyncio
import ipaddress
import json
import os
import pathlib
import socket
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/141.0.0.0 Mobile Safari/537.36")
# adresses de GitHub Pages pour un domaine racine (docs.github.com, « Managing a custom domain »)
GITHUB_A = {f"185.199.{n}.153" for n in (108, 109, 110, 111)}
GITHUB_AAAA = {f"2606:50c0:{n}::153" for n in (8000, 8001, 8002, 8003)}
results = []
LABELS = []


def check(cond, label):
    results.append(bool(cond))
    LABELS.append(("✓ " if cond else "✗ ") + label)
    print(("✓ " if cond else "✗ ") + label, flush=True)
    if not cond:
        print(f"::error title=Site en ligne::{label}", flush=True)


def addresses(host, family):
    try:
        return {info[4][0] for info in socket.getaddrinfo(host, None, family, socket.SOCK_STREAM)}
    except OSError:
        return set()


def dns_report(host):
    """Domaine personnalisé : compare son DNS aux adresses de GitHub Pages et l'annonce dans GitHub.
    Renvoie False si le domaine ne répond pas du tout."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host == "localhost" or host.endswith(".github.io"):
        return True
    apex = host.removeprefix("www.")
    target = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "alexmarlet").lower() + ".github.io"
    good, problems, found_any = [], [], False
    for kind, family, expected in (("A", socket.AF_INET, GITHUB_A), ("AAAA", socket.AF_INET6, GITHUB_AAAA)):
        found = addresses(apex, family)
        found_any |= bool(found)
        extra, missing = sorted(found - expected), sorted(expected - found)
        if extra:
            problems.append(f"{kind} en trop sur {apex} : {', '.join(extra)} (à supprimer)")
        if missing:
            problems.append(f"{kind} manquant sur {apex} : {', '.join(missing)}")
        if not extra and not missing:
            good.append(f"{len(found)} {kind}")
    try:
        name, aliases, ips = socket.gethostbyname_ex("www." + apex)
        names = {n.rstrip(".").lower() for n in (name, *aliases)}
    except OSError:
        names, ips = set(), []
    if target in names:
        good.append(f"www → {target}")
    else:
        seen = ", ".join(sorted(names - {"www." + apex}) or ips) or "aucune entrée"
        problems.append(f"www.{apex} : {seen}, attendu un CNAME vers {target}")
    if problems:
        print(f"::warning title=DNS::{' · '.join(problems)}", flush=True)
    else:
        print(f"::notice title=DNS::{apex} pointe vers GitHub Pages ({', '.join(good)})", flush=True)
    return found_any


def schema_is_current() -> bool | None:
    """La base a-t-elle le sens et les tendances (supabase/schema.sql à jour) ? None si inconnu."""
    try:
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        from build_app import public_config
        base, key = public_config()
        if not base:
            return None
        for path in ("/rest/v1/signalements?select=direction&limit=1", "/rest/v1/tendances?select=line&limit=1"):
            req = urllib.request.Request(base + path, headers={"apikey": key})
            try:
                urllib.request.urlopen(req, timeout=15).close()
            except urllib.error.HTTPError:
                return False
        return True
    except Exception:  # noqa: BLE001 — réseau, configuration : on ne conclut rien
        return None


async def main(url):
    host = urlsplit(url).hostname or ""
    if not dns_report(host):
        # nouveau domaine pas encore actif : avertir sans faire échouer le déploiement
        print(f"::warning title=Domaine::{host} ne répond pas encore (DNS pas configuré ou en cours de propagation). "
              "Test reporté au prochain déploiement.", flush=True)
        sys.exit(0)
    secure = url.startswith("https://") or host in ("localhost", "127.0.0.1")

    async with async_playwright() as p:
        # profil persistant : un contexte « navigation privée » n'est jamais installable
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), viewport={"width": 390, "height": 844}, user_agent=ANDROID_UA,
            is_mobile=True, has_touch=True, locale="fr-CH")
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        # base pas encore mise à jour : l'app lit d'abord le sens et les tendances puis se replie (erreurs HTTP attendues)
        old_schema = schema_is_current() is False
        if old_schema:
            print("::warning title=Supabase::la base n'a pas encore le sens ni l'apprentissage : dans Supabase, relance "
                  "supabase/schema.sql puis supabase/purge.sql (l'app fonctionne en attendant)", flush=True)

        def on_console(m):
            if m.type != "error":
                return
            src = (m.location or {}).get("url", "")
            if old_schema and "supabase.co/rest/v1/" in src:
                return
            errors.append(m.text + (f" ({src})" if src else ""))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", on_console)

        # le site ne doit jamais écrire pendant ce test
        async def no_write(route):
            try:
                if "/rest/v1/rpc/" in route.request.url or route.request.method in ("POST", "PATCH", "DELETE") and "supabase.co" in route.request.url:
                    return await route.abort()
                await route.continue_()
            except Exception:  # requête annulée par la page entre-temps
                pass
        await page.route("**/*", no_write)

        if not secure:
            # GitHub publie en http tant que « Enforce HTTPS » n'est pas coché : essayer la version https
            https_url = "https://" + url.split("://", 1)[1]
            try:                                   # simple requête, certificat vérifié
                secure = (await ctx.request.get(https_url, timeout=20000)).ok
            except Exception:
                secure = False
            if secure:
                url = https_url
                print("::warning title=HTTPS::Le certificat est prêt : coche « Enforce HTTPS » dans Settings → Pages "
                      "pour que le http redirige vers le https.", flush=True)
            else:
                print("::warning title=HTTPS::GitHub n'a pas encore délivré le certificat HTTPS (jusqu'à 24 h après le DNS). "
                      "Service worker et installation non testés.", flush=True)

        resp = None
        for _ in range(6):                         # le CDN de GitHub Pages peut mettre quelques secondes
            try:
                resp = await page.goto(url, wait_until="load")
            except Exception as exc:
                if "ERR_NAME_NOT_RESOLVED" not in str(exc):
                    raise
                print(f"::warning title=Domaine::{url} ne répond pas encore dans le navigateur (DNS en cours de propagation). "
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
            if "en direct" in status.lower():
                break
            await page.wait_for_timeout(500)
        check("en direct" in status.lower(), f"connectée à Supabase (« {status} »)")
        check(await page.evaluate("document.documentElement.dataset.demo") == "off", "démo masquée")
        fond = ""
        for _ in range(40):                       # jusqu'à 20 s pour afficher le fond de carte
            fond = await page.evaluate("document.documentElement.dataset.fond || ''")
            if fond == "ok":
                break
            await page.wait_for_timeout(500)
        check(fond == "ok", f"fond de carte affiché (état : {fond or 'inconnu'})")

        n_stops = await page.evaluate("document.querySelectorAll('path.stop-bus, path.stop-metro').length")
        check(n_stops >= 300, f"réseau tl complet ({n_stops} arrêts)")
        # formulaire : Riponne, ligne M2 -> deux sens proposés (le formulaire est refermé sans envoi)
        dirs = []
        try:
            await page.click("#btnReport")
            await page.fill("#stopSearch", "Riponne")
            await page.click(".sugg button", timeout=5000)
            await page.click('button.opt[data-line="M2"]', timeout=5000)
            dirs = await page.eval_on_selector_all("button.opt[data-dir]", "els => els.map(e => e.textContent.trim())")
            await page.click("#sheetClose")
        except Exception as exc:  # noqa: BLE001 — le test le signale ci-dessous
            print(f"formulaire : {exc}", flush=True)
        check(len(dirs) == 2, "sens proposés à Riponne sur le M2" + (f" ({', '.join(dirs)})" if dirs else ""))

        if secure:
            sw = await page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)")
            check(sw, "service worker actif (ouverture hors ligne)")
            cdp = await ctx.new_cdp_session(page)
            inst = await cdp.send("Page.getInstallabilityErrors")
            errs = [e.get("errorId") for e in inst.get("installabilityErrors", [])]
            check(not errs, "installable sur Android" + (f" — {errs}" if errs else ""))
        else:
            LABELS.append("– service worker et installation non testés (pas de HTTPS)")
            print(LABELS[-1], flush=True)

        resp = await page.goto(url + "confidentialite.html")
        check(resp is not None and resp.ok, "page Confidentialité servie")

        real = [e for e in errors if "favicon" not in e]
        check(not real, "aucune erreur JavaScript" + (f" : {real[:3]}" if real else ""))
        await ctx.close()

    summary = f"{sum(results)}/{len(results)} vérifications OK"
    print(f"\n{summary}", flush=True)
    print(f"::notice title=Site en ligne::{summary} — " + " · ".join(LABELS), flush=True)
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    target_url = (sys.argv[1] if len(sys.argv) > 1 else "https://vigie-lausanne.ch/").rstrip("/") + "/"
    try:
        asyncio.run(main(target_url))
    except SystemExit:
        raise
    except Exception as exc:  # erreur du test lui-même : la rendre visible dans GitHub
        import traceback
        where = " / ".join(line.strip() for line in traceback.format_exc().strip().splitlines()[-5:])
        print(f"::error title=Test du site en ligne::{type(exc).__name__} : {str(exc)[:300]} | {where[:600]}", flush=True)
        sys.exit(1)
