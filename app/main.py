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
from sqlalchemy import and_, case, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import get_db, init_db
from .models import Block, Group, GroupMember, Message, User, now_utc
from .security import DUMMY_HASH, create_token, hash_password, limiter, read_token, verify_password
from .sms import send_sms

# Sans cela, certains serveurs envoient l'APK comme fichier texte et Android refuse de l'ouvrir.
mimetypes.add_type("application/vnd.android.package-archive", ".apk")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
init_db()

docs = {} if config.ENABLE_DOCS else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title=config.APP_NAME, version="3.0.0", **docs)
STATIC = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
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
    "new_password": "Nouveau mot de passe : 8 à 128 caractères.",
    "name": "Nom du groupe : 1 à 80 caractères.",
    "member_ids": "Choisissez entre 1 et 100 membres.",
    "user_ids": "Choisissez entre 1 et 100 membres.",
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
    recipient_id: int | None = None
    group_id: int | None = None
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


def clean_display_name(v: str) -> str:
    v = " ".join(v.split())
    if not v or any(ord(c) < 32 for c in v):
        raise ValueError("nom vide")
    return v


class ProfileIn(BaseModel):
    """Champs absents = inchangés. Téléphone vide = supprimé."""
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    username: str | None = Field(default=None, min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    phone: str | None = Field(default=None, max_length=30)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, v: str | None) -> str | None:
        return clean_display_name(v) if v is not None else None

    @field_validator("phone")
    @classmethod
    def clean_phone(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return normalize_phone(v) if v.strip() else ""


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    member_ids: list[int] = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        return clean_display_name(v)


class GroupRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        return clean_display_name(v)


class MembersIn(BaseModel):
    user_ids: list[int] = Field(min_length=1, max_length=100)


# ---------- Aides ----------

def client_ip(request: Request) -> str:
    return request.client.host if request.client else "inconnu"


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Connectez-vous.")
    claims = read_token(authorization[7:])
    user = db.get(User, claims[0]) if claims else None
    # Version différente : le mot de passe a changé depuis, cette session est fermée.
    if not user or (user.token_version or 0) != claims[1]:
        raise HTTPException(401, "Session expirée. Reconnectez-vous.")
    return user


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:  # SQLite rend des dates sans fuseau : elles sont en UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def own_json(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "phone": u.phone,
            "avatar_v": u.avatar_version or 0}


def public_user(u: User) -> dict:
    """Ce que les autres voient d'un compte : jamais le téléphone."""
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "avatar_v": u.avatar_version or 0}


def message_json(m: Message, names: dict[int, str] | None = None) -> dict:
    has_file = bool(m.media_path)
    return {
        "id": m.id, "sender_id": m.sender_id, "recipient_id": m.recipient_id, "group_id": m.group_id,
        "sender_name": (names or {}).get(m.sender_id),
        "kind": m.kind or ("voice" if has_file else "text"),
        "body": m.body, "media_url": f"/media/{m.id}" if has_file else None,
        "media_type": m.media_type, "media_name": m.media_name, "media_size": m.media_size,
        "created_at": iso(m.created_at),
    }


def get_peer(db: Session, user: User, other_id: int) -> User:
    other = db.get(User, other_id) if other_id != user.id else None
    if not other:
        raise HTTPException(404, "Contact introuvable.")
    return other


def blocked_ids(db: Session, user_id: int) -> set[int]:
    """Comptes que user_id a bloqués."""
    return {b for (b,) in db.query(Block.blocked_id).filter(Block.blocker_id == user_id)}


def check_can_write(db: Session, user: User, other: User):
    if db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == other.id).first():
        raise HTTPException(403, "Vous avez bloqué ce contact. Débloquez-le pour lui écrire.")
    if db.query(Block).filter(Block.blocker_id == other.id, Block.blocked_id == user.id).first():
        raise HTTPException(403, "Impossible d'envoyer un message à ce contact.")


def get_membership(db: Session, user: User, group_id: int) -> tuple[Group, GroupMember]:
    group = db.get(Group, group_id)
    member = db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.user_id == user.id).first() if group else None
    if not member:
        raise HTTPException(404, "Groupe introuvable.")
    return group, member


def resolve_target(db: Session, user: User, recipient_id: int | None, group_id: int | None) -> dict:
    """Destination d'un message : un contact OU un groupe dont on est membre."""
    if (recipient_id is None) == (group_id is None):
        raise HTTPException(422, "Indiquez un destinataire ou un groupe.")
    if group_id is not None:
        get_membership(db, user, group_id)
        return {"group_id": group_id}
    other = get_peer(db, user, recipient_id)
    check_can_write(db, user, other)
    return {"recipient_id": other.id}


def sniff_audio(head: bytes) -> tuple[str, str] | None:
    """Reconnaît le format d'après le contenu réel, pas d'après ce qu'annonce le client."""
    if head[:4] == b"\x1aE\xdf\xa3":
        return ".webm", "audio/webm"
    if head[:4] == b"OggS":
        return ".ogg", "audio/ogg"
    if head[:4] == b"fLaC":
        return ".flac", "audio/flac"
    if head[4:8] == b"ftyp":
        return ".m4a", "audio/mp4"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav", "audio/wav"
    if len(head) > 1 and head[0] == 0xFF and head[1] & 0xF6 == 0xF0:
        return ".aac", "audio/aac"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return ".mp3", "audio/mpeg"
    return None


def sniff_image(head: bytes) -> tuple[str, str] | None:
    # Formats d'image « bitmap » seulement : pas de SVG, qui peut contenir du code.
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg", "image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png", "image/png"
    if head[:4] == b"GIF8":
        return ".gif", "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def sniff_video(head: bytes) -> tuple[str, str] | None:
    if head[:4] == b"\x1aE\xdf\xa3":
        return ".webm", "video/webm"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return ".mov", "video/quicktime"
        if brand.startswith(b"3g"):
            return ".3gp", "video/3gpp"
        return ".mp4", "video/mp4"
    return None


def sniff_file(kind: str, head: bytes) -> tuple[str, str] | None:
    if kind in ("voice", "audio"):
        return sniff_audio(head)
    if kind == "image":
        return sniff_image(head)
    if kind == "video":
        return sniff_video(head)
    return None


FILE_ERRORS = {
    "voice": "Le fichier doit être un enregistrement audio.",
    "audio": "Format audio non pris en charge (MP3, M4A, AAC, OGG, WAV, FLAC ou WebM).",
    "image": "Format d'image non pris en charge (JPEG, PNG, GIF ou WebP).",
    "video": "Format vidéo non pris en charge (MP4, MOV, 3GP ou WebM).",
}
KIND_LABELS = {"voice": "Message vocal", "audio": "Fichier audio", "image": "Photo", "video": "Vidéo"}


async def read_upload(upload: UploadFile, limit: int, too_big: str) -> bytes:
    chunks, size = [], 0
    while chunk := await upload.read(64 * 1024):
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, too_big)
        chunks.append(chunk)
    return b"".join(chunks)


def clean_file_name(name: str | None) -> str | None:
    if not name:
        return None
    name = Path(name.replace("\\", "/")).name
    name = "".join(c for c in name if ord(c) >= 32 and c not in '"<>|')
    return name[:120] or None


def user_names(db: Session, ids) -> dict[int, str]:
    ids = set(ids)
    return {u.id: u.display_name for u in db.query(User).filter(User.id.in_(ids))} if ids else {}


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
    return {"sms_enabled": config.SMS_ENABLED, "sms_daily_limit": config.SMS_DAILY_LIMIT,
            "max_file_mb": {k: v // config.MB for k, v in config.MAX_FILE_BYTES.items()}}


# ---------- Comptes ----------

@app.post("/api/register")
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    limiter.hit(f"register:{client_ip(request)}", 20, 3600, "Trop de comptes créés depuis cette connexion. Réessayez plus tard.")
    username = data.username.lower()
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    user = User(username=username, display_name=data.display_name, password_hash=hash_password(data.password),
                phone=data.phone, token_version=0, avatar_version=0)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    db.refresh(user)
    return {"token": create_token(user.id, user.token_version), "user": own_json(user)}


@app.post("/api/login")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    ip, username = client_ip(request), data.username.strip().lower()
    limiter.hit(f"login-ip:{ip}", 60, 600)
    limiter.hit(f"login:{ip}:{username}", 8, 300, "Trop de tentatives de connexion. Patientez quelques minutes.")
    user = db.query(User).filter(User.username == username).first()
    valid = verify_password(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, "Identifiants incorrects.")
    return {"token": create_token(user.id, user.token_version), "user": own_json(user)}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return own_json(user)


@app.patch("/api/me")
def update_profile(data: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"profile:{user.id}", 20, 3600, "Trop de modifications. Réessayez plus tard.")
    if data.username is not None:
        username = data.username.lower()
        if username != user.username:
            if db.query(User).filter(User.username == username).first():
                raise HTTPException(409, "Ce nom d'utilisateur est déjà pris.")
            user.username = username
    if data.display_name is not None:
        user.display_name = data.display_name
    if data.phone is not None:
        user.phone = data.phone or None
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Ce nom d'utilisateur est déjà pris.")
    db.refresh(user)
    return own_json(user)


@app.post("/api/me/password")
def change_password(data: PasswordIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"password:{user.id}", 6, 900, "Trop de tentatives. Patientez quelques minutes.")
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(400, "Le mot de passe actuel est incorrect.")
    if data.current_password == data.new_password:
        raise HTTPException(400, "Le nouveau mot de passe doit être différent de l'ancien.")
    user.password_hash = hash_password(data.new_password)
    # Toutes les autres sessions (autres téléphones, ordinateurs) sont fermées.
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    return {"token": create_token(user.id, user.token_version), "message": "Mot de passe modifié."}


@app.put("/api/me/avatar")
async def set_avatar(photo: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"avatar:{user.id}", 20, 3600, "Trop de changements de photo. Réessayez plus tard.")
    data = await read_upload(photo, config.MAX_AVATAR_BYTES, "Photo trop volumineuse (1 Mo maximum).")
    kind = sniff_image(data[:16])
    if not kind or kind[1] == "image/gif":
        raise HTTPException(415, "Choisissez une photo JPEG, PNG ou WebP.")
    user.avatar_data = data
    user.avatar_type = kind[1]
    user.avatar_version = (user.avatar_version or 0) + 1
    db.commit()
    return own_json(user)


@app.delete("/api/me/avatar")
def delete_avatar(user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.avatar_data = None
    user.avatar_type = None
    user.avatar_version = 0
    db.commit()
    return own_json(user)


@app.get("/api/users/{user_id}/avatar")
def get_avatar(user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if not target or not target.avatar_version or target.avatar_data is None:
        raise HTTPException(404, "Pas de photo.")
    return Response(target.avatar_data, media_type=target.avatar_type or "image/jpeg",
                    headers={"Content-Disposition": "inline"})


# ---------- Blocages ----------

@app.get("/api/blocks")
def list_blocks(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(User).join(Block, Block.blocked_id == User.id).filter(Block.blocker_id == user.id).order_by(User.display_name)
    return [public_user(u) for u in rows]


@app.post("/api/blocks/{user_id}")
def block_user(user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    other = get_peer(db, user, user_id)
    if not db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == other.id).first():
        db.add(Block(blocker_id=user.id, blocked_id=other.id))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    return {"blocked": True}


@app.delete("/api/blocks/{user_id}")
def unblock_user(user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == user_id).delete(synchronize_session=False)
    db.commit()
    return {"blocked": False}


# ---------- Liste des conversations ----------

def preview(m: Message, me_id: int, names: dict[int, str] | None = None) -> dict:
    kind = m.kind or ("voice" if m.media_path else "text")
    return {"id": m.id, "mine": m.sender_id == me_id, "kind": kind, "voice": kind != "text",
            "sender_name": (names or {}).get(m.sender_id),
            "body": (m.body or "")[:120] if kind == "text" else KIND_LABELS.get(kind, "Fichier"),
            "created_at": iso(m.created_at)}


def contact_rows(db: Session, user: User, q: str) -> list[dict]:
    direct = and_(Message.group_id.is_(None), or_(Message.sender_id == user.id, Message.recipient_id == user.id))
    peer = case((Message.sender_id == user.id, Message.recipient_id), else_=Message.sender_id)
    last_ids = dict(db.query(peer, func.max(Message.id)).filter(direct).group_by(peer).all())
    unread = dict(
        db.query(Message.sender_id, func.count(Message.id))
        .filter(Message.recipient_id == user.id, Message.group_id.is_(None), Message.read_at.is_(None))
        .group_by(Message.sender_id).all()
    )
    mine_blocked = blocked_ids(db, user.id)
    base = db.query(User).filter(User.id != user.id)
    if q:
        found = base.filter(or_(
            User.username.contains(q.lower(), autoescape=True),
            User.display_name.icontains(q, autoescape=True),
        )).order_by(User.display_name).limit(100).all()
    else:
        found = base.filter(User.id.in_(last_ids)).all() if last_ids else []
        found += base.filter(User.id.notin_(last_ids)).order_by(User.display_name).limit(100).all()
    wanted = [last_ids[u.id] for u in found if u.id in last_ids]
    lasts = {m.id: m for m in db.query(Message).filter(Message.id.in_(wanted))} if wanted else {}
    rows = []
    for u in found:
        m = lasts.get(last_ids.get(u.id))
        row = public_user(u)
        row.update({"type": "user", "unread": 0 if u.id in mine_blocked else unread.get(u.id, 0),
                    "blocked": u.id in mine_blocked, "last": preview(m, user.id) if m else None})
        rows.append(row)
    return rows


def group_rows(db: Session, user: User, q: str) -> list[dict]:
    memberships = db.query(GroupMember, Group).join(Group, Group.id == GroupMember.group_id).filter(GroupMember.user_id == user.id)
    if q:
        memberships = memberships.filter(Group.name.icontains(q, autoescape=True))
    memberships = memberships.all()
    if not memberships:
        return []
    gids = [g.id for _, g in memberships]
    hidden = blocked_ids(db, user.id)
    last_ids = dict(db.query(Message.group_id, func.max(Message.id)).filter(Message.group_id.in_(gids)).group_by(Message.group_id))
    lasts = {m.id: m for m in db.query(Message).filter(Message.id.in_(list(last_ids.values())))} if last_ids else {}
    counts = dict(db.query(GroupMember.group_id, func.count(GroupMember.id)).filter(GroupMember.group_id.in_(gids)).group_by(GroupMember.group_id))
    names = user_names(db, [m.sender_id for m in lasts.values()])
    rows = []
    for member, group in memberships:
        unread_q = db.query(func.count(Message.id)).filter(
            Message.group_id == group.id, Message.id > (member.last_read_id or 0), Message.sender_id != user.id)
        if hidden:
            unread_q = unread_q.filter(Message.sender_id.notin_(hidden))
        m = lasts.get(last_ids.get(group.id))
        rows.append({"type": "group", "id": group.id, "name": group.name, "display_name": group.name,
                     "members": counts.get(group.id, 0), "is_admin": bool(member.is_admin),
                     "unread": unread_q.scalar() or 0, "last": preview(m, user.id, names) if m else None})
    return rows


@app.get("/api/conversations")
def conversations(q: str = Query("", max_length=80), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Contacts et groupes, les plus récents en premier. Les numéros de téléphone ne sont jamais partagés."""
    limiter.hit(f"users:{user.id}", 120, 60)
    q = q.strip()
    rows = group_rows(db, user, q) + contact_rows(db, user, q)
    rows.sort(key=lambda r: (0, -r["last"]["id"], "") if r["last"] else (1, 0, r["display_name"].lower()))
    return rows


@app.get("/api/users")
def users(q: str = Query("", max_length=80), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Contacts seuls (utilisé aussi par les applications pas encore mises à jour)."""
    limiter.hit(f"users:{user.id}", 120, 60)
    rows = contact_rows(db, user, q.strip())
    rows.sort(key=lambda r: (0, -r["last"]["id"], "") if r["last"] else (1, 0, r["display_name"].lower()))
    return rows


# ---------- Messages à deux ----------

def page(query, after: int) -> list[Message]:
    if after:
        return query.filter(Message.id > after).order_by(Message.id.asc()).limit(500).all()
    return query.order_by(Message.id.desc()).limit(500).all()[::-1]


@app.get("/api/messages/{other_id}")
def history(other_id: int, after: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"history:{user.id}", 180, 60)
    get_peer(db, user, other_id)
    pair = db.query(Message).filter(Message.group_id.is_(None), or_(
        and_(Message.sender_id == user.id, Message.recipient_id == other_id),
        and_(Message.sender_id == other_id, Message.recipient_id == user.id),
    ))
    rows = page(pair, after)
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
    target = resolve_target(db, user, data.recipient_id, data.group_id)
    m = Message(sender_id=user.id, body=data.body, kind="text", **target)
    db.add(m)
    db.commit()
    db.refresh(m)
    return message_json(m, {user.id: user.display_name})


async def store_file(db: Session, user: User, kind: str, upload: UploadFile,
                     recipient_id: int | None, group_id: int | None, name: str | None = None) -> dict:
    if kind not in config.MAX_FILE_BYTES:
        raise HTTPException(422, "Type de fichier inconnu.")
    limiter.hit(f"media:{user.id}", 20, 60, "Vous envoyez trop de fichiers. Patientez un instant.")
    target = resolve_target(db, user, recipient_id, group_id)
    limit = config.MAX_FILE_BYTES[kind]
    data = await read_upload(upload, limit, f"{KIND_LABELS[kind]} trop volumineux ({limit // config.MB} Mo maximum).")
    found = sniff_file(kind, data[:16])
    if not found:
        raise HTTPException(415, FILE_ERRORS[kind])
    ext, media_type = found
    m = Message(sender_id=user.id, kind=kind, body=KIND_LABELS[kind],
                media_path=f"{uuid.uuid4().hex}{ext}", media_type=media_type, media_data=data, media_size=len(data),
                media_name=clean_file_name(name or upload.filename) if kind != "voice" else None, **target)
    db.add(m)
    db.commit()
    db.refresh(m)
    return message_json(m, {user.id: user.display_name})


@app.post("/api/media")
async def send_media(kind: str = Form(...), file: UploadFile = File(...),
                     recipient_id: int | None = Form(None), group_id: int | None = Form(None), name: str | None = Form(None),
                     user: User = Depends(current_user), db: Session = Depends(get_db)):
    return await store_file(db, user, kind, file, recipient_id, group_id, name)


@app.post("/api/voice")
async def send_voice(recipient_id: int | None = Form(None), group_id: int | None = Form(None), audio: UploadFile = File(...),
                     user: User = Depends(current_user), db: Session = Depends(get_db)):
    return await store_file(db, user, "voice", audio, recipient_id, group_id)


@app.get("/media/{message_id}")
def media(message_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = db.get(Message, message_id)
    allowed = False
    if m and m.media_path:
        if m.group_id is not None:
            allowed = db.query(GroupMember).filter(GroupMember.group_id == m.group_id, GroupMember.user_id == user.id).first() is not None
        else:
            allowed = user.id in (m.sender_id, m.recipient_id)
    if not allowed:
        raise HTTPException(404, "Fichier introuvable.")
    media_type = m.media_type or "application/octet-stream"
    if m.media_data is not None:
        return Response(m.media_data, media_type=media_type, headers={"Content-Disposition": "inline"})
    path = config.UPLOADS_DIR / Path(m.media_path).name  # vocaux enregistrés par une version antérieure
    if not path.is_file():
        raise HTTPException(404, "Fichier introuvable.")
    return FileResponse(path, media_type=media_type, headers={"Content-Disposition": "inline"})


# ---------- Groupes ----------

def group_json(db: Session, group: Group, me: GroupMember) -> dict:
    rows = (db.query(GroupMember, User).join(User, User.id == GroupMember.user_id)
            .filter(GroupMember.group_id == group.id).order_by(GroupMember.is_admin.desc(), User.display_name).all())
    members = []
    for member, u in rows:
        item = public_user(u)
        item["is_admin"] = bool(member.is_admin)
        members.append(item)
    return {"type": "group", "id": group.id, "name": group.name, "display_name": group.name,
            "is_admin": bool(me.is_admin), "members": members}


def existing_user_ids(db: Session, ids, exclude: int) -> list[int]:
    wanted = {i for i in ids if i != exclude}
    return [i for (i,) in db.query(User.id).filter(User.id.in_(wanted))] if wanted else []


@app.post("/api/groups")
def create_group(data: GroupIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"group-new:{user.id}", 10, 3600, "Trop de groupes créés. Réessayez plus tard.")
    member_ids = existing_user_ids(db, data.member_ids, user.id)
    if not member_ids:
        raise HTTPException(422, "Ajoutez au moins un autre membre.")
    if len(member_ids) + 1 > config.MAX_GROUP_MEMBERS:
        raise HTTPException(422, f"Un groupe compte au plus {config.MAX_GROUP_MEMBERS} membres.")
    group = Group(name=data.name, created_by=user.id)
    db.add(group)
    db.flush()
    me_member = GroupMember(group_id=group.id, user_id=user.id, is_admin=True, last_read_id=0)
    db.add(me_member)
    db.add_all([GroupMember(group_id=group.id, user_id=i, is_admin=False, last_read_id=0) for i in member_ids])
    db.commit()
    return group_json(db, group, me_member)


@app.get("/api/groups/{group_id}")
def get_group(group_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    group, member = get_membership(db, user, group_id)
    return group_json(db, group, member)


@app.patch("/api/groups/{group_id}")
def rename_group(group_id: int, data: GroupRenameIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    group, member = get_membership(db, user, group_id)
    if not member.is_admin:
        raise HTTPException(403, "Seul un administrateur du groupe peut le renommer.")
    group.name = data.name
    db.commit()
    return group_json(db, group, member)


@app.post("/api/groups/{group_id}/members")
def add_members(group_id: int, data: MembersIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    group, member = get_membership(db, user, group_id)
    if not member.is_admin:
        raise HTTPException(403, "Seul un administrateur peut ajouter des membres.")
    current = {i for (i,) in db.query(GroupMember.user_id).filter(GroupMember.group_id == group_id)}
    new_ids = [i for i in existing_user_ids(db, data.user_ids, user.id) if i not in current]
    if len(current) + len(new_ids) > config.MAX_GROUP_MEMBERS:
        raise HTTPException(422, f"Un groupe compte au plus {config.MAX_GROUP_MEMBERS} membres.")
    # Les nouveaux membres ne voient pas les messages non lus d'avant leur arrivée comme « non lus ».
    last = db.query(func.max(Message.id)).filter(Message.group_id == group_id).scalar() or 0
    db.add_all([GroupMember(group_id=group_id, user_id=i, is_admin=False, last_read_id=last) for i in new_ids])
    db.commit()
    return group_json(db, group, member)


@app.delete("/api/groups/{group_id}/members/{user_id}")
def remove_member(group_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    group, member = get_membership(db, user, group_id)
    if user_id != user.id and not member.is_admin:
        raise HTTPException(403, "Seul un administrateur peut retirer un membre.")
    target = db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.user_id == user_id).first()
    if not target:
        raise HTTPException(404, "Ce membre ne fait pas partie du groupe.")
    db.delete(target)
    db.flush()
    # Le groupe garde toujours un administrateur : le plus ancien membre prend le relais.
    if not db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.is_admin.is_(True)).first():
        heir = db.query(GroupMember).filter(GroupMember.group_id == group_id).order_by(GroupMember.joined_at, GroupMember.id).first()
        if heir:
            heir.is_admin = True
    db.commit()
    if user_id == user.id:
        return {"left": True}
    return group_json(db, group, member)


@app.get("/api/groups/{group_id}/messages")
def group_history(group_id: int, after: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"history:{user.id}", 180, 60)
    group, member = get_membership(db, user, group_id)
    query = db.query(Message).filter(Message.group_id == group_id)
    hidden = blocked_ids(db, user.id)
    if hidden:
        query = query.filter(Message.sender_id.notin_(hidden))
    rows = page(query, after)
    newest = db.query(func.max(Message.id)).filter(Message.group_id == group_id).scalar() or 0
    if newest > (member.last_read_id or 0):
        db.execute(update(GroupMember).where(GroupMember.id == member.id).values(last_read_id=newest))
        db.commit()
    names = user_names(db, [m.sender_id for m in rows])
    return [message_json(m, names) for m in rows]


# ---------- SMS ----------

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
