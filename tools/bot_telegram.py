"""
Vigie — installation du bot Telegram, appelée par .github/workflows/bot.yml (sans dépendance).

    python3 tools/bot_telegram.py check     vérifie le bot ; sans TG_CHAT_ID : liste les groupes où il a été ajouté
    python3 tools/bot_telegram.py webhook   branche Telegram sur la fonction Supabase et la teste en ligne

Variables : TELEGRAM_BOT_TOKEN, TG_CHAT_ID (vide pendant l'installation), SUPABASE_URL (sinon vigie.config.json).
Résultats : annotations GitHub (::notice / ::warning / ::error) et, pour check, mode=setup|deploy dans GITHUB_OUTPUT.
TELEGRAM_API remplace https://api.telegram.org (tests).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = os.environ.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/")
UPDATES = ["message", "edited_message", "my_chat_member"]
FAILED = False


def note(level: str, title: str, msg: str) -> None:
    global FAILED
    FAILED = FAILED or level == "error"
    print(f"::{level} title={title}::{msg}", flush=True)


def webhook_secret(token: str) -> str:
    """Même calcul que deriveSecrets() dans supabase/functions/telegram/bot.mjs."""
    return hmac.new(token.encode(), b"vigie-webhook", hashlib.sha256).hexdigest()[:48]


def supabase_url() -> str:
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not url:
        url = json.loads((ROOT / "vigie.config.json").read_text(encoding="utf-8")).get("supabaseUrl", "").rstrip("/")
    return url


def tg(token: str, method: str, **params):
    """Appel de l'API Bot ; renvoie result, ou lève RuntimeError avec la description de Telegram."""
    data = json.dumps(params).encode()
    req = urllib.request.Request(f"{API}/bot{token}/{method}", data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except ValueError:
            raise RuntimeError(f"{method} : HTTP {e.code}") from None
    if not body.get("ok"):
        raise RuntimeError(f"{method} : {body.get('description', 'erreur')}")
    return body["result"]


def output(**kv) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def check(token: str, chat: str) -> None:
    me = tg(token, "getMe")
    reads_all = bool(me.get("can_read_all_group_messages"))
    note("notice", "Bot", f"@{me['username']} ({me['first_name']}) · mode confidentialité "
         + ("désactivé : il lit tous les messages des groupes" if reads_all else "actif : il ne lira tous les messages que s'il est admin du groupe"))
    if not chat:
        output(mode="setup")
        # installation : les ajouts du bot à un groupe (et les messages reçus) des dernières 24 h donnent l'identifiant
        tg(token, "deleteWebhook", drop_pending_updates=False)
        found: dict[str, dict] = {}
        for u in tg(token, "getUpdates", timeout=0, limit=100, allowed_updates=["message", "my_chat_member"]):
            m = u.get("my_chat_member")
            c = (m or u.get("message") or {}).get("chat") or {}
            if c.get("type") not in ("group", "supergroup"):
                continue
            g = found.setdefault(str(c["id"]), {"title": c.get("title", "?"), "status": "membre"})
            if m:
                g["status"] = m.get("new_chat_member", {}).get("status", g["status"])
        if not found:
            note("warning", "Installation", "aucun groupe trouvé : le bot doit avoir été ajouté au groupe il y a moins de 24 h "
                 "(sinon, le faire retirer et ré-ajouter), puis relance ce workflow")
        for cid, g in found.items():
            note("notice", "Groupe trouvé", f"« {g['title']} » (bot : {g['status']}) → crée le secret TG_CHAT_ID = {cid}, puis relance ce workflow")
        return
    output(mode="deploy")
    try:
        info = tg(token, "getChat", chat_id=chat)
        member = tg(token, "getChatMember", chat_id=chat, user_id=me["id"])
        count = tg(token, "getChatMemberCount", chat_id=chat)
    except RuntimeError as e:
        note("error", "Groupe", f"{e} : le bot n'est pas (ou plus) dans le groupe {chat}, ou TG_CHAT_ID est faux")
        return
    status = member.get("status")
    note("notice", "Groupe", f"« {info.get('title')} » · {count} membres · bot : {status}")
    if status not in ("administrator", "member", "restricted"):
        note("error", "Groupe", f"le bot n'est pas membre du groupe (statut : {status}) : demande aux admins de l'ajouter")
    elif status != "administrator" and not reads_all:
        note("error", "Lecture", "le bot ne reçoit que les commandes : dans @BotFather, /setprivacy → Disable, puis fais-le "
             "retirer et ré-ajouter au groupe ; ou demande aux admins de le passer admin (aucun droit nécessaire)")


def call_function(url: str, body: dict | None, secret: str | None) -> tuple[int, str]:
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["X-Telegram-Bot-Api-Secret-Token"] = secret
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def webhook(token: str) -> None:
    secret = webhook_secret(token)
    print(f"::add-mask::{secret}", flush=True)
    url = supabase_url() + "/functions/v1/telegram"
    # 1) la fonction répond et refuse les appels sans le secret (quelques secondes après le déploiement)
    status = 0
    for _ in range(12):
        status, _body = call_function(url, None, None)
        if status == 200:
            break
        time.sleep(5)
    if status != 200:
        note("error", "Fonction", f"{url} ne répond pas (HTTP {status})")
        return
    status, _body = call_function(url, {"update_id": 1}, None)
    if status != 401:
        note("error", "Fonction", f"appel sans secret : HTTP {status} au lieu de 401")
    test = {"update_id": 2, "message": {"message_id": 1, "date": int(time.time()), "chat": {"id": 1, "type": "private"},
                                        "from": {"id": 1, "is_bot": False, "first_name": "test"},
                                        "text": "Contrôleurs à Flon M2 direction Croisettes"}}
    status, body = call_function(url, test, secret)
    try:
        answer = json.loads(body).get("text", "")
    except ValueError:
        answer = ""
    if status == 200 and "Lausanne-Flon" in answer:
        note("notice", "Fonction", "message de test compris : " + answer.split("\n")[0])
    else:
        note("error", "Fonction", f"message de test : HTTP {status} {body[:200]}")
        return
    # 2) Telegram envoie désormais chaque message du groupe à la fonction
    tg(token, "setWebhook", url=url, secret_token=secret, allowed_updates=UPDATES, max_connections=10, drop_pending_updates=False)
    info = tg(token, "getWebhookInfo")
    msg = f"Telegram → {info.get('url')} · {info.get('pending_update_count', 0)} message(s) en attente"
    err = info.get("last_error_date")
    if err and time.time() - err < 15 * 60:
        note("warning", "Webhook", msg + f" · dernière erreur : {info.get('last_error_message')}")
    else:
        note("notice", "Webhook", msg)


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        note("notice", "Bot Telegram", "non configuré : ajoute le secret TELEGRAM_BOT_TOKEN (voir README, « Bot Telegram »)")
        output(mode="off")
        return
    try:
        if sys.argv[1:] == ["check"]:
            check(token, os.environ.get("TG_CHAT_ID", "").strip())
        elif sys.argv[1:] == ["webhook"]:
            webhook(token)
        else:
            raise SystemExit(__doc__)
    except RuntimeError as e:
        note("error", "Telegram", str(e))
    except urllib.error.URLError as e:
        note("error", "Réseau", str(e.reason))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
