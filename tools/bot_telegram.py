"""
Vigie — installation du bot Telegram, appelée par .github/workflows/bot.yml (sans dépendance).

    python3 tools/bot_telegram.py check     vérifie le bot et ses groupes ; sans TG_CHAT_ID : trouve les groupes où il est
    python3 tools/bot_telegram.py webhook   branche Telegram sur la fonction Supabase et la teste en ligne

Variables : TELEGRAM_BOT_TOKEN, TG_CHAT_ID (vide pendant l'installation), TG_TEST_CHAT_ID (groupes de test, séparés
par des virgules), SUPABASE_URL (sinon vigie.config.json).
Résultats : annotations GitHub (::notice / ::warning / ::error) et, pour check, mode=setup|deploy dans GITHUB_OUTPUT.
TELEGRAM_API remplace https://api.telegram.org (tests).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import pathlib
import re
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


def discover(token: str, tests: set[str]) -> tuple[dict[str, dict], dict[str, int]]:
    """Groupes où se trouve le bot, d'après ce que Telegram lui a envoyé (ajouts au groupe, messages) : les dernières
    24 h, puis jusqu'à une minute d'écoute. Le webhook éventuel est coupé pendant ce temps (le workflow le rebranche).
    Renvoie aussi le nombre de mises à jour reçues par type de discussion (diagnostic)."""
    hook = tg(token, "getWebhookInfo")
    if hook.get("url"):
        ours = hook["url"].endswith("/functions/v1/telegram")
        note("notice" if ours else "warning", "Webhook",
             ("webhook de la fonction coupé pendant la recherche" if ours else
              f"un webhook était branché sur {urllib.parse.urlsplit(hook['url']).netloc} : un autre outil utilise ce bot et "
              "recevait ses messages à la place du workflow ; il est coupé") + f" ({hook.get('pending_update_count', 0)} en attente)")
    tg(token, "deleteWebhook", drop_pending_updates=False)
    found: dict[str, dict] = {}
    seen: dict[str, int] = {}
    channels: set = set()
    offset = None
    deadline = time.time() + 60
    while True:
        params = {"timeout": 0 if offset is None else 20, "limit": 100,
                  "allowed_updates": ["message", "my_chat_member", "channel_post"]}
        if offset is not None:
            params["offset"] = offset
        updates = tg(token, "getUpdates", **params)
        for u in updates:
            offset = max(offset or 0, u["update_id"] + 1)
            m = u.get("my_chat_member")
            c = (m or u.get("message") or u.get("channel_post") or {}).get("chat") or {}
            kind = {"private": "message privé", "channel": "chaîne"}.get(c.get("type"), "groupe" if c else "autre")
            seen[kind] = seen.get(kind, 0) + 1
            if c.get("type") == "channel" and c.get("id") not in channels:
                channels.add(c.get("id"))
                note("warning", "Chaîne", f"« {c.get('title', '?')} » est une chaîne, pas un groupe : le bot n'y lit pas les "
                     "signalements des membres. Il faut l'ajouter à un groupe")
            if c.get("type") not in ("group", "supergroup"):
                continue
            g = found.setdefault(str(c["id"]), {"title": c.get("title", "?"), "status": "membre"})
            if m:
                g["status"] = m.get("new_chat_member", {}).get("status", g["status"])
        if any(cid not in tests for cid in found) or time.time() > deadline:
            return found, seen
        if offset is None:
            offset = 0                 # rien en attente : on écoute (les mises à jour lues ici n'ont pas d'usage)


def check_group(token: str, me: dict, chat: str, reads_all: bool, test: bool) -> None:
    kind = "Groupe de test" if test else "Groupe"
    bad = "warning" if test else "error"        # un groupe de test absent ne bloque pas le déploiement
    try:
        info = tg(token, "getChat", chat_id=chat)
        member = tg(token, "getChatMember", chat_id=chat, user_id=me["id"])
        count = tg(token, "getChatMemberCount", chat_id=chat)
    except RuntimeError as e:
        var = "TG_TEST_CHAT_ID" if test else "TG_CHAT_ID"
        note(bad, kind, f"{e} : le bot n'est pas (ou plus) dans le groupe {chat}, ou {var} est faux")
        return
    status = member.get("status")
    note("notice", kind, f"« {info.get('title')} » · {count} membres · bot : {status}")
    if test and count > 200:
        note("warning", kind, f"{count} membres : le bot répond à chaque signalement dans un groupe de test. Si c'est le "
             "groupe de signalement, retire cet identifiant de TG_TEST_CHAT_ID et mets-le dans TG_CHAT_ID")
    if test and status == "restricted" and member.get("can_send_messages") is False:
        note("warning", kind, "le bot est en lecture seule dans ce groupe : il ne pourra pas répondre. Demande à l'admin de "
             "l'autoriser à envoyer des messages (ou de le passer admin sans aucun droit)")
    if status not in ("administrator", "member", "restricted"):
        note(bad, kind, f"le bot n'est pas membre du groupe (statut : {status}) : demande aux admins de l'ajouter")
    elif status != "administrator" and not reads_all:
        note(bad, "Lecture", "le bot ne reçoit que les commandes : dans @BotFather, /setprivacy → Disable, puis fais-le "
             "retirer et ré-ajouter au groupe ; ou demande aux admins de le passer admin (aucun droit nécessaire)")


def check(token: str, chat: str, tests: set[str]) -> None:
    me = tg(token, "getMe")
    reads_all = bool(me.get("can_read_all_group_messages"))
    note("notice", "Bot", f"@{me['username']} ({me['first_name']}) · mode confidentialité "
         + ("désactivé : il lit tous les messages des groupes" if reads_all else "actif : il ne lira tous les messages que s'il est admin du groupe"))
    # déploiement dès qu'il y a un groupe de signalement ou un groupe de test (où le bot répond sans rien enregistrer)
    output(mode="deploy" if chat or tests else "setup")
    if chat and chat in tests:
        note("warning", "Groupe de test", "TG_CHAT_ID figure aussi dans TG_TEST_CHAT_ID : ce groupe est traité comme le groupe "
             "de signalement (le bot y reste muet) ; retire-le de TG_TEST_CHAT_ID")
        tests = tests - {chat}
    for t in sorted(tests):
        check_group(token, me, t, reads_all, test=True)
    if chat:
        check_group(token, me, chat, reads_all, test=False)
        return
    # installation : identifiant du groupe de signalement
    found, seen = discover(token, tests)
    for cid, g in found.items():
        if cid in tests:
            continue
        note("notice", "Groupe trouvé", f"« {g['title']} » (bot : {g['status']}) → crée le secret TG_CHAT_ID = {cid} si c'est "
             f"le groupe de signalement, ou TG_TEST_CHAT_ID = {cid} si c'est un groupe de test, puis relance ce workflow")
    if not any(cid not in tests for cid in found) and tests:
        note("notice", "Groupe de signalement", "pas encore trouvé, normal tant que le bot n'y est pas : une fois qu'il y "
             "est ajouté, relance ce workflow, l'identifiant s'affichera ici")
    elif not any(cid not in tests for cid in found):
        recu = ", ".join(f"{n} {k}" for k, n in seen.items()) or "rien"
        note("warning", "Installation", f"aucun nouveau groupe trouvé (reçu de Telegram : {recu}) : le bot doit y avoir été "
             "ajouté il y a moins de 24 h, ou quelqu'un doit y écrire (moins de 24 h avant, ou pendant la minute où le "
             "workflow écoute) ; vérifie aussi que c'est bien ce bot qui est dans le groupe")


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
            tests = {t for t in re.split(r"[\s,;]+", os.environ.get("TG_TEST_CHAT_ID", "")) if t}
            check(token, os.environ.get("TG_CHAT_ID", "").strip(), tests)
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
