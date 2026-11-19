"""Configuration centrale. Importé en premier pour que .env soit lu avant tout le reste."""
import logging
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

log = logging.getLogger("cool_messenger")

APP_NAME = "COOL MESSENGER"
DATA_DIR = Path(os.getenv("DATA_DIR") or ROOT / "data").resolve()
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL", "").strip() or f"sqlite:///{(DATA_DIR / 'cool_messenger.db').as_posix()}"
# Les hébergeurs donnent des adresses "postgres://" ou "postgresql://" : on précise le pilote installé.
for _prefix in ("postgres://", "postgresql://"):
    if DATABASE_URL.startswith(_prefix):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(_prefix):]

_WEAK_SECRETS = {"dev-only-change-this-secret", "replace-with-a-long-random-secret"}


def _load_secret_key() -> str:
    """Clé de signature des sessions : celle de .env si elle est solide, sinon une clé
    aléatoire générée une fois et conservée dans le dossier de données."""
    key = os.getenv("SECRET_KEY", "").strip()
    if len(key) >= 32 and key not in _WEAK_SECRETS:
        return key
    if key:
        log.warning("SECRET_KEY trop faible ou par défaut : elle est ignorée.")
    key_file = DATA_DIR / ".secret_key"
    if key_file.exists():
        stored = key_file.read_text(encoding="utf-8").strip()
        if len(stored) >= 32:
            return stored
    key = secrets.token_urlsafe(48)
    key_file.write_text(key, encoding="utf-8")
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    return key


SECRET_KEY = _load_secret_key()
TOKEN_DAYS = 7

# Application Android (paquet généré par PWABuilder) : contenu du fichier assetlinks.json qu'il fournit.
# Servi à /.well-known/assetlinks.json ; il permet à l'application de s'ouvrir sans barre d'adresse.
ANDROID_ASSETLINKS = os.getenv("ANDROID_ASSETLINKS", "").strip()

# Documentation interactive (/docs) désactivée sauf demande explicite.
ENABLE_DOCS = os.getenv("ENABLE_DOCS", "").strip().lower() in {"1", "true", "yes"}

MB = 1024 * 1024
# Taille maximale par fichier envoyé. Les fichiers sont stockés dans la base (1 Go gratuit chez Neon) :
# des limites modestes évitent de la remplir avec quelques vidéos.
MAX_FILE_BYTES = {
    "voice": 12 * MB,
    "audio": 15 * MB,
    "image": 8 * MB,   # les photos sont déjà réduites par l'application avant l'envoi
    "video": 20 * MB,
}
MAX_AVATAR_BYTES = 1 * MB
MAX_AUDIO_BYTES = MAX_FILE_BYTES["voice"]
MAX_BODY_BYTES = max(MAX_FILE_BYTES.values()) + 1 * MB
MAX_GROUP_MEMBERS = 100
MAX_POST_IMAGE_BYTES = 6 * MB

# Comptes administrateurs (modération), séparés par des virgules. Ex. : ADMIN_USERNAMES=fatima
ADMIN_USERNAMES = {u.strip().lower() for u in os.getenv("ADMIN_USERNAMES", "").split(",") if u.strip()}
# Contact indiqué aux services de notification (obligatoire pour eux). Une adresse générique suffit.
PUSH_CONTACT = os.getenv("PUSH_CONTACT", "").strip() or "mailto:contact@coolmessenger.app"

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "").strip()
SMS_ENABLED = bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER)
# Nombre maximal de SMS par utilisateur et par jour (chaque SMS est facturé).
SMS_DAILY_LIMIT = max(0, int(os.getenv("SMS_DAILY_LIMIT", "10") or 10))
