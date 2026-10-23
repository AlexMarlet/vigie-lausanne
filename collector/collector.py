"""
Vigie — collecteur Telegram.

Écoute le groupe/canal où les gens signalent les contrôleurs, transforme chaque message
en signalement (arrêt, ligne, type) et l'envoie dans la table Supabase `signalements`.

Données minimales (nLPD) : on ne stocke NI le texte du message, NI l'expéditeur.
Seuls le type, l'arrêt, la ligne, l'heure du message et une empreinte anonyme
(pour éviter les doublons) sont conservés.

Usage :
    python collector.py --login        # 1re fois : connexion Telegram, affiche la session à mettre dans .env
    python collector.py --list         # liste tes groupes/canaux avec leur ID (à mettre dans TG_CHANNEL)
    python collector.py --dry-run      # lit les 2 dernières heures et affiche ce qui serait envoyé
    python collector.py                # rattrape les 2 dernières heures puis écoute en continu
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import pathlib
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession

from vigie_parser import Gazetteer, parse_message

HERE = pathlib.Path(__file__).parent
load_dotenv(HERE / ".env")
log = logging.getLogger("vigie")

API_ID = int(os.environ.get("TG_API_ID", "0"))
API_HASH = os.environ.get("TG_API_HASH", "")
SESSION = os.environ.get("TG_SESSION", "")
CHANNEL = os.environ.get("TG_CHANNEL", "")            # ID donné par --list (ex. -1001234567890), @nom ou lien public t.me/...
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# clé secrète sb_secret_… (Settings > API Keys) ; l'ancienne clé service_role (eyJ…) marche aussi
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_KEY", "")
SALT = os.environ.get("VIGIE_SALT", "change-moi")      # rend l'empreinte non réversible
BACKFILL_MIN = int(os.environ.get("VIGIE_BACKFILL_MIN", "120"))

GAZ = Gazetteer(json.loads((HERE / "stops.json").read_text(encoding="utf-8")))


def fingerprint(chat_id: int, msg_id: int) -> str:
    return hashlib.sha256(f"{SALT}:{chat_id}:{msg_id}".encode()).hexdigest()[:24]


def to_row(chat_id: int, msg_id: int, text: str, date: datetime) -> dict | None:
    p = parse_message(text, GAZ)
    if not p["usable"]:
        return None
    return {
        "kind": p["kind"],
        "sub": p["sub"],
        "of_kind": p["of"],
        "stop_id": p["stop_id"],
        "line": p["line"],
        "src": "telegram",
        "ext_id": fingerprint(chat_id, msg_id),
        "at": date.astimezone(timezone.utc).isoformat(),
    }


class Sink:
    """Envoie les lignes vers Supabase (ou les affiche en mode --dry-run)."""

    def __init__(self, dry: bool):
        self.dry = dry
        self.http = httpx.AsyncClient(timeout=10)

    async def push(self, row: dict) -> None:
        if self.dry:
            print("→", json.dumps(row, ensure_ascii=False))
            return
        headers = {
            "apikey": SUPABASE_KEY,           # nouvelles clés : uniquement dans l'en-tête apikey
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=minimal",
        }
        if SUPABASE_KEY.startswith("eyJ"):    # ancienne clé service_role (JWT) : aussi en Bearer
            headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
        r = await self.http.post(f"{SUPABASE_URL}/rest/v1/signalements?on_conflict=src,ext_id", headers=headers, json=row)
        if r.status_code >= 300:
            log.warning("Supabase %s : %s", r.status_code, r.text[:200])


async def run(dry: bool) -> None:
    if not (API_ID and API_HASH and SESSION and CHANNEL):
        raise SystemExit("Renseigne TG_API_ID, TG_API_HASH, TG_SESSION et TG_CHANNEL dans .env (voir .env.example).")
    if not dry and not (SUPABASE_URL and SUPABASE_KEY):
        raise SystemExit("Renseigne SUPABASE_URL et SUPABASE_SECRET_KEY, ou lance avec --dry-run.")

    sink = Sink(dry)
    client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
    await client.start()
    target = int(CHANNEL) if CHANNEL.lstrip("-").isdigit() else CHANNEL
    if isinstance(target, int):
        await client.get_dialogs()          # met en cache l'accès au groupe (nécessaire pour un ID numérique)
    chat = await client.get_entity(target)

    # 1) rattrapage : les signalements récents comptent encore dans l'indice de confiance
    since = datetime.now(timezone.utc) - timedelta(minutes=BACKFILL_MIN)
    seen = kept = 0
    async for m in client.iter_messages(chat, limit=500):
        if m.date < since:
            break
        seen += 1
        row = to_row(chat.id, m.id, m.raw_text or "", m.date)
        if row:
            kept += 1
            await sink.push(row)
    log.info("Rattrapage : %d messages lus, %d signalements localisés", seen, kept)
    if dry:
        await client.disconnect()
        return

    # 2) écoute en continu
    @client.on(events.NewMessage(chats=chat))
    async def on_message(event):
        m = event.message
        row = to_row(chat.id, m.id, m.raw_text or "", m.date)
        if row:
            await sink.push(row)
            log.info("%s · %s · ligne %s", row["kind"], row["stop_id"], row["line"] or "-")

    log.info("En écoute sur %s…", CHANNEL)
    await client.run_until_disconnected()


async def login() -> None:
    if not (API_ID and API_HASH):
        raise SystemExit("Renseigne d'abord TG_API_ID et TG_API_HASH (https://my.telegram.org → API development tools).")
    async with TelegramClient(StringSession(), API_ID, API_HASH) as client:
        print("\nCopie cette ligne dans .env (garde-la secrète) :\n")
        print("TG_SESSION=" + client.session.save())


async def list_chats() -> None:
    if not (API_ID and API_HASH and SESSION):
        raise SystemExit("Lance d'abord : python collector.py --login, puis colle TG_SESSION dans .env.")
    async with TelegramClient(StringSession(SESSION), API_ID, API_HASH) as client:
        print(f"{'ID':<18}Nom")
        async for d in client.iter_dialogs():
            if d.is_group or d.is_channel:
                print(f"{d.id:<18}{d.name}")
        print("\nCopie l'ID du groupe des contrôleurs dans TG_CHANNEL (fichier .env).")


def main() -> None:
    ap = argparse.ArgumentParser(description="Collecteur Telegram de Vigie")
    ap.add_argument("--login", action="store_true", help="se connecter à Telegram et générer TG_SESSION")
    ap.add_argument("--list", action="store_true", help="lister tes groupes et canaux avec leur ID")
    ap.add_argument("--dry-run", action="store_true", help="n'écrit rien, affiche les signalements détectés")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(login() if a.login else list_chats() if a.list else run(a.dry_run))


if __name__ == "__main__":
    main()
