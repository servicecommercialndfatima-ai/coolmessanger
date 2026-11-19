import json
import logging
import mimetypes
import re
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from . import config  # doit rester le premier import local : il charge .env
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, case, false, func, or_, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import push
from .database import IS_SQLITE, engine, get_db, init_db
from .models import (REQUEST_SPACES, SPACES, Block, ContactRequest, Group, GroupMember, Message, Post, Profile,
                     PushSubscription, Report, User, now_utc)
from .security import DUMMY_HASH, create_token, hash_password, limiter, read_token, verify_password
from .sms import send_sms

# Sans cela, certains serveurs envoient l'APK comme fichier texte et Android refuse de l'ouvrir.
mimetypes.add_type("application/vnd.android.package-archive", ".apk")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cool_messenger")
init_db()

docs = {} if config.ENABLE_DOCS else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title=config.APP_NAME, version="4.0.0", **docs)
STATIC = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
    "media-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; "
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
    if request.url.path.startswith(("/api/", "/media/")):
        h["Cache-Control"] = "no-store"
    else:
        h.setdefault("Cache-Control", "no-cache")
    return response


FIELD_ERRORS = {
    "username": "Nom d'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret, souligné).",
    "display_name": "Nom du profil : 1 à 80 caractères.",
    "password": "Mot de passe : 8 à 128 caractères.",
    "phone": "Téléphone : utilisez le format international, par exemple +2250700000000.",
    "to_number": "Numéro : utilisez le format international, par exemple +2250700000000.",
    "body": "Le message est vide ou trop long.",
    "new_password": "Nouveau mot de passe : 8 à 128 caractères.",
    "name": "Nom du groupe : 1 à 80 caractères.",
    "member_pids": "Choisissez entre 1 et 100 membres.",
    "pids": "Choisissez entre 1 et 100 membres.",
    "bio": "Biographie : 600 caractères au maximum.",
    "activities": "Activités : 600 caractères au maximum.",
    "company": "Nom de l'entreprise : 2 à 120 caractères.",
    "website": "Site internet : adresse commençant par http:// ou https://.",
    "birth_date": "Date de naissance invalide.",
    "message": "Message de présentation : 300 caractères au maximum.",
    "details": "Détails : 1000 caractères au maximum.",
}


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    for err in exc.errors():
        loc = err.get("loc") or ()
        if loc and loc[-1] in FIELD_ERRORS:
            return JSONResponse({"detail": FIELD_ERRORS[loc[-1]]}, status_code=422)
        msg = err.get("msg", "")
        if msg.startswith("Value error, "):  # nos messages en français
            return JSONResponse({"detail": msg[len("Value error, "):]}, status_code=422)
    return JSONResponse({"detail": "Données invalides."}, status_code=422)


# ---------- Constantes des rubriques ----------

SPACE_LABELS = {"business": "Business", "amour": "Amour", "gbairai": "Gbairai"}
SECTORS = [
    "Commerce et distribution", "Santé et pharmacie", "Alimentation et restauration", "Agriculture et élevage",
    "BTP et immobilier", "Transport et logistique", "Informatique et télécoms", "Mode et beauté",
    "Éducation et formation", "Finance et assurance", "Artisanat", "Événementiel et culture",
    "Tourisme et hôtellerie", "Services aux entreprises", "Autre",
]
REPORT_REASONS = {
    "spam": "Publicité ou messages non désirés",
    "harcelement": "Harcèlement ou menaces",
    "faux_profil": "Faux profil ou usurpation",
    "contenu": "Contenu choquant ou illégal",
    "mineur": "Personne mineure",
    "arnaque": "Arnaque ou escroquerie",
    "autre": "Autre",
}


def check_space(space: str) -> str:
    if space not in SPACES:
        raise HTTPException(404, "Rubrique inconnue.")
    return space


# ---------- Schémas ----------

PHONE_RE = re.compile(r"^\+[1-9]\d{6,14}$")


def normalize_phone(value: str) -> str:
    cleaned = re.sub(r"[\s().-]", "", value)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    if not PHONE_RE.match(cleaned):
        raise ValueError("Téléphone : utilisez le format international, par exemple +2250700000000.")
    return cleaned


def clean_line(v: str | None) -> str | None:
    if v is None:
        return None
    v = " ".join(v.split())
    if any(ord(c) < 32 for c in v):
        raise ValueError("Caractères non autorisés.")
    return v or None


def clean_text(v: str | None) -> str | None:
    if v is None:
        return None
    v = "\n".join(" ".join(line.split()) for line in v.strip().splitlines())
    v = re.sub(r"\n{3,}", "\n\n", v)
    return v or None


def age_of(birth: date) -> int:
    today = date.today()
    return today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))


class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)
    bio: str | None = Field(default=None, max_length=600)
    city: str | None = Field(default=None, max_length=80)
    company: str | None = Field(default=None, max_length=120)
    sector: str | None = Field(default=None, max_length=60)
    activities: str | None = Field(default=None, max_length=600)
    website: str | None = Field(default=None, max_length=200)
    sex: str | None = None
    seeking: str | None = None
    birth_date: date | None = None

    @field_validator("display_name", "city", "company")
    @classmethod
    def _line(cls, v):
        return clean_line(v)

    @field_validator("bio", "activities")
    @classmethod
    def _text(cls, v):
        return clean_text(v)

    @field_validator("website")
    @classmethod
    def _site(cls, v):
        v = clean_line(v)
        if v and not re.match(r"^https?://[^\s/$.?#].[^\s]*$", v, re.I):
            raise ValueError("Site internet : adresse commençant par http:// ou https://.")
        return v


def validate_profile(space: str, p: ProfileIn) -> dict:
    """Vérifie les champs obligatoires propres à chaque rubrique et renvoie les valeurs à enregistrer."""
    if not p.display_name:
        raise HTTPException(422, f"{SPACE_LABELS[space]} : indiquez le nom du profil.")
    data = {"display_name": p.display_name, "bio": p.bio, "city": p.city}
    if space == "business":
        if not p.company or len(p.company) < 2:
            raise HTTPException(422, "Business : indiquez le nom de l'entreprise.")
        if p.sector not in SECTORS:
            raise HTTPException(422, "Business : choisissez un secteur d'activité.")
        data.update(company=p.company, sector=p.sector, activities=p.activities, website=p.website)
    elif space == "amour":
        if p.sex not in ("homme", "femme"):
            raise HTTPException(422, "Amour : indiquez si vous êtes un homme ou une femme.")
        if p.seeking not in ("homme", "femme", "les2"):
            raise HTTPException(422, "Amour : indiquez qui vous recherchez.")
        if not p.birth_date:
            raise HTTPException(422, "Amour : indiquez votre date de naissance.")
        age = age_of(p.birth_date)
        if age < 18:
            raise HTTPException(422, "La rubrique Amour est réservée aux personnes de 18 ans et plus.")
        if age > 100:
            raise HTTPException(422, "Date de naissance invalide.")
        data.update(sex=p.sex, seeking=p.seeking, birth_date=p.birth_date)
    return data


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    phone: str | None = Field(default=None, max_length=30)
    accept_terms: bool = False
    profiles: dict[str, ProfileIn] = Field(default_factory=dict)

    @field_validator("phone")
    @classmethod
    def clean_phone(cls, v: str | None) -> str | None:
        return normalize_phone(v) if v and v.strip() else None


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class AccountIn(BaseModel):
    username: str | None = Field(default=None, min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    phone: str | None = Field(default=None, max_length=30)

    @field_validator("phone")
    @classmethod
    def clean_phone(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return normalize_phone(v) if v.strip() else ""


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class OnboardIn(BaseModel):
    accept_terms: bool = False
    profiles: dict[str, ProfileIn] = Field(default_factory=dict)


class TextIn(BaseModel):
    to_pid: int | None = None
    group_id: int | None = None
    body: str = Field(min_length=1, max_length=5000)

    @field_validator("body")
    @classmethod
    def clean_body(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Le message est vide.")
        return v


class RequestIn(BaseModel):
    to_pid: int
    message: str | None = Field(default=None, max_length=300)

    @field_validator("message")
    @classmethod
    def _msg(cls, v):
        return clean_text(v)


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    member_pids: list[int] = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = clean_line(v)
        if not v:
            raise ValueError("Donnez un nom au groupe.")
        return v


class GroupRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = clean_line(v)
        if not v:
            raise ValueError("Donnez un nom au groupe.")
        return v


class MembersIn(BaseModel):
    pids: list[int] = Field(min_length=1, max_length=100)


class ReportIn(BaseModel):
    pid: int
    reason: str
    details: str | None = Field(default=None, max_length=1000)
    post_id: int | None = None

    @field_validator("reason")
    @classmethod
    def _reason(cls, v):
        if v not in REPORT_REASONS:
            raise ValueError("Choisissez un motif de signalement.")
        return v


class SuspendIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class PushSubIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: dict[str, str]


class SmsIn(BaseModel):
    to_number: str = Field(min_length=7, max_length=30)
    body: str = Field(min_length=1, max_length=480)

    @field_validator("to_number")
    @classmethod
    def clean_number(cls, v: str) -> str:
        return normalize_phone(v)


# ---------- Comptes et sessions ----------

def client_ip(request: Request) -> str:
    return request.client.host if request.client else "inconnu"


def is_admin(user: User) -> bool:
    return user.username.lower() in config.ADMIN_USERNAMES


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Connectez-vous.")
    claims = read_token(authorization[7:])
    user = db.get(User, claims[0]) if claims else None
    if not user or (user.token_version or 0) != claims[1]:
        raise HTTPException(401, "Session expirée. Reconnectez-vous.")
    if user.suspended_at:
        raise HTTPException(403, "Compte suspendu" + (f" : {user.suspended_reason}" if user.suspended_reason else "."))
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(403, "Réservé à l'administrateur.")
    return user


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # SQLite rend des dates sans fuseau : elles sont en UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def profiles_of(db: Session, user_id: int) -> dict[str, Profile]:
    return {p.space: p for p in db.query(Profile).filter(Profile.user_id == user_id)}


def own_profile_json(p: Profile) -> dict:
    out = public_profile(p)
    out["birth_date"] = p.birth_date.isoformat() if p.birth_date else None
    return out


def me_json(db: Session, user: User) -> dict:
    profiles = profiles_of(db, user.id)
    return {"id": user.id, "username": user.username, "phone": user.phone, "is_admin": is_admin(user),
            "onboarded": bool(user.onboarded), "spaces": [s for s in SPACES if s in profiles],
            "profiles": {s: own_profile_json(p) for s, p in profiles.items()}}


def my_profile(db: Session, user: User, space: str) -> Profile:
    check_space(space)
    p = db.query(Profile).filter(Profile.user_id == user.id, Profile.space == space).first()
    if not p:
        raise HTTPException(403, f"Vous n'êtes pas inscrit dans la rubrique {SPACE_LABELS[space]}.")
    return p


def public_profile(p: Profile) -> dict:
    """Ce que les membres de la rubrique voient. Jamais l'identifiant de connexion ni le téléphone :
    rien ne permet de relier les profils d'une même personne entre rubriques."""
    out = {"pid": p.id, "space": p.space, "display_name": p.display_name, "bio": p.bio, "city": p.city,
           "avatar_v": p.avatar_version or 0}
    if p.space == "business":
        out.update(company=p.company, sector=p.sector, activities=p.activities, website=p.website)
    if p.space == "amour":
        out.update(sex=p.sex, seeking=p.seeking, age=age_of(p.birth_date) if p.birth_date else None)
    return out


def card(p: Profile) -> dict:
    """Version courte d'un profil, pour les listes."""
    out = {"pid": p.id, "display_name": p.display_name, "avatar_v": p.avatar_version or 0, "city": p.city}
    if p.space == "business":
        out["subtitle"] = " · ".join(x for x in (p.company, p.sector) if x)
    elif p.space == "amour":
        age = age_of(p.birth_date) if p.birth_date else None
        out["subtitle"] = " · ".join(x for x in ((f"{age} ans" if age else None), p.city) if x)
    else:
        out["subtitle"] = p.city or ""
    return out


def apply_profile(p: Profile, data: dict):
    for k, v in data.items():
        setattr(p, k, v)
    p.updated_at = now_utc()


# ---------- Relations entre membres ----------

def blocked_pairs(db: Session, user_id: int) -> tuple[set[int], set[int]]:
    """(comptes que j'ai bloqués, comptes qui m'ont bloqué)."""
    mine = {b for (b,) in db.query(Block.blocked_id).filter(Block.blocker_id == user_id)}
    theirs = {b for (b,) in db.query(Block.blocker_id).filter(Block.blocked_id == user_id)}
    return mine, theirs


def suspended_ids(db: Session) -> set[int]:
    return {u for (u,) in db.query(User.id).filter(User.suspended_at.isnot(None))}


def find_request(db: Session, space: str, a: int, b: int) -> ContactRequest | None:
    return db.query(ContactRequest).filter(ContactRequest.space == space, or_(
        and_(ContactRequest.from_user_id == a, ContactRequest.to_user_id == b),
        and_(ContactRequest.from_user_id == b, ContactRequest.to_user_id == a),
    )).order_by(ContactRequest.id.desc()).first()


def connected(db: Session, space: str, a: int, b: int) -> bool:
    if space not in REQUEST_SPACES:
        return True
    return db.query(ContactRequest).filter(ContactRequest.space == space, ContactRequest.status == "accepted", or_(
        and_(ContactRequest.from_user_id == a, ContactRequest.to_user_id == b),
        and_(ContactRequest.from_user_id == b, ContactRequest.to_user_id == a),
    )).first() is not None


def relation(db: Session, space: str, me: User, other_uid: int) -> dict:
    """État de la relation vu par « me » : peut-il écrire, une demande est-elle en cours ?"""
    if other_uid == me.id:
        return {"status": "self", "can_message": False}
    mine, theirs = blocked_pairs(db, me.id)
    if other_uid in mine:
        return {"status": "blocked", "can_message": False}
    if space not in REQUEST_SPACES:
        return {"status": "open", "can_message": other_uid not in theirs}
    req = find_request(db, space, me.id, other_uid)
    if not req:
        return {"status": "none", "can_message": False}
    if req.status == "accepted":
        return {"status": "connected", "can_message": other_uid not in theirs, "request_id": req.id}
    if req.from_user_id == me.id:
        # Un refus n'est jamais annoncé à la personne qui a demandé : elle voit « en attente ».
        return {"status": "pending_out", "can_message": False, "request_id": req.id}
    if req.status == "pending":
        return {"status": "pending_in", "can_message": False, "request_id": req.id}
    return {"status": "declined_in", "can_message": False, "request_id": req.id}


def profile_by_pid(db: Session, space: str, pid: int) -> Profile:
    p = db.get(Profile, pid)
    if not p or p.space != space:
        raise HTTPException(404, "Profil introuvable.")
    owner = db.get(User, p.user_id)
    if not owner or owner.suspended_at:
        raise HTTPException(404, "Profil introuvable.")
    return p


def visible_profile(db: Session, space: str, me: User, pid: int) -> Profile:
    """Profil d'un autre membre de la même rubrique, qui ne m'a pas bloqué."""
    my_profile(db, me, space)
    p = profile_by_pid(db, space, pid)
    if p.user_id == me.id:
        return p
    if db.query(Block).filter(Block.blocker_id == p.user_id, Block.blocked_id == me.id).first():
        raise HTTPException(404, "Profil introuvable.")
    return p


def check_can_write(db: Session, space: str, me: User, other_uid: int):
    if db.query(Block).filter(Block.blocker_id == me.id, Block.blocked_id == other_uid).first():
        raise HTTPException(403, "Vous avez bloqué ce contact. Débloquez-le pour lui écrire.")
    if db.query(Block).filter(Block.blocker_id == other_uid, Block.blocked_id == me.id).first():
        raise HTTPException(403, "Impossible d'envoyer un message à ce contact.")
    other = db.get(User, other_uid)
    if not other or other.suspended_at:
        raise HTTPException(403, "Ce compte n'est plus disponible.")
    if not connected(db, space, me.id, other_uid):
        raise HTTPException(403, "Envoyez une demande de contact et attendez qu'elle soit acceptée.")


def get_membership(db: Session, user: User, group_id: int) -> tuple[Group, GroupMember]:
    group = db.get(Group, group_id)
    member = db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.user_id == user.id).first() if group else None
    if not member:
        raise HTTPException(404, "Groupe introuvable.")
    return group, member


def resolve_target(db: Session, user: User, space: str, to_pid: int | None, group_id: int | None) -> dict:
    """Destination d'un message : un membre de la rubrique OU un groupe de la rubrique dont on est membre."""
    my_profile(db, user, space)
    if (to_pid is None) == (group_id is None):
        raise HTTPException(422, "Indiquez un destinataire ou un groupe.")
    if group_id is not None:
        group, _ = get_membership(db, user, group_id)
        if group.space != space:
            raise HTTPException(404, "Groupe introuvable.")
        return {"group_id": group_id, "space": space}
    other = profile_by_pid(db, space, to_pid)
    if other.user_id == user.id:
        raise HTTPException(422, "Vous ne pouvez pas vous écrire à vous-même.")
    check_can_write(db, space, user, other.user_id)
    return {"recipient_id": other.user_id, "space": space}


def pid_map(db: Session, space: str, user_ids) -> dict[int, Profile]:
    ids = set(user_ids)
    if not ids:
        return {}
    return {p.user_id: p for p in db.query(Profile).filter(Profile.space == space, Profile.user_id.in_(ids))}


# ---------- Fichiers ----------

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
    return {"voice": sniff_audio, "audio": sniff_audio, "image": sniff_image, "video": sniff_video}[kind](head)


FILE_ERRORS = {
    "voice": "Le fichier doit être un enregistrement audio.",
    "audio": "Format audio non pris en charge (MP3, M4A, AAC, OGG, WAV, FLAC ou WebM).",
    "image": "Format d'image non pris en charge (JPEG, PNG, GIF ou WebP).",
    "video": "Format vidéo non pris en charge (MP4, MOV, 3GP ou WebM).",
}
KIND_LABELS = {"voice": "Message vocal", "audio": "Fichier audio", "image": "Photo", "video": "Vidéo", "text": ""}


async def read_upload(upload: UploadFile, limit: int, too_big: str) -> bytes:
    chunks, size = [], 0
    while chunk := await upload.read(64 * 1024):
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, too_big)
        chunks.append(chunk)
    return b"".join(chunks)


async def read_image(upload: UploadFile, limit: int, label: str) -> tuple[bytes, str]:
    data = await read_upload(upload, limit, f"{label} trop volumineuse ({limit // config.MB} Mo maximum).")
    kind = sniff_image(data[:16])
    if not kind:
        raise HTTPException(415, "Choisissez une image JPEG, PNG, GIF ou WebP.")
    return data, kind[1]


def clean_file_name(name: str | None) -> str | None:
    if not name:
        return None
    name = Path(name.replace("\\", "/")).name
    name = "".join(c for c in name if ord(c) >= 32 and c not in '"<>|')
    return name[:120] or None


# ---------- Messages ----------

def message_json(m: Message, profiles: dict[int, Profile]) -> dict:
    has_file = bool(m.media_path)
    sender = profiles.get(m.sender_id)
    return {
        "id": m.id, "group_id": m.group_id, "space": m.space,
        "sender_pid": sender.id if sender else None,
        "sender_name": sender.display_name if sender else "Membre",
        "sender_avatar_v": (sender.avatar_version or 0) if sender else 0,
        "kind": m.kind or ("voice" if has_file else "text"),
        "body": m.body, "media_url": f"/media/{m.id}" if has_file else None,
        "media_type": m.media_type, "media_name": m.media_name, "media_size": m.media_size,
        "created_at": iso(m.created_at),
    }


def notify_message(background: BackgroundTasks, db: Session, m: Message, sender: Profile):
    """Prévient les destinataires sur leur téléphone. Pour Amour, la notification reste discrète."""
    if m.group_id:
        group = db.get(Group, m.group_id)
        hidden_for = {b for (b,) in db.query(Block.blocker_id).filter(Block.blocked_id == m.sender_id)}
        targets = [u for (u,) in db.query(GroupMember.user_id).filter(GroupMember.group_id == m.group_id)
                   if u != m.sender_id and u not in hidden_for]
        title = f"{group.name} · {SPACE_LABELS[m.space]}"
        conv = f"group:{m.group_id}"
    else:
        targets = [m.recipient_id]
        title = f"{sender.display_name} · {SPACE_LABELS[m.space]}"
        conv = f"user:{sender.id}"
    text_preview = m.body if (m.kind or "text") == "text" else KIND_LABELS.get(m.kind, "Fichier")
    if m.group_id:
        text_preview = f"{sender.display_name} : {text_preview}"
    if m.space == "amour":
        title, text_preview = "COOL MESSENGER", "Nouveau message dans Amour ❤️"
    payload = {"title": title, "body": (text_preview or "")[:140], "tag": f"{m.space}:{conv}",
               "url": f"/?open={m.space}:{conv}", "type": "message"}
    background.add_task(push.send, targets, payload)


def store_message(db: Session, background: BackgroundTasks, user: User, target: dict, **fields) -> dict:
    m = Message(sender_id=user.id, **target, **fields)
    db.add(m)
    db.commit()
    db.refresh(m)
    sender = my_profile(db, user, target["space"])
    notify_message(background, db, m, sender)
    return message_json(m, {user.id: sender})


def preview(m: Message, me_id: int, names: dict[int, Profile] | None = None) -> dict:
    kind = m.kind or ("voice" if m.media_path else "text")
    sender = (names or {}).get(m.sender_id)
    return {"id": m.id, "mine": m.sender_id == me_id, "kind": kind,
            "sender_name": sender.display_name if sender else None,
            "body": (m.body or "")[:120] if kind == "text" else KIND_LABELS.get(kind, "Fichier"),
            "created_at": iso(m.created_at)}


def page(query, after: int) -> list[Message]:
    if after:
        return query.filter(Message.id > after).order_by(Message.id.asc()).limit(500).all()
    return query.order_by(Message.id.desc()).limit(500).all()[::-1]


# ---------- Pages ----------

@app.get("/", include_in_schema=False)
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/installer", include_in_schema=False)
def installer():
    return FileResponse(STATIC / "installer.html")


@app.get("/conditions", include_in_schema=False)
def conditions():
    return FileResponse(STATIC / "conditions.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript")


@app.get("/.well-known/assetlinks.json", include_in_schema=False)
def android_asset_links():
    if not config.ANDROID_ASSETLINKS:
        raise HTTPException(404, "Non configuré.")
    try:
        data = json.loads(config.ANDROID_ASSETLINKS)
    except ValueError:
        log.error("ANDROID_ASSETLINKS n'est pas un JSON valide.")
        raise HTTPException(404, "Non configuré.")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def public_config():
    return {"sms_enabled": config.SMS_ENABLED, "sms_daily_limit": config.SMS_DAILY_LIMIT,
            "max_file_mb": {k: v // config.MB for k, v in config.MAX_FILE_BYTES.items()},
            "sectors": SECTORS, "report_reasons": REPORT_REASONS, "spaces": SPACE_LABELS,
            "push_key": push.vapid_keys()["public"]}


# ---------- Inscription, connexion, compte ----------

def create_profiles(db: Session, user: User, profiles: dict[str, ProfileIn]):
    for space, p in profiles.items():
        check_space(space)
        db.add(Profile(user_id=user.id, space=space, **validate_profile(space, p)))


@app.post("/api/register")
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    limiter.hit(f"register:{client_ip(request)}", 20, 3600, "Trop de comptes créés depuis cette connexion. Réessayez plus tard.")
    if not data.accept_terms:
        raise HTTPException(422, "Acceptez les conditions d'utilisation pour créer votre compte.")
    if not data.profiles:
        raise HTTPException(422, "Choisissez au moins une rubrique.")
    for space in data.profiles:
        check_space(space)
    username = data.username.lower()
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    first = next(iter(data.profiles.values()))
    user = User(username=username, display_name=(first.display_name or username)[:80],
                password_hash=hash_password(data.password), phone=data.phone, token_version=0,
                avatar_version=0, onboarded=True, terms_accepted_at=now_utc())
    db.add(user)
    try:
        db.flush()
        create_profiles(db, user, data.profiles)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    except HTTPException:
        db.rollback()
        raise
    db.refresh(user)
    return {"token": create_token(user.id, user.token_version), "user": me_json(db, user)}


@app.post("/api/login")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    ip, username = client_ip(request), data.username.strip().lower()
    limiter.hit(f"login-ip:{ip}", 60, 600)
    limiter.hit(f"login:{ip}:{username}", 8, 300, "Trop de tentatives de connexion. Patientez quelques minutes.")
    user = db.query(User).filter(User.username == username).first()
    valid = verify_password(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, "Identifiants incorrects.")
    if user.suspended_at:
        raise HTTPException(403, "Compte suspendu" + (f" : {user.suspended_reason}" if user.suspended_reason else "."))
    return {"token": create_token(user.id, user.token_version), "user": me_json(db, user)}


@app.get("/api/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return me_json(db, user)


@app.post("/api/me/onboarding")
def finish_onboarding(data: OnboardIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Comptes d'avant les rubriques : choix des rubriques et acceptation des conditions."""
    if not data.accept_terms:
        raise HTTPException(422, "Acceptez les conditions d'utilisation pour continuer.")
    existing = profiles_of(db, user.id)
    new = {s: p for s, p in data.profiles.items() if s not in existing}
    if not existing and not new:
        raise HTTPException(422, "Choisissez au moins une rubrique.")
    try:
        create_profiles(db, user, new)
    except HTTPException:
        db.rollback()
        raise
    user.onboarded = True
    user.terms_accepted_at = now_utc()
    db.commit()
    return me_json(db, user)


@app.patch("/api/me")
def update_account(data: AccountIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"profile:{user.id}", 30, 3600, "Trop de modifications. Réessayez plus tard.")
    if data.username is not None:
        username = data.username.lower()
        if username != user.username:
            if db.query(User).filter(User.username == username).first():
                raise HTTPException(409, "Ce nom d'utilisateur est déjà pris.")
            user.username = username
    if data.phone is not None:
        user.phone = data.phone or None
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Ce nom d'utilisateur est déjà pris.")
    return me_json(db, user)


@app.post("/api/me/password")
def change_password(data: PasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"password:{user.id}", 6, 900, "Trop de tentatives. Patientez quelques minutes.")
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(400, "Le mot de passe actuel est incorrect.")
    if data.current_password == data.new_password:
        raise HTTPException(400, "Le nouveau mot de passe doit être différent de l'ancien.")
    user.password_hash = hash_password(data.new_password)
    user.token_version = (user.token_version or 0) + 1
    db.query(PushSubscription).filter(PushSubscription.user_id == user.id).delete(synchronize_session=False)
    db.commit()
    return {"token": create_token(user.id, user.token_version), "message": "Mot de passe modifié."}


@app.post("/api/me/profiles/{space}")
def join_space(space: str, data: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    check_space(space)
    if db.query(Profile).filter(Profile.user_id == user.id, Profile.space == space).first():
        raise HTTPException(409, f"Vous êtes déjà inscrit dans la rubrique {SPACE_LABELS[space]}.")
    db.add(Profile(user_id=user.id, space=space, **validate_profile(space, data)))
    db.commit()
    return me_json(db, user)


@app.patch("/api/me/profiles/{space}")
def update_space_profile(space: str, data: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"profile:{user.id}", 30, 3600, "Trop de modifications. Réessayez plus tard.")
    p = my_profile(db, user, space)
    apply_profile(p, validate_profile(space, data))
    db.commit()
    return me_json(db, user)


@app.put("/api/me/profiles/{space}/avatar")
async def set_avatar(space: str, photo: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"avatar:{user.id}", 30, 3600, "Trop de changements de photo. Réessayez plus tard.")
    p = my_profile(db, user, space)
    data, kind = await read_image(photo, config.MAX_AVATAR_BYTES, "Photo")
    if kind == "image/gif":
        raise HTTPException(415, "Choisissez une photo JPEG, PNG ou WebP.")
    p.avatar_data, p.avatar_type = data, kind
    p.avatar_version = (p.avatar_version or 0) + 1
    db.commit()
    return me_json(db, user)


@app.delete("/api/me/profiles/{space}/avatar")
def delete_avatar(space: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = my_profile(db, user, space)
    p.avatar_data, p.avatar_type, p.avatar_version = None, None, 0
    db.commit()
    return me_json(db, user)


@app.get("/api/p/{pid}/avatar")
def profile_avatar(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(Profile, pid)
    if not p or not p.avatar_version or p.avatar_data is None:
        raise HTTPException(404, "Pas de photo.")
    # Visible par soi-même, par l'administrateur et par les membres de la même rubrique.
    if p.user_id != user.id and not is_admin(user):
        visible_profile(db, p.space, user, pid)
    return Response(p.avatar_data, media_type=p.avatar_type or "image/jpeg", headers={"Content-Disposition": "inline"})


# ---------- Annuaire, profils, demandes ----------

@app.get("/api/s/{space}/directory")
def directory(space: str, q: str = Query("", max_length=80), sector: str = Query("", max_length=60),
              city: str = Query("", max_length=80), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Membres de la rubrique à découvrir. Amour : seulement les profils compatibles avec la recherche de chacun."""
    limiter.hit(f"dir:{user.id}", 90, 60)
    mine_p = my_profile(db, user, space)
    mine, theirs = blocked_pairs(db, user.id)
    hidden = mine | theirs | suspended_ids(db) | {user.id}
    query = db.query(Profile).filter(Profile.space == space)
    if hidden:
        query = query.filter(Profile.user_id.notin_(hidden))
    q = q.strip()
    if q:
        query = query.filter(or_(Profile.display_name.icontains(q, autoescape=True),
                                 Profile.company.icontains(q, autoescape=True),
                                 Profile.activities.icontains(q, autoescape=True),
                                 Profile.bio.icontains(q, autoescape=True)))
    if sector and space == "business":
        query = query.filter(Profile.sector == sector)
    if city.strip():
        query = query.filter(Profile.city.icontains(city.strip(), autoescape=True))
    if space == "amour":
        wanted = ("homme", "femme") if mine_p.seeking == "les2" else (mine_p.seeking,)
        query = query.filter(Profile.sex.in_(wanted), Profile.seeking.in_((mine_p.sex, "les2")))
    rows = query.order_by(Profile.updated_at.desc(), Profile.id.desc()).limit(200).all()
    out = []
    for p in rows:
        item = card(p)
        item["bio"] = (p.bio or "")[:140]
        item["relation"] = relation(db, space, user, p.user_id)["status"]
        out.append(item)
    return out


@app.get("/api/s/{space}/profiles/{pid}")
def view_profile(space: str, pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = visible_profile(db, space, user, pid)
    out = public_profile(p)
    out["relation"] = relation(db, space, user, p.user_id)
    return out


@app.get("/api/s/{space}/requests")
def list_requests(space: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    my_profile(db, user, space)
    mine, theirs = blocked_pairs(db, user.id)
    incoming = db.query(ContactRequest).filter(ContactRequest.space == space, ContactRequest.to_user_id == user.id,
                                               ContactRequest.status == "pending").order_by(ContactRequest.id.desc()).all()
    outgoing = db.query(ContactRequest).filter(ContactRequest.space == space, ContactRequest.from_user_id == user.id,
                                               ContactRequest.status != "accepted").order_by(ContactRequest.id.desc()).all()
    others = pid_map(db, space, [r.from_user_id for r in incoming] + [r.to_user_id for r in outgoing])
    gone = suspended_ids(db)

    def row(r, other_uid):
        p = others.get(other_uid)
        if not p or other_uid in mine or other_uid in theirs or other_uid in gone:
            return None
        return {"id": r.id, "message": r.message, "created_at": iso(r.created_at), "profile": card(p)}

    return {"incoming": [x for x in (row(r, r.from_user_id) for r in incoming) if x],
            "outgoing": [x for x in (row(r, r.to_user_id) for r in outgoing) if x]}


@app.post("/api/s/{space}/requests")
def send_request(space: str, data: RequestIn, background: BackgroundTasks,
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    if space not in REQUEST_SPACES:
        raise HTTPException(422, "Dans Business, vous pouvez écrire directement.")
    limiter.hit(f"request:{user.id}", 30, 3600, "Trop de demandes envoyées. Réessayez plus tard.")
    me_p = my_profile(db, user, space)
    other = visible_profile(db, space, user, data.to_pid)
    if other.user_id == user.id:
        raise HTTPException(422, "Vous ne pouvez pas vous envoyer une demande.")
    if db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == other.user_id).first():
        raise HTTPException(403, "Vous avez bloqué ce profil. Débloquez-le d'abord.")
    if space == "amour":
        me_ok = other.sex in (("homme", "femme") if me_p.seeking == "les2" else (me_p.seeking,))
        other_ok = me_p.sex in (("homme", "femme") if other.seeking == "les2" else (other.seeking,))
        if not (me_ok and other_ok):
            raise HTTPException(403, "Ce profil ne correspond pas à vos critères de recherche.")
    existing = find_request(db, space, user.id, other.user_id)
    if existing:
        if existing.status == "accepted":
            return {"status": "connected", "request_id": existing.id}
        if existing.from_user_id == other.user_id and existing.status == "pending":
            # L'autre m'avait déjà fait une demande : on se relie directement.
            existing.status, existing.answered_at = "accepted", now_utc()
            db.commit()
            return {"status": "connected", "request_id": existing.id}
        return {"status": "pending_out", "request_id": existing.id}
    req = ContactRequest(space=space, from_user_id=user.id, to_user_id=other.user_id, status="pending", message=data.message)
    db.add(req)
    db.commit()
    title = "Nouvelle demande · " + SPACE_LABELS[space]
    body = "Quelqu'un souhaite faire votre connaissance ❤️" if space == "amour" else f"{me_p.display_name} souhaite discuter avec vous"
    background.add_task(push.send, [other.user_id], {"title": title, "body": body, "tag": f"{space}:requests",
                                                      "url": f"/?open={space}:requests", "type": "request"})
    return {"status": "pending_out", "request_id": req.id}


def own_request(db: Session, user: User, request_id: int, incoming: bool) -> ContactRequest:
    r = db.get(ContactRequest, request_id)
    if not r or (r.to_user_id if incoming else r.from_user_id) != user.id:
        raise HTTPException(404, "Demande introuvable.")
    return r


@app.post("/api/requests/{request_id}/accept")
def accept_request(request_id: int, background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = own_request(db, user, request_id, incoming=True)
    if r.status != "accepted":
        r.status, r.answered_at = "accepted", now_utc()
        db.commit()
        me_p = my_profile(db, user, r.space)
        body = "Votre demande a été acceptée ❤️" if r.space == "amour" else f"{me_p.display_name} a accepté votre demande"
        background.add_task(push.send, [r.from_user_id], {"title": "Demande acceptée · " + SPACE_LABELS[r.space], "body": body,
                                                          "tag": f"{r.space}:user:{me_p.id}", "url": f"/?open={r.space}:user:{me_p.id}",
                                                          "type": "accepted"})
    sender = pid_map(db, r.space, [r.from_user_id]).get(r.from_user_id)
    return {"status": "connected", "profile": card(sender) if sender else None}


@app.post("/api/requests/{request_id}/decline")
def decline_request(request_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = own_request(db, user, request_id, incoming=True)
    if r.status == "pending":
        r.status, r.answered_at = "declined", now_utc()
        db.commit()
    return {"status": "declined"}


@app.delete("/api/requests/{request_id}")
def cancel_request(request_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = own_request(db, user, request_id, incoming=False)
    if r.status == "accepted":
        raise HTTPException(422, "Vous êtes déjà en contact.")
    db.delete(r)
    db.commit()
    return {"status": "none"}


# ---------- Blocage et signalement ----------

@app.get("/api/blocks")
def list_blocks(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(Block).filter(Block.blocker_id == user.id).order_by(Block.id.desc()).all()
    out = []
    for b in rows:
        profiles = profiles_of(db, b.blocked_id)
        p = profiles.get(b.space or "") or next((profiles[s] for s in SPACES if s in profiles), None)
        if p:
            out.append({"space": p.space, **card(p)})
    return out


@app.post("/api/s/{space}/blocks/{pid}")
def block(space: str, pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    my_profile(db, user, space)
    p = profile_by_pid(db, space, pid)
    if p.user_id == user.id:
        raise HTTPException(422, "Vous ne pouvez pas vous bloquer.")
    if not db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == p.user_id).first():
        db.add(Block(blocker_id=user.id, blocked_id=p.user_id, space=space))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    return {"blocked": True}


@app.delete("/api/s/{space}/blocks/{pid}")
def unblock(space: str, pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(Profile, pid)
    if p:
        db.query(Block).filter(Block.blocker_id == user.id, Block.blocked_id == p.user_id).delete(synchronize_session=False)
        db.commit()
    return {"blocked": False}


@app.post("/api/s/{space}/reports")
def report(space: str, data: ReportIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"report:{user.id}", 20, 3600, "Trop de signalements envoyés. Réessayez plus tard.")
    my_profile(db, user, space)
    p = profile_by_pid(db, space, data.pid)
    if p.user_id == user.id:
        raise HTTPException(422, "Vous ne pouvez pas vous signaler.")
    db.add(Report(reporter_id=user.id, target_user_id=p.user_id, space=space, reason=data.reason,
                  details=clean_text(data.details), post_id=data.post_id, status="open"))
    db.commit()
    return {"message": "Merci. Votre signalement a été transmis à l'administrateur."}


# ---------- Conversations ----------

@app.get("/api/s/{space}/conversations")
def conversations(space: str, q: str = Query("", max_length=80), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Groupes et personnes avec qui je discute dans cette rubrique, les plus récents en premier."""
    limiter.hit(f"users:{user.id}", 120, 60)
    my_profile(db, user, space)
    q = q.strip().lower()
    mine_blocked, _ = blocked_pairs(db, user.id)
    rows = []

    # Groupes de la rubrique
    memberships = (db.query(GroupMember, Group).join(Group, Group.id == GroupMember.group_id)
                   .filter(GroupMember.user_id == user.id, Group.space == space).all())
    gids = [g.id for _, g in memberships]
    if gids:
        last_ids = dict(db.query(Message.group_id, func.max(Message.id)).filter(Message.group_id.in_(gids)).group_by(Message.group_id))
        lasts = {m.id: m for m in db.query(Message).filter(Message.id.in_(list(last_ids.values())))} if last_ids else {}
        counts = dict(db.query(GroupMember.group_id, func.count(GroupMember.id)).filter(GroupMember.group_id.in_(gids)).group_by(GroupMember.group_id))
        names = pid_map(db, space, [m.sender_id for m in lasts.values()])
        for member, group in memberships:
            if q and q not in group.name.lower():
                continue
            unread_q = db.query(func.count(Message.id)).filter(
                Message.group_id == group.id, Message.id > (member.last_read_id or 0), Message.sender_id != user.id)
            if mine_blocked:
                unread_q = unread_q.filter(Message.sender_id.notin_(mine_blocked))
            m = lasts.get(last_ids.get(group.id))
            rows.append({"type": "group", "id": group.id, "display_name": group.name, "members": counts.get(group.id, 0),
                         "is_admin": bool(member.is_admin), "unread": unread_q.scalar() or 0,
                         "last": preview(m, user.id, names) if m else None})

    # Conversations à deux de la rubrique, plus les contacts acceptés sans message encore
    direct = and_(Message.group_id.is_(None), Message.space == space,
                  or_(Message.sender_id == user.id, Message.recipient_id == user.id))
    peer = case((Message.sender_id == user.id, Message.recipient_id), else_=Message.sender_id)
    last_ids = dict(db.query(peer, func.max(Message.id)).filter(direct).group_by(peer).all())
    peers = set(last_ids)
    if space in REQUEST_SPACES:
        for r in db.query(ContactRequest).filter(ContactRequest.space == space, ContactRequest.status == "accepted",
                                                 or_(ContactRequest.from_user_id == user.id, ContactRequest.to_user_id == user.id)):
            peers.add(r.to_user_id if r.from_user_id == user.id else r.from_user_id)
    peers.discard(user.id)
    unread = dict(db.query(Message.sender_id, func.count(Message.id))
                  .filter(Message.recipient_id == user.id, Message.group_id.is_(None), Message.space == space, Message.read_at.is_(None))
                  .group_by(Message.sender_id).all())
    profiles = pid_map(db, space, peers)
    lasts = {m.id: m for m in db.query(Message).filter(Message.id.in_(list(last_ids.values())))} if last_ids else {}
    gone = suspended_ids(db)
    for uid in peers:
        p = profiles.get(uid)
        if not p:
            continue
        if q and q not in (p.display_name or "").lower() and q not in (p.company or "").lower():
            continue
        m = lasts.get(last_ids.get(uid))
        item = card(p)
        item.update({"type": "user", "id": p.id, "blocked": uid in mine_blocked, "unavailable": uid in gone,
                     "unread": 0 if uid in mine_blocked else unread.get(uid, 0),
                     "last": preview(m, user.id) if m else None})
        rows.append(item)
    rows.sort(key=lambda r: (0, -r["last"]["id"], "") if r["last"] else (1, 0, r["display_name"].lower()))
    return rows


@app.get("/api/unread")
def unread_counts(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Total de non-lus et de demandes par rubrique, pour les pastilles des onglets."""
    spaces = [s for s in SPACES if s in profiles_of(db, user.id)]
    mine_blocked, _ = blocked_pairs(db, user.id)
    out = {}
    for space in spaces:
        direct = db.query(func.count(Message.id)).filter(Message.recipient_id == user.id, Message.group_id.is_(None),
                                                         Message.space == space, Message.read_at.is_(None))
        if mine_blocked:
            direct = direct.filter(Message.sender_id.notin_(mine_blocked))
        total = direct.scalar() or 0
        for member, group in (db.query(GroupMember, Group).join(Group, Group.id == GroupMember.group_id)
                              .filter(GroupMember.user_id == user.id, Group.space == space)):
            gq = db.query(func.count(Message.id)).filter(Message.group_id == group.id, Message.id > (member.last_read_id or 0),
                                                         Message.sender_id != user.id)
            if mine_blocked:
                gq = gq.filter(Message.sender_id.notin_(mine_blocked))
            total += gq.scalar() or 0
        requests = 0
        if space in REQUEST_SPACES:
            requests = db.query(func.count(ContactRequest.id)).filter(ContactRequest.space == space, ContactRequest.to_user_id == user.id,
                                                                      ContactRequest.status == "pending").scalar() or 0
        out[space] = {"messages": total, "requests": requests}
    return out


@app.get("/api/s/{space}/messages/{pid}")
def history(space: str, pid: int, after: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"history:{user.id}", 240, 60)
    me_p = my_profile(db, user, space)
    other = profile_by_pid(db, space, pid)
    pair = db.query(Message).filter(Message.group_id.is_(None), Message.space == space, or_(
        and_(Message.sender_id == user.id, Message.recipient_id == other.user_id),
        and_(Message.sender_id == other.user_id, Message.recipient_id == user.id),
    ))
    rows = page(pair, after)
    marked = db.query(Message).filter(
        Message.sender_id == other.user_id, Message.recipient_id == user.id, Message.space == space,
        Message.group_id.is_(None), Message.read_at.is_(None)
    ).update({Message.read_at: now_utc()}, synchronize_session=False)
    out = [message_json(m, {user.id: me_p, other.user_id: other}) for m in rows]
    if marked:
        db.commit()
    return out


@app.post("/api/s/{space}/messages")
def send_text(space: str, data: TextIn, background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"msg:{user.id}", 40, 60, "Vous envoyez trop de messages. Patientez un instant.")
    target = resolve_target(db, user, space, data.to_pid, data.group_id)
    return store_message(db, background, user, target, body=data.body, kind="text")


@app.post("/api/s/{space}/media")
async def send_media(space: str, background: BackgroundTasks, kind: str = Form(...), file: UploadFile = File(...),
                     to_pid: int | None = Form(None), group_id: int | None = Form(None), name: str | None = Form(None),
                     user: User = Depends(current_user), db: Session = Depends(get_db)):
    if kind not in config.MAX_FILE_BYTES:
        raise HTTPException(422, "Type de fichier inconnu.")
    limiter.hit(f"media:{user.id}", 20, 60, "Vous envoyez trop de fichiers. Patientez un instant.")
    target = resolve_target(db, user, space, to_pid, group_id)
    limit = config.MAX_FILE_BYTES[kind]
    data = await read_upload(file, limit, f"{KIND_LABELS[kind]} trop volumineux ({limit // config.MB} Mo maximum).")
    found = sniff_file(kind, data[:16])
    if not found:
        raise HTTPException(415, FILE_ERRORS[kind])
    ext, media_type = found
    return store_message(db, background, user, target, kind=kind, body=KIND_LABELS[kind],
                         media_path=f"{uuid.uuid4().hex}{ext}", media_type=media_type, media_data=data, media_size=len(data),
                         media_name=clean_file_name(name or file.filename) if kind != "voice" else None)


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
    path = config.UPLOADS_DIR / Path(m.media_path).name  # vocaux enregistrés par une ancienne version
    if not path.is_file():
        raise HTTPException(404, "Fichier introuvable.")
    return FileResponse(path, media_type=media_type, headers={"Content-Disposition": "inline"})


# ---------- Groupes ----------

def group_json(db: Session, group: Group, me: GroupMember) -> dict:
    rows = db.query(GroupMember).filter(GroupMember.group_id == group.id).all()
    profiles = pid_map(db, group.space, [r.user_id for r in rows])
    members = []
    for r in rows:
        p = profiles.get(r.user_id)
        if p:
            item = card(p)
            item["is_admin"] = bool(r.is_admin)
            item["is_me"] = r.user_id == me.user_id
            members.append(item)
    members.sort(key=lambda m: (not m["is_admin"], m["display_name"].lower()))
    return {"type": "group", "id": group.id, "space": group.space, "display_name": group.name, "name": group.name,
            "is_admin": bool(me.is_admin), "members": members}


def addable_user_ids(db: Session, user: User, space: str, pids) -> list[int]:
    """Membres qu'on peut mettre dans un groupe : profils de la rubrique avec qui on peut discuter."""
    profiles = db.query(Profile).filter(Profile.space == space, Profile.id.in_(set(pids))).all()
    mine, theirs = blocked_pairs(db, user.id)
    gone = suspended_ids(db)
    out = []
    for p in profiles:
        uid = p.user_id
        if uid == user.id or uid in mine or uid in theirs or uid in gone:
            continue
        if connected(db, space, user.id, uid):
            out.append(uid)
    return out


@app.post("/api/s/{space}/groups")
def create_group(space: str, data: GroupIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"group-new:{user.id}", 10, 3600, "Trop de groupes créés. Réessayez plus tard.")
    my_profile(db, user, space)
    member_ids = addable_user_ids(db, user, space, data.member_pids)
    if not member_ids:
        raise HTTPException(422, "Ajoutez au moins un de vos contacts de cette rubrique.")
    if len(member_ids) + 1 > config.MAX_GROUP_MEMBERS:
        raise HTTPException(422, f"Un groupe compte au plus {config.MAX_GROUP_MEMBERS} membres.")
    group = Group(name=data.name, space=space, created_by=user.id)
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
    new_ids = [i for i in addable_user_ids(db, user, group.space, data.pids) if i not in current]
    if len(current) + len(new_ids) > config.MAX_GROUP_MEMBERS:
        raise HTTPException(422, f"Un groupe compte au plus {config.MAX_GROUP_MEMBERS} membres.")
    last = db.query(func.max(Message.id)).filter(Message.group_id == group_id).scalar() or 0
    db.add_all([GroupMember(group_id=group_id, user_id=i, is_admin=False, last_read_id=last) for i in new_ids])
    db.commit()
    return group_json(db, group, member)


@app.delete("/api/groups/{group_id}/members/{pid}")
def remove_member(group_id: int, pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    group, member = get_membership(db, user, group_id)
    p = db.get(Profile, pid)
    target_uid = p.user_id if p and p.space == group.space else None
    if target_uid != user.id and not member.is_admin:
        raise HTTPException(403, "Seul un administrateur peut retirer un membre.")
    target = db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.user_id == target_uid).first() if target_uid else None
    if not target:
        raise HTTPException(404, "Ce membre ne fait pas partie du groupe.")
    db.delete(target)
    db.flush()
    if not db.query(GroupMember).filter(GroupMember.group_id == group_id, GroupMember.is_admin.is_(True)).first():
        heir = db.query(GroupMember).filter(GroupMember.group_id == group_id).order_by(GroupMember.joined_at, GroupMember.id).first()
        if heir:
            heir.is_admin = True
    db.commit()
    if target_uid == user.id:
        return {"left": True}
    return group_json(db, group, member)


@app.get("/api/groups/{group_id}/messages")
def group_history(group_id: int, after: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"history:{user.id}", 240, 60)
    group, member = get_membership(db, user, group_id)
    query = db.query(Message).filter(Message.group_id == group_id)
    mine, _ = blocked_pairs(db, user.id)
    if mine:
        query = query.filter(Message.sender_id.notin_(mine))
    rows = page(query, after)
    newest = db.query(func.max(Message.id)).filter(Message.group_id == group_id).scalar() or 0
    if newest > (member.last_read_id or 0):
        db.execute(update(GroupMember).where(GroupMember.id == member.id).values(last_read_id=newest))
        db.commit()
    profiles = pid_map(db, group.space, [m.sender_id for m in rows])
    return [message_json(m, profiles) for m in rows]


# ---------- Publications (Business) ----------

def post_json(p: Post, author: Profile | None, viewer: User) -> dict:
    return {"id": p.id, "body": p.body, "created_at": iso(p.created_at),
            "image_url": f"/api/posts/{p.id}/image" if p.image_type else None,
            "author": card(author) if author else None,
            "mine": p.user_id == viewer.id, "can_delete": p.user_id == viewer.id or is_admin(viewer)}


@app.get("/api/s/business/posts")
def list_posts(before: int = Query(0, ge=0), user: User = Depends(current_user), db: Session = Depends(get_db)):
    my_profile(db, user, "business")
    mine, theirs = blocked_pairs(db, user.id)
    hidden = mine | theirs | suspended_ids(db)
    query = db.query(Post).filter(Post.space == "business")
    if hidden:
        query = query.filter(Post.user_id.notin_(hidden))
    if before:
        query = query.filter(Post.id < before)
    rows = query.order_by(Post.id.desc()).limit(20).all()
    authors = pid_map(db, "business", [p.user_id for p in rows])
    return [post_json(p, authors.get(p.user_id), user) for p in rows]


@app.post("/api/s/business/posts")
async def create_post(body: str = Form(..., max_length=3000), image: UploadFile | None = File(None),
                      user: User = Depends(current_user), db: Session = Depends(get_db)):
    limiter.hit(f"post:{user.id}", 10, 3600, "Vous publiez beaucoup. Réessayez dans un moment.")
    author = my_profile(db, user, "business")
    text_body = clean_text(body)
    if not text_body:
        raise HTTPException(422, "Écrivez le texte de votre publication.")
    p = Post(space="business", user_id=user.id, body=text_body)
    if image is not None and image.filename:
        p.image_data, p.image_type = await read_image(image, config.MAX_POST_IMAGE_BYTES, "Image")
    db.add(p)
    db.commit()
    db.refresh(p)
    return post_json(p, author, user)


@app.get("/api/posts/{post_id}/image")
def post_image(post_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(Post, post_id)
    if not p or not p.image_type:
        raise HTTPException(404, "Image introuvable.")
    if not is_admin(user):
        my_profile(db, user, p.space)
    return Response(p.image_data, media_type=p.image_type, headers={"Content-Disposition": "inline"})


@app.delete("/api/posts/{post_id}")
def delete_post(post_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(Post, post_id)
    if not p or (p.user_id != user.id and not is_admin(user)):
        raise HTTPException(404, "Publication introuvable.")
    db.delete(p)
    db.commit()
    return {"deleted": True}


# ---------- Notifications ----------

@app.post("/api/push/subscribe")
def push_subscribe(data: PushSubIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not data.endpoint.startswith("https://") or not data.keys.get("p256dh") or not data.keys.get("auth"):
        raise HTTPException(422, "Abonnement invalide.")
    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == data.endpoint).first()
    if sub:
        sub.user_id, sub.p256dh, sub.auth = user.id, data.keys["p256dh"][:200], data.keys["auth"][:100]
    else:
        db.add(PushSubscription(user_id=user.id, endpoint=data.endpoint, p256dh=data.keys["p256dh"][:200], auth=data.keys["auth"][:100]))
    db.commit()
    return {"subscribed": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(data: PushSubIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.query(PushSubscription).filter(PushSubscription.endpoint == data.endpoint,
                                      PushSubscription.user_id == user.id).delete(synchronize_session=False)
    db.commit()
    return {"subscribed": False}


# ---------- Administration ----------

@app.get("/api/admin/overview")
def admin_overview(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    if IS_SQLITE:
        size = (config.DATA_DIR / "cool_messenger.db").stat().st_size if (config.DATA_DIR / "cool_messenger.db").exists() else 0
    else:
        size = db.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0
    per_space = dict(db.query(Profile.space, func.count(Profile.id)).group_by(Profile.space))
    return {"users": db.query(func.count(User.id)).scalar(), "per_space": per_space,
            "messages": db.query(func.count(Message.id)).scalar(), "posts": db.query(func.count(Post.id)).scalar(),
            "open_reports": db.query(func.count(Report.id)).filter(Report.status == "open").scalar(),
            "suspended": db.query(func.count(User.id)).filter(User.suspended_at.isnot(None)).scalar(),
            "db_size_mb": round(size / config.MB, 1)}


def admin_user_json(db: Session, u: User) -> dict:
    return {"id": u.id, "username": u.username, "created_at": iso(u.created_at),
            "suspended": bool(u.suspended_at), "suspended_reason": u.suspended_reason,
            "profiles": [{"space": p.space, **card(p)} for p in profiles_of(db, u.id).values()]}


@app.get("/api/admin/reports")
def admin_reports(status: str = Query("open"), user: User = Depends(admin_user), db: Session = Depends(get_db)):
    rows = db.query(Report).filter(Report.status == status).order_by(Report.id.desc()).limit(200).all()
    out = []
    for r in rows:
        target, reporter = db.get(User, r.target_user_id), db.get(User, r.reporter_id)
        profiles = profiles_of(db, r.target_user_id)
        p = profiles.get(r.space or "")
        post = db.get(Post, r.post_id) if r.post_id else None
        out.append({"id": r.id, "space": r.space, "reason": REPORT_REASONS.get(r.reason, r.reason), "details": r.details,
                    "created_at": iso(r.created_at), "status": r.status,
                    "target": admin_user_json(db, target) if target else None,
                    "target_profile": public_profile(p) if p else None,
                    "reporter": reporter.username if reporter else None,
                    "post": {"id": post.id, "body": post.body[:300]} if post else None,
                    "reports_against_target": db.query(func.count(Report.id)).filter(Report.target_user_id == r.target_user_id).scalar()})
    return out


@app.post("/api/admin/reports/{report_id}/close")
def admin_close_report(report_id: int, user: User = Depends(admin_user), db: Session = Depends(get_db)):
    r = db.get(Report, report_id)
    if not r:
        raise HTTPException(404, "Signalement introuvable.")
    r.status = "closed"
    db.commit()
    return {"closed": True}


@app.get("/api/admin/users")
def admin_users(q: str = Query("", max_length=80), user: User = Depends(admin_user), db: Session = Depends(get_db)):
    query = db.query(User)
    q = q.strip()
    if q:
        matching = {uid for (uid,) in db.query(Profile.user_id).filter(Profile.display_name.icontains(q, autoescape=True))}
        query = query.filter(or_(User.username.contains(q.lower(), autoescape=True), User.id.in_(matching) if matching else false()))
    return [admin_user_json(db, u) for u in query.order_by(User.id.desc()).limit(100)]


@app.post("/api/admin/users/{user_id}/suspend")
def admin_suspend(user_id: int, data: SuspendIn, user: User = Depends(admin_user), db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Compte introuvable.")
    if target.id == user.id or is_admin(target):
        raise HTTPException(422, "Impossible de suspendre un administrateur.")
    target.suspended_at, target.suspended_reason = now_utc(), clean_line(data.reason)
    target.token_version = (target.token_version or 0) + 1  # déconnecte immédiatement tous ses appareils
    db.query(PushSubscription).filter(PushSubscription.user_id == target.id).delete(synchronize_session=False)
    db.commit()
    log.info("Compte %s suspendu par %s", target.id, user.id)
    return admin_user_json(db, target)


@app.post("/api/admin/users/{user_id}/unsuspend")
def admin_unsuspend(user_id: int, user: User = Depends(admin_user), db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Compte introuvable.")
    target.suspended_at, target.suspended_reason = None, None
    db.commit()
    return admin_user_json(db, target)


# ---------- SMS ----------

@app.post("/api/sms")
def sms(data: SmsIn, user: User = Depends(current_user)):
    if not config.SMS_ENABLED:
        raise HTTPException(503, "L'envoi de SMS n'est pas activé sur ce serveur.")
    limiter.hit(f"sms:{user.id}", config.SMS_DAILY_LIMIT, 86400, f"Limite de {config.SMS_DAILY_LIMIT} SMS par jour atteinte.")
    ok, detail = send_sms(data.to_number, data.body)
    if not ok:
        raise HTTPException(502, detail)
    return {"status": "sent", "message": "SMS transmis au fournisseur."}
