"""
Vérifie que la base Supabase est prête pour l'app, sans rien y écrire.
    python3 tools/check_supabase.py
Lancé à chaque déploiement : signale un schéma manquant au lieu de publier une app muette.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build_app import public_config  # noqa: E402

url, key = public_config()
if not url:
    print("Pas de configuration Supabase : l'app sera publiée en mode local.")
    sys.exit(0)


def call(method, path, body=None):
    req = urllib.request.Request(url + path, method=method, headers={"apikey": key, "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # réseau
        return 0, str(e)


problems = []
status, body = call("GET", "/rest/v1/signalements?select=id&limit=1")
if status == 0:
    print(f"::warning title=Supabase::Supabase injoignable depuis cette machine ({body[:120]})")
    sys.exit(1)
if status == 200:
    print("✓ table signalements lisible avec la clé publishable")
else:
    problems.append(f"table signalements inaccessible (HTTP {status}) : exécute supabase/schema.sql. Détail : {body[:200]}")

# identifiant d'appareil volontairement invalide : la fonction refuse avant toute écriture
status, body = call("POST", "/rest/v1/rpc/signaler", {"p_kind": "controle", "p_stop_id": "flon", "p_device": "verification"})
if "Appareil non reconnu" in body:
    print("✓ fonction signaler() en place (refuse un identifiant invalide)")
else:
    problems.append(f"fonction signaler() absente ou inattendue (HTTP {status}) : exécute supabase/schema.sql. Détail : {body[:200]}")

for p in problems:
    print(f"::warning title=Supabase::{p}")
sys.exit(1 if problems else 0)
