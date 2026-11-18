import json
import logging
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import config  # doit rester le premier import local : il charge .env
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, case, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import get_db, init_db
from .models import Message, User, now_utc
from .security import DUMMY_HASH, create_token, hash_password, limiter, read_token, verify_password
from .sms import send_sms

# Sans cela, certains serveurs envoient l'APK comme fichier texte et Android refuse de l'ouvrir.
mimetypes.add_type("application/vnd.android.package-archive", ".apk")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
init_db()

docs = {} if config.ENABLE_DOCS else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title=config.APP_NAME, version="2.0.0", **docs)
STATIC = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; "
    "form-action 'self'; frame-ancestors 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > config.MAX_BODY_BYTES:
        return JSONResponse({"detail": "Envoi trop volumineux."}, status_code=413)
    response = await call_next(request)
    h = response.headers
    h["Content-Security-Policy"] = CSP
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Referrer-Policy"] = "no-referrer"
    h["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"
    h["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.scheme == "https":
        h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    path = request.url.path
    if path.startswith(("/api/", "/media/")):
        h["Cache-Control"] = "no-store"
    else:
        h.setdefault("Cache-Control", "no-cache")
    return response


FIELD_ERRORS = {
    "username": "Nom d'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret, souligné).",
    "display_name": "Nom affiché : 1 à 80 caractères.",
    "password": "Mot de passe : 8 à 128 caractères.",
    "phone": "Téléphone : utilisez le format international, par exemple +2250700000000.",
    "to_number": "Numéro : utilisez le format international, par exemple +2250700000000.",
    "body": "Le message est vide ou trop long.",
}


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    for err in exc.errors():
        loc = err.get("loc") or ()
        if loc and loc[-1] in FIELD_ERRORS:
            return JSONResponse({"detail": FIELD_ERRORS[loc[-1]]}, status_code=422)
    return JSONResponse({"detail": "Données invalides."}, status_code=422)


# ---------- Schémas ----------

PHONE_RE = re.compile(r"^\+[1-9]\d{6,14}$")


def normalize_phone(value: str) -> str:
    cleaned = re.sub(r"[\s().-]", "", value)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    if not PHONE_RE.match(cleaned):
        raise ValueError("format international attendu")
    return cleaned


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)
    phone: str | None = Field(default=None, max_length=30)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v or any(ord(c) < 32 for c in v):
            raise ValueError("nom vide")
        return v

    @field_validator("phone")
    @classmethod
    def clean_phone(cls, v: str | None) -> str | None:
        return normalize_phone(v) if v and v.strip() else None


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class TextIn(BaseModel):
    recipient_id: int
    body: str = Field(min_length=1, max_length=5000)

    @field_validator("body")
    @classmethod
    def clean_body(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message vide")
        return v


class SmsIn(BaseModel):
    to_number: str = Field(min_length=7, max_length=30)
    body: str = Field(min_length=1, max_length=480)

    @field_validator("to_number")
    @classmethod
    def clean_number(cls, v: str) -> str:
        return normalize_phone(v)

    @field_validator("body")
    @classmethod
    def clean_body(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message vide")
        return v


# ---------- Aides ----------

def client_ip(request: Request) -> str:
    return request.client.host if request.client else "inconnu"


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Connectez-vous.")
    uid = read_token(authorization[7:])
    user = db.get(User, uid) if uid else None
    if not user:
        raise HTTPException(401, "Session expirée. Reconnectez-vous.")
    return user


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:  # SQLite rend des dates sans fuseau : elles sont en UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def own_json(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "phone": u.phone}


def message_json(m: Message) -> dict:
    return {
        "id": m.id, "sender_id": m.sender_id, "recipient_id": m.recipient_id,
        "body": m.body, "media_url": f"/media/{m.id}" if m.media_path else None,
        "media_type": m.media_type, "created_at": iso(m.created_at),
    }


def get_peer(db: Session, user: User, other_id: int) -> User:
    other = db.get(User, other_id) if other_id != user.id else None
    if not other:
        raise HTTPException(404, "Contact introuvable.")
    return other


def sniff_audio(head: bytes) -> tuple[str, str] | None:
    """Reconnaît le format d'après le contenu réel, pas d'après ce qu'annonce le client."""
    if head[:4] == b"\x1aE\xdf\xa3":
        return ".webm", "audio/webm"
    if head[:4] == b"OggS":
        return ".ogg", "audio/ogg"
    if head[4:8] == b"ftyp":
        return ".m4a", "audio/mp4"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav", "audio/wav"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return ".mp3", "audio/mpeg"
    return None


# ---------- Pages ----------

@app.get("/", include_in_schema=False)
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/installer", include_in_schema=False)
def installer():
    """Page à partager : installation guidée sur iPhone, Android ou ordinateur."""
    return FileResponse(STATIC / "installer.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    # Servi à la racine pour que son périmètre couvre toute l'application.
    return FileResponse(STATIC / "sw.js", media_type="text/javascript")


@app.get("/.well-known/assetlinks.json", include_in_schema=False)
def android_asset_links():
    """Preuve, pour Android, que l'application installée appartient bien à ce site."""
    if not config.ANDROID_ASSETLINKS:
        raise HTTPException(404, "Non configuré.")
    try:
        data = json.loads(config.ANDROID_ASSETLINKS)
    except ValueError:
        logging.getLogger("cool_messenger").error("ANDROID_ASSETLINKS n'est pas un JSON valide.")
        raise HTTPException(404, "Non configuré.")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def public_config():
    return {"sms_enabled": config.SMS_ENABLED, "sms_daily_limit": config.SMS_DAILY_LIMIT}


# ---------- Comptes ----------

@app.post("/api/register")
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    limiter.hit(f"register:{client_ip(request)}", 20, 3600, "Trop de comptes créés depuis cette connexion. Réessayez plus tard.")
    username = data.username.lower()
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    user = User(username=username, display_name=data.display_name, password_hash=hash_password(data.password), phone=data.phone)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    db.refresh(user)
    return {"token": create_token(user.id), "user": own_json(user)}


@app.post("/api/login")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    ip, username = client_ip(request), data.username.strip().lower()
    limiter.hit(f"login-ip:{ip}", 60, 600)
    limiter.hit(f"login:{ip}:{username}", 8, 300, "Trop de tentatives de connexion. Patientez quelques minutes.")
    user = db.query(User).filter(User.username == username).first()
    valid = verify_password(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, "Identifiants incorrects.")
    return {"token": create_token(user.id), "user": own_json(user)}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return own_json(user)


@app.get("/api/users")
def users(q: str = Query("", max_length=80), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Contacts avec dernier message et nombre de non-lus. Les numéros de téléphone ne sont jamais partagés."""
    limiter.hit(f"users:{user.id}", 120, 60)
    peer = case((Message.sender_id == user.id, Message.recipient_id), else_=Message.sender_id)
    last_ids = dict(
        db.query(peer, func.max(Message.id))
        .filter(or_(Message.sender_id == user.id, Message.recipient_id == user.id))
        .group_by(peer).all()
    )
    unread = dict(
        db.query(Message.sender_id, func.count(Message.id))
        .filter(Message.recipient_id == user.id, Message.read_at.is_(None))
        .group_by(Message.sender_id).all()
    )
    base = db.query(User).filter(User.id != user.id)
    q = q.strip()
    if q:
        found = base.filter(or_(
            User.username.contains(q.lower(), autoescape=True),
            User.display_name.icontains(q, autoescape=True),
        )).order_by(User.display_name).limit(100).all()
    else:
        found = base.filter(User.id.in_(last_ids)).all() if last_ids else []
        found += base.filter(User.id.notin_(last_ids)).order_by(User.display_name).limit(100).all()
    wanted = [last_ids[u.id] for u in found if u.id in last_ids]
    lasts = {m.id: m for m in db.query(Message).filter(Message.id.in_(wanted)).all()} if wanted else {}

    def row(u: User) -> dict:
        m = lasts.get(last_ids.get(u.id))
        last = None
        if m:
            last = {"id": m.id, "mine": m.sender_id == user.id, "voice": bool(m.media_path),
                    "body": (m.body or "")[:120], "created_at": iso(m.created_at)}
        return {"id": u.id, "username": u.username, "display_name": u.display_name,
                "unread": unread.get(u.id, 0), "last": last}

    rows = [row(u) for u in found]
    rows.sort(key=lambda r: (0, -r["last"]["id"], "") if r["last"] else (1, 0, r["display_name"].lower()))
    return rows


# ---------- Messages ----------

@app.get("/api/messages/{other_id}")
def history(other_id: int, after: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"history:{user.id}", 180, 60)
    get_peer(db, user, other_id)
    pair = db.query(Message).filter(or_(
        and_(Message.sender_id == user.id, Message.recipient_id == other_id),
        and_(Message.sender_id == other_id, Message.recipient_id == user.id),
    ))
    if after:
        rows = pair.filter(Message.id > after).order_by(Message.id.asc()).limit(500).all()
    else:
        rows = pair.order_by(Message.id.desc()).limit(500).all()[::-1]
    marked = db.query(Message).filter(
        Message.sender_id == other_id, Message.recipient_id == user.id, Message.read_at.is_(None)
    ).update({Message.read_at: now_utc()}, synchronize_session=False)
    out = [message_json(m) for m in rows]
    if marked:
        db.commit()
    return out


@app.post("/api/messages")
def send_text(data: TextIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"msg:{user.id}", 40, 60, "Vous envoyez trop de messages. Patientez un instant.")
    get_peer(db, user, data.recipient_id)
    m = Message(sender_id=user.id, recipient_id=data.recipient_id, body=data.body)
    db.add(m)
    db.commit()
    db.refresh(m)
    return message_json(m)


@app.post("/api/voice")
async def send_voice(recipient_id: int = Form(...), audio: UploadFile = File(...),
                     user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"voice:{user.id}", 12, 60, "Vous envoyez trop de messages vocaux. Patientez un instant.")
    get_peer(db, user, recipient_id)
    chunks, size = [], 0
    while chunk := await audio.read(64 * 1024):
        size += len(chunk)
        if size > config.MAX_AUDIO_BYTES:
            raise HTTPException(413, "Audio trop volumineux (12 Mo maximum).")
        chunks.append(chunk)
    data = b"".join(chunks)
    kind = sniff_audio(data[:16])
    if not kind:
        raise HTTPException(415, "Le fichier doit être un enregistrement audio.")
    ext, media_type = kind
    name = f"{uuid.uuid4().hex}{ext}"
    m = Message(sender_id=user.id, recipient_id=recipient_id, media_path=name, media_type=media_type,
                media_data=data, body="Message vocal")
    db.add(m)
    db.commit()
    db.refresh(m)
    return message_json(m)


@app.get("/media/{message_id}")
def media(message_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = db.get(Message, message_id)
    if not m or user.id not in (m.sender_id, m.recipient_id) or not m.media_path:
        raise HTTPException(404, "Fichier introuvable.")
    media_type = m.media_type or "application/octet-stream"
    if m.media_data is not None:
        return Response(m.media_data, media_type=media_type, headers={"Content-Disposition": "inline"})
    path = config.UPLOADS_DIR / Path(m.media_path).name  # vocaux enregistrés par une version antérieure
    if not path.is_file():
        raise HTTPException(404, "Fichier introuvable.")
    return FileResponse(path, media_type=media_type, headers={"Content-Disposition": "inline"})


@app.post("/api/sms")
def sms(data: SmsIn, user: User = Depends(current_user)):
    if not config.SMS_ENABLED:
        raise HTTPException(503, "L'envoi de SMS n'est pas activé sur ce serveur.")
    limiter.hit(f"sms:{user.id}", config.SMS_DAILY_LIMIT, 86400,
                f"Limite de {config.SMS_DAILY_LIMIT} SMS par jour atteinte.")
    ok, detail = send_sms(data.to_number, data.body)
    if not ok:
        raise HTTPException(502, detail)
    logging.getLogger("cool_messenger.sms").info("SMS envoyé par l'utilisateur %s", user.id)
    return {"status": "sent", "message": "SMS transmis au fournisseur."}
