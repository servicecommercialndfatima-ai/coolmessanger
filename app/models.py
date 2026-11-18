from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def now_utc():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    # Augmenté à chaque changement de mot de passe : les sessions ouvertes ailleurs sont alors fermées.
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Photo de profil (petite image JPEG/PNG/WebP), lue seulement quand on l'affiche.
    avatar_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Change à chaque nouvelle photo : sert à rafraîchir les images gardées en mémoire. 0 = pas de photo.
    avatar_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Block(Base):
    """« blocker » a bloqué « blocked »."""
    __tablename__ = "blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="uq_block_pair"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    blocker_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    blocked_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Group(Base):
    __tablename__ = "groups"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
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
    # Dernier message lu dans le groupe : sert au compteur de non-lus.
    last_read_id: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_pair", "sender_id", "recipient_id", "id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # Conversation à deux : recipient_id. Groupe : group_id (recipient_id vide).
    recipient_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("groups.id"), index=True, nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    # voice (vocal enregistré), audio, image, video ; vide pour un texte.
    kind: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Ancien champ : nom interne du fichier (les vocaux des premières versions étaient sur disque).
    media_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    media_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    media_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    media_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Contenu du fichier, conservé en base : le disque des hébergeurs gratuits est effacé à chaque redémarrage.
    # deferred : n'est lu que lorsqu'on ouvre le fichier, pas en listant la conversation.
    media_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sms_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
