"""
Test de la page privée « Apprentissage » (dist/apprentissage/), dans Chromium, avec des données fictives :
aucune donnée réelle, aucune requête vers Supabase (fonction « stats » et temps réel simulés).
    python3 tools/build_app.py && python3 tools/test_tableau.py

Vérifie : accès refusé sans clé, lien personnel (#cle=… gardée puis effacée de l'adresse), clé envoyée à la
fonction, chiffres et graphiques remplis, aucun texte qui en chevauche un autre (téléphone, tablette,
ordinateur, clair et sombre), mise à jour après un signalement annoncé en temps réel (couple surligné),
clé refusée (retour à l'accès privé), aucune erreur JavaScript ; depuis l'app : accès discret par la légende.
"""
import asyncio
import copy
import datetime as dt
import functools
import http.server
import json
import pathlib
import re
import sys
import threading

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
CLE = "0123456789abcdef0123456789abcdef0123456789abcdef"
results = []


def check(cond, label):
    results.append(bool(cond))
    print(("✓ " if cond else "✗ ") + label, flush=True)


def fixture() -> dict:
    """Statistiques fictives au format de la fonction « stats », sur des arrêts réels de M1 et M2."""
    net = json.loads((DIST / "apprentissage/reseau.json").read_text(encoding="utf-8"))
    m1, m2 = net["sens"]["M1"], net["sens"]["M2"]
    d1, d2 = sorted(m1)[0], sorted(m2)[0]
    a1, a2 = m1[d1], m2[d2]
    t0 = dt.datetime(2026, 11, 9, 7, 0, tzinfo=dt.timezone.utc)
    iso = lambda t: t.isoformat().replace("+00:00", "Z")
    telegram = []
    for h in range(0, 24 * 9):
        t = t0 + dt.timedelta(hours=h)
        n = (h * 7) % 5 if 6 <= (t.hour + 1) % 24 <= 21 else 0
        if n:
            telegram.append({"heure": iso(t), "kind": "controle", "n": n})
        if n >= 3:
            telegram.append({"heure": iso(t), "kind": "fin", "n": 1})
    ctl = sum(r["n"] for r in telegram if r["kind"] == "controle")
    fin = sum(r["n"] for r in telegram if r["kind"] == "fin")
    last = iso(t0 + dt.timedelta(hours=24 * 9 - 2))
    jours = {}
    for r in telegram:
        j = r["heure"][:10]
        jours.setdefault((j, r["kind"]), 0)
        jours[(j, r["kind"])] += r["n"]
    paires = []
    for i in range(12):
        t = t0 + dt.timedelta(days=1 + i % 7, hours=3 + i)
        seq = i % (len(a1) - 4)
        paires.append({"line": "M1", "direction": d1, "seq": seq, "seq2": seq + (i % 4) - (1 if i == 5 else 0),
                       "at": iso(t), "k": (i % 4) - (1 if i == 5 else 0), "dt": [1.5, 4, 7.5, 12, 33, 45][i % 6]})
    paires.append({"line": "M2", "direction": d2, "seq": 2, "seq2": 5, "at": iso(t0 + dt.timedelta(days=3, hours=5)), "k": 3, "dt": 9})
    paires.sort(key=lambda p: p["at"])
    stops = [a1[0], a1[3], a1[5], a1[-1], a2[0], a2[4], a2[-1], a1[8]]
    return {
        "genere": iso(t0 + dt.timedelta(days=9)),
        "totaux": [
            {"src": "telegram", "kind": "controle", "of_kind": "", "n": ctl, "premier": iso(t0), "dernier": last},
            {"src": "telegram", "kind": "fin", "of_kind": "controle", "n": fin, "premier": iso(t0), "dernier": last},
            {"src": "app", "kind": "controle", "of_kind": "", "n": 9, "premier": iso(t0 + dt.timedelta(days=2)), "dernier": last},
        ],
        "jours": [{"jour": j, "src": "telegram", "kind": k, "n": n} for (j, k), n in sorted(jours.items())]
                 + [{"jour": "2026-11-12", "src": "app", "kind": "controle", "n": 9}],
        "heures": [],
        "arrets": [{"stop_id": s, "src": "telegram", "kind": "controle", "n": 20 - 2 * i, "jours": 3, "dernier": last}
                   for i, s in enumerate(stops)] + [{"stop_id": stops[1], "src": "app", "kind": "controle", "n": 9, "jours": 1, "dernier": last}],
        "lignes": [{"line": "M1", "src": "telegram", "kind": "controle", "n": 60, "avec_sens": 40, "avec_rang": 40},
                   {"line": "M2", "src": "telegram", "kind": "controle", "n": 45, "avec_sens": 20, "avec_rang": 20},
                   {"line": "", "src": "telegram", "kind": "controle", "n": ctl - 105, "avec_sens": 0, "avec_rang": 0},
                   {"line": "M1", "src": "app", "kind": "controle", "n": 9, "avec_sens": 9, "avec_rang": 9}],
        "sousTypes": [],
        "paires": paires,
        "tendances": [{"line": "M1", "direction": d1, "paires": 5, "arrets": 9, "minutes": 41.5, "maj": iso(t0 + dt.timedelta(days=8, hours=23))},
                      {"line": "M2", "direction": d2, "paires": 1, "arrets": 3, "minutes": 9, "maj": iso(t0 + dt.timedelta(days=8, hours=23))}],
        "presence": [{"stop_id": stops[0], "src": "telegram", "at": last, "depuis_premier": 12, "depuis_dernier": 4, "n": 2}],
        "confirmations": [{"src": "telegram", "n": ctl, "confirment": 11}, {"src": "app", "n": 9, "confirment": 2}],
        "telegram": telegram,
    }


FAUX_SUPABASE = """
window.supabase = { createClient() { return {
  channel() { const ch = { on(type, filtre, cb) { window.__signalement = cb; return ch; },
                           subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
  removeChannel() {} }; } };
"""

CHEVAUCHEMENTS = """() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-draw^="chart-"]')) {
    const svg = el.querySelector('svg'); if (!svg) { out.push([el.dataset.draw, 'sans graphique']); continue; }
    const sb = svg.getBoundingClientRect();
    const t = [...svg.querySelectorAll('text')].filter((n) => n.textContent.trim()).map((n) => ({ s: n.textContent, b: n.getBoundingClientRect() }));
    for (let i = 0; i < t.length; i++) {
      const a = t[i].b;
      if (a.left < sb.left - 0.5 || a.right > sb.right + 0.5) out.push([el.dataset.draw, 'déborde : ' + t[i].s]);
      for (let j = i + 1; j < t.length; j++) {
        const b = t[j].b, w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 0.5 && h > 0.5) out.push([el.dataset.draw, t[i].s + ' / ' + t[j].s]);
      }
    }
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(['page', 'défilement horizontal']);
  return out;
}"""


class Silencieux(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve() -> str:
    handler = functools.partial(Silencieux, directory=str(DIST))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}/apprentissage/"


async def attendre(page, js, timeout=12.0):
    """Attend qu'une expression soit vraie (sans wait_for_function : la page interdit l'évaluation de texte)."""
    fin = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < fin:
        if await page.evaluate(js):
            return True
        await asyncio.sleep(0.25)
    return False


async def main():
    if not (DIST / "apprentissage/index.html").exists():
        sys.exit("dist/apprentissage/ absent : lance d'abord python3 tools/build_app.py")
    config = json.loads((DIST / "apprentissage/index.html").read_text(encoding="utf-8")
                        .split('id="vigie-config">', 1)[1].split("</script>", 1)[0])
    stats_url = (config.get("supabaseUrl") or "https://exemple.supabase.co").rstrip("/") + "/functions/v1/stats"
    url = serve()
    state = {"data": fixture(), "status": 200, "keys": [], "calls": 0}

    async def fake_stats(route):
        req = route.request
        cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "x-vigie-cle",
                "access-control-allow-methods": "GET, OPTIONS"}
        if req.method == "OPTIONS":
            return await route.fulfill(status=204, headers=cors)
        state["calls"] += 1
        state["keys"].append(req.headers.get("x-vigie-cle"))
        if state["status"] != 200:
            return await route.fulfill(status=state["status"], headers=cors, body="non autorisé")
        await route.fulfill(status=200, headers={**cors, "content-type": "application/json"}, body=json.dumps(state["data"]))

    async with async_playwright() as p:
        browser = await p.chromium.launch()

        async def new_page(width, scheme="light"):
            ctx = await browser.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme)
            await ctx.route(stats_url, fake_stats)
            await ctx.route("**/vendor/supabase.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=FAUX_SUPABASE))
            page = await ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            return ctx, page, errors

        # 1. sans clé : accès privé
        ctx, page, errors = await new_page(390)
        await page.goto(url)
        await page.wait_for_selector("#porte:not([hidden])")
        check(await page.is_hidden("#tableau"), "sans clé : tableau caché, accès privé affiché")
        check(state["calls"] == 0, "sans clé : aucune requête aux statistiques")
        await page.fill("#porte-cle", "pas-une-cle")
        await page.click("#porte-form button")
        check("format" in (await page.text_content("#porte-erreur") or ""), "clé mal formée : message d'erreur")
        check(not errors, "sans clé : aucune erreur JavaScript " + "; ".join(errors[:3]))
        await ctx.close()

        # 2. lien personnel, rendu à plusieurs largeurs et thèmes
        for width, scheme in ((360, "light"), (390, "dark"), (820, "light"), (1280, "dark")):
            ctx, page, errors = await new_page(width, scheme)
            await page.goto(url + "#cle=" + CLE.upper())
            await page.wait_for_selector("#tableau:not([hidden]) [data-draw='chart-carte'] svg", timeout=15000)
            await page.wait_for_timeout(300)
            tag = f"{width} px {scheme}"
            check("#" not in page.url, f"{tag} : clé effacée de l'adresse")
            check(await page.evaluate("localStorage.getItem('vigie.tableau.cle')") == CLE, f"{tag} : clé gardée sur l'appareil")
            check(state["keys"] and state["keys"][-1] == CLE, f"{tag} : clé envoyée à la fonction")
            empty = await page.evaluate("[...document.querySelectorAll('#tableau [data-draw]')].filter((e) => e.textContent.trim() === '—').map((e) => e.dataset.draw)")
            check(not empty, f"{tag} : tous les chiffres remplis {empty}")
            expected = sum(r["n"] for r in state["data"]["totaux"] if r["src"] == "telegram")
            shown = (await page.text_content("[data-draw='tg-messages']") or "").replace(" ", "").replace("’", "").replace(" ", "")
            check(shown == str(expected), f"{tag} : total Telegram affiché ({shown} = {expected})")
            check(await page.evaluate("document.querySelectorAll('[data-draw^=\"chart-\"] svg').length") == 6, f"{tag} : 6 graphiques")
            check("direct" in (await page.text_content("#etat-texte") or "").lower(), f"{tag} : état « en direct »")
            overlaps = await page.evaluate(CHEVAUCHEMENTS)
            check(not overlaps, f"{tag} : aucun texte qui en chevauche un autre {overlaps[:4]}")
            check(not errors, f"{tag} : aucune erreur JavaScript " + "; ".join(errors[:3]))
            if width == 390:
                (ROOT / "build").mkdir(exist_ok=True)
                await page.screenshot(path=str(ROOT / "build/tableau-390.png"), full_page=True)
            await ctx.close()

        # 3. mise à jour en direct : un signalement annoncé, un nouveau couple apparaît, surligné
        ctx, page, errors = await new_page(820)
        await page.goto(url + "#cle=" + CLE)
        await page.wait_for_selector("#tableau:not([hidden]) tbody[data-draw='table-paires'] tr", timeout=15000)
        rows_before = await page.evaluate("document.querySelectorAll(\"tbody[data-draw='table-paires'] tr\").length")
        nouveau = copy.deepcopy(state["data"])
        nouveau["totaux"][0]["n"] += 1
        nouveau["totaux"][0]["dernier"] = "2026-11-18T08:30:00Z"
        p0 = nouveau["paires"][-1]
        nouveau["paires"].append({**p0, "at": "2026-11-18T08:20:00Z", "seq": 1, "seq2": 3, "k": 2, "dt": 6})
        state["data"] = nouveau
        await page.evaluate("window.__signalement({ new: { at: '2026-11-18T08:30:00Z' } })")
        await attendre(page, "document.querySelectorAll(\"tbody[data-draw='table-paires'] tr.vg-nouveau\").length === 1")
        rows_after = await page.evaluate("document.querySelectorAll(\"tbody[data-draw='table-paires'] tr\").length")
        check(rows_after == rows_before + 1, f"temps réel : nouveau couple affiché ({rows_before} → {rows_after}) et surligné")
        check(not errors, "temps réel : aucune erreur JavaScript " + "; ".join(errors[:3]))

        # 4. clé refusée : retour à l'accès privé, clé oubliée
        state["status"] = 401
        await page.evaluate("window.__signalement({ new: { at: '2026-11-18T08:31:00Z' } })")
        await page.wait_for_selector("#porte:not([hidden])", timeout=12000)
        check("refusée" in (await page.text_content("#porte-erreur") or ""), "clé refusée : message et accès privé")
        check(await page.evaluate("localStorage.getItem('vigie.tableau.cle')") is None, "clé refusée : clé oubliée sur l'appareil")
        await ctx.close()

        # 5. accès depuis l'app : rien de visible sans clé, cinq appuis sur le titre de la vitesse apprise ouvrent la
        #    page ; avec une clé gardée sur l'appareil, un lien « Apprentissage » en bas de la légende
        ctx = await browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        await ctx.route(re.compile(r"^https?://(?!127\.0\.0\.1[:/])"), lambda r: r.abort())   # app hors ligne : rien ne sort
        page = await ctx.new_page()
        app = url.rsplit("apprentissage/", 1)[0]
        await page.goto(app)
        await page.click("#btnLegend")
        await page.wait_for_selector("#titreVitesse", timeout=15000)
        check(await page.locator("#lienApprentissage").count() == 0, "app sans clé : aucun lien vers l'apprentissage")
        for _ in range(4):
            await page.click("#titreVitesse")
        await page.wait_for_timeout(300)
        check("apprentissage" not in page.url, "app : quatre appuis ne suffisent pas")
        await page.click("#titreVitesse")
        await page.wait_for_url("**/apprentissage/", timeout=10000)
        await page.wait_for_selector("#porte:not([hidden])", timeout=10000)
        check(True, "app : cinq appuis ouvrent la page, qui demande la clé")
        await page.evaluate(f"localStorage.setItem('vigie.tableau.cle', '{CLE}')")
        await page.goto(app)
        await page.click("#btnLegend")
        await page.wait_for_selector("#titreVitesse", timeout=15000)
        href = await page.get_attribute("#lienApprentissage", "href") if await page.locator("#lienApprentissage").count() else None
        check(href == "apprentissage/", "app avec clé : lien « Apprentissage » dans la légende")
        await ctx.close()
        await browser.close()

    print(f"{sum(results)}/{len(results)} vérifications réussies")
    sys.exit(0 if all(results) else 1)


asyncio.run(main())
