from datetime import date, datetime, timezone

from sqlalchemy import (Boolean, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

# Les trois rubriques, totalement séparées les unes des autres.
SPACES = ("business", "amour", "gbairai")
# Rubriques où il faut une demande acceptée avant de pouvoir écrire.
REQUEST_SPACES = ("amour", "gbairai")


def now_utc():
    return datetime.now(timezone.utc)


class User(Base):
    """Le compte : identifiant et mot de passe, communs aux rubriques. Le visage public est dans Profile."""
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))  # ancien nom public, repris dans le profil Gbairai
    password_hash: Mapped[str] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    avatar_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    avatar_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Faux pour les comptes créés avant les rubriques : ils choisissent leurs rubriques à la connexion.
    onboarded: Mapped[bool] = mapped_column(Boolean, default=True, server_default="0")
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    suspended_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)


class Profile(Base):
    """Le profil d'un compte dans une rubrique. Un compte a au plus un profil par rubrique,
    et rien ne relie publiquement les profils d'un même compte."""
    __tablename__ = "profiles"
    __table_args__ = (UniqueConstraint("user_id", "space", name="uq_profile_space"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    space: Mapped[str] = mapped_column(String(10), index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # Business
    company: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sector: Mapped[str | None] = mapped_column(String(60), nullable=True)
    activities: Mapped[str | None] = mapped_column(Text, nullable=True)
    website: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Amour
    sex: Mapped[str | None] = mapped_column(String(10), nullable=True)        # homme | femme
    seeking: Mapped[str | None] = mapped_column(String(10), nullable=True)    # homme | femme | les2
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Photo propre à la rubrique
    avatar_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    avatar_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContactRequest(Base):
    """Demande de contact (Amour, Gbairai) : il faut qu'elle soit acceptée pour discuter."""
    __tablename__ = "contact_requests"
    __table_args__ = (UniqueConstraint("space", "from_user_id", "to_user_id", name="uq_request"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space: Mapped[str] = mapped_column(String(10), index=True)
    from_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    to_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | accepted | declined
    message: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Post(Base):
    """Publication de la rubrique Business."""
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space: Mapped[str] = mapped_column(String(10), default="business", index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    body: Mapped[str] = mapped_column(Text)
    image_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    image_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Report(Base):
    """Signalement envoyé à l'administrateur."""
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reporter_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    space: Mapped[str | None] = mapped_column(String(10), nullable=True)
    reason: Mapped[str] = mapped_column(String(40))
    details: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    post_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="open")  # open | closed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PushSubscription(Base):
    """Téléphone ou navigateur abonné aux notifications."""
    __tablename__ = "push_subscriptions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    endpoint: Mapped[str] = mapped_column(Text, unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AppSetting(Base):
    """Réglages internes conservés en base (le disque de l'hébergeur est effacé à chaque redémarrage)."""
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class Block(Base):
    """« blocker » a bloqué « blocked », dans toutes les rubriques."""
    __tablename__ = "blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="uq_block_pair"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    blocker_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    blocked_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # Rubrique depuis laquelle le blocage a été fait (pour afficher le bon profil dans la liste).
    space: Mapped[str | None] = mapped_column(String(10), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Group(Base):
    __tablename__ = "groups"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    space: Mapped[str] = mapped_column(String(10), default="gbairai", server_default="gbairai")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id", name="uq_group_member"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_read_id: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_pair", "sender_id", "recipient_id", "id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    recipient_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("groups.id"), index=True, nullable=True)
    # Rubrique de la conversation à deux (les messages de groupe suivent la rubrique du groupe).
    space: Mapped[str] = mapped_column(String(10), default="gbairai", server_default="gbairai", index=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str | None] = mapped_column(String(10), nullable=True)
    media_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    media_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    media_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    media_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    media_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sms_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
