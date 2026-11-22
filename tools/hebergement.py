"""
Où en est le passage de GitHub Pages à Cloudflare Pages ? Lecture seule : rien n'est modifié.
    python3 tools/hebergement.py [vigie-lausanne.ch]

Lancé à la demande par le workflow « Hébergement » (Actions → Hébergement → Run workflow) : le résumé du run
montre les serveurs DNS, DNSSEC, les enregistrements du domaine, l'hébergeur qui répond, les redirections de www
et du http, la copie Cloudflare (vigie-lausanne.pages.dev), puis l'étape suivante du plan de migration.
Le DNS est lu en DNS-over-HTTPS (dns.google), comme le verrait n'importe quel visiteur.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DOMAINE = (sys.argv[1] if len(sys.argv) > 1 else "vigie-lausanne.ch").strip().lower().rstrip(".")
COPIE = os.environ.get("VIGIE_COPIE") or "https://vigie-lausanne.pages.dev/"   # adresse pages.dev du projet
PROPRIO = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "alexmarlet").lower()
UA = "vigie-hebergement (+https://github.com/AlexMarlet/vigie-lausanne)"
TYPES = {"A": 1, "NS": 2, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28, "DS": 43, "CAA": 257}
HEBERGEURS = {"github.com": "GitHub Pages", "cloudflare": "Cloudflare"}
sortie: list[str] = []


def dire(texte=""):
    print(texte, flush=True)
    sortie.append(texte)


def dns(nom, type_):
    """(code de réponse, réponse validée par DNSSEC, valeurs). Code 2 = SERVFAIL, None = requête impossible."""
    url = "https://dns.google/resolve?" + urllib.parse.urlencode({"name": nom, "type": type_})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20) as r:
            rep = json.load(r)
    except (urllib.error.URLError, OSError, ValueError):
        return None, False, []
    valeurs = [a["data"].rstrip(".").strip('"') for a in rep.get("Answer", []) if a.get("type") == TYPES[type_]]
    return rep.get("Status"), bool(rep.get("AD")), sorted(valeurs)


def http(url):
    """(statut HTTP, hébergeur d'après l'en-tête Server, adresse finale, début du contenu) ; statut None sans réponse."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            serveur = (r.headers.get("Server") or "").lower()
            return r.status, HEBERGEURS.get(serveur, serveur or "?"), r.geturl(), r.read(400_000)
    except urllib.error.HTTPError as e:
        serveur = (e.headers.get("Server") or "").lower()
        return e.code, HEBERGEURS.get(serveur, serveur or "?"), e.geturl(), b""
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, None, None, str(getattr(e, "reason", e)).encode()


def version(base):
    """Version de l'app servie (VERSION du service worker), ou None."""
    statut, _, _, corps = http(base + "sw.js")
    m = re.search(rb'const VERSION = "([0-9a-f]{6,})"', corps) if statut == 200 else None
    return m.group(1).decode() if m else None


def fournisseur(serveurs):
    noms = {("Infomaniak" if re.search(r"infomaniak\.(ch|com)$", s) else
             "Cloudflare" if s.endswith(".ns.cloudflare.com") else s) for s in serveurs}
    return noms.pop() if len(noms) == 1 else ("mélange (changement en cours)" if noms else "aucun")


def liste(valeurs):
    return ", ".join(f"`{v}`" for v in valeurs) if valeurs else "—"


def main():
    dire(f"## Hébergement de {DOMAINE}")
    dire()
    _, _, ns = dns(DOMAINE, "NS")
    statut_a, valide, a = dns(DOMAINE, "A")
    _, _, aaaa = dns(DOMAINE, "AAAA")
    _, _, ds = dns(DOMAINE, "DS")
    _, _, www_cname = dns("www." + DOMAINE, "CNAME")
    _, _, www_a = dns("www." + DOMAINE, "A")
    _, _, mx = dns(DOMAINE, "MX")
    _, _, txt = dns(DOMAINE, "TXT")
    _, _, caa = dns(DOMAINE, "CAA")
    _, _, defi = dns(f"_github-pages-challenge-{PROPRIO}.{DOMAINE}", "TXT")
    prov = fournisseur(ns)
    casse = statut_a == 2 and bool(ds)

    dire("| | |")
    dire("|---|---|")
    dire(f"| Serveurs DNS | **{prov}** ({liste(ns)}) |")
    etat_dnssec = ("✗ **cassé** : le domaine ne se résout plus (SERVFAIL)" if casse else
                   f"activé{' et validé' if valide else ''} (enregistrement DS au registre)" if ds else "désactivé")
    dire(f"| DNSSEC | {etat_dnssec} |")
    dire(f"| A / AAAA | {liste(a)} / {liste(aaaa)} |")
    dire(f"| www | {'CNAME ' + liste(www_cname) if www_cname else liste(www_a)} |")
    dire(f"| MX (e-mail) | {liste(mx)} |")
    dire(f"| TXT | {liste(txt)} |")
    if caa:
        dire(f"| CAA | {liste(caa)} |")
    dire(f"| Vérification GitHub (TXT `_github-pages-challenge-{PROPRIO}`) | {'✓ présente' if defi else '✗ absente'} |")
    autres = []                                # sous-domaines courants (e-mail…) à recopier aussi dans Cloudflare
    for sous in ("autoconfig", "autodiscover", "_dmarc", "mail", "webmail", "ftp"):
        for type_ in ("CNAME", "A", "TXT"):
            _, _, vals = dns(f"{sous}.{DOMAINE}", type_)
            if vals:
                autres.append(f"`{sous}` {type_} {liste(vals)}")
                break
    if autres:
        dire(f"| Autres entrées | {' · '.join(autres)} |")

    statut, servi, _, _ = http(f"https://{DOMAINE}/")
    _, _, www_fin, _ = http(f"https://www.{DOMAINE}/")
    _, _, http_fin, _ = http(f"http://{DOMAINE}/")
    www_ok = bool(www_fin) and urllib.parse.urlsplit(www_fin).hostname == DOMAINE
    https_ok = bool(http_fin) and http_fin.startswith("https://")
    statut_copie, _, _, _ = http(COPIE)
    v_site, v_copie = version(f"https://{DOMAINE}/"), version(COPIE)
    dire(f"| Site https://{DOMAINE}/ | {'HTTP ' + str(statut) + ' · servi par **' + str(servi) + '**' if statut else '✗ pas de réponse'} |")
    dire(f"| www → {DOMAINE} | {'✓' if www_ok else '✗ ' + (www_fin or 'pas de réponse')} |")
    dire(f"| http → https | {'✓' if https_ok else '✗ ' + (http_fin or 'pas de réponse')} |")
    dire(f"| Copie Cloudflare {COPIE} | {'✓ en ligne' if statut_copie == 200 else '✗ ' + (f'HTTP {statut_copie}' if statut_copie else 'pas encore déployée')} |")
    if v_site and v_copie:
        meme = "✓ même version" if v_site == v_copie else "≠ versions différentes (relance Déploiement)"
        dire(f"| Version de l'app (site / copie) | `{v_site}` / `{v_copie}` · {meme} |")
    dire()

    if casse:
        suite = ("⚠️ Le domaine ne répond plus : DNSSEC est encore actif alors que les serveurs DNS ont changé. "
                 "Désactive DNSSEC tout de suite dans le tableau de bord du domaine chez Infomaniak.")
    elif servi == "Cloudflare":
        if not www_ok:
            suite = "Étape 8 (fin) : fais renvoyer www vers le domaine principal (redirection dans Cloudflare)."
        elif not https_ok:
            suite = "Active « Always Use HTTPS » dans Cloudflare (SSL/TLS → Edge Certificates)."
        elif not ds:
            suite = ("Étapes 9 et 10 : trois jours après la bascule, demande à Claude de retirer GitHub Pages du "
                     "déploiement, puis réactive DNSSEC (dans Cloudflare, puis l'enregistrement DS chez Infomaniak).")
        else:
            suite = "Migration terminée : le site est servi par Cloudflare et DNSSEC est actif. ✓"
    elif servi == "GitHub Pages":
        if prov == "Cloudflare":
            suite = ("Étapes 7 et 8 : attends que Cloudflare affiche le domaine actif et le certificat Universal SSL "
                     "actif (SSL/TLS → Edge Certificates), puis fais la bascule à une heure creuse.")
        elif prov.startswith("mélange"):
            suite = "Changement de serveurs DNS en cours (jusqu'à 24 h). Relance ce contrôle plus tard."
        else:
            restes = []
            if ds:
                restes.append("étape 1 : désactive DNSSEC chez Infomaniak, puis attends au moins 24 h")
            if statut_copie != 200:
                restes.append("étape 3 : prépare Cloudflare (compte, jeton, 2 secrets GitHub), puis relance Déploiement")
            suite = ("À faire avant le jour J — " + " ; ".join(restes) + "." if restes else
                     "Prêt pour le jour J (étapes 5 à 8), à condition que DNSSEC soit désactivé depuis au moins 24 h.")
    else:
        suite = "Le site ne répond pas en HTTPS : vérifie les derniers changements DNS (ou attends le certificat)."
    dire(f"**Étape suivante :** {suite}")
    if mx and prov != "Infomaniak":
        dire()
        dire("Le domaine reçoit des e-mails (MX) : vérifie que les entrées MX et TXT ci-dessus existent aussi dans Cloudflare.")
    print(f"::notice title=Étape suivante::{suite}", flush=True)

    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(sortie) + "\n")


if __name__ == "__main__":
    main()
