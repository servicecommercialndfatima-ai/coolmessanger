"""Notifications sur l'écran du téléphone, même quand l'application est fermée (Web Push)."""
import base64
import json
import logging

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from . import config
from .database import SessionLocal
from .models import AppSetting, PushSubscription

log = logging.getLogger("cool_messenger.push")
_keys: dict | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def vapid_keys() -> dict:
    """Clés d'identification du serveur auprès des services de notification.
    Créées une seule fois puis gardées en base : si elles changeaient, tous les abonnements seraient perdus."""
    global _keys
    if _keys:
        return _keys
    db = SessionLocal()
    try:
        private = db.get(AppSetting, "vapid_private_pem")
        public = db.get(AppSetting, "vapid_public")
        if not private or not public:
            v = Vapid()
            v.generate_keys()
            pem = v.private_pem().decode()
            pub = _b64url(v.public_key.public_bytes(serialization.Encoding.X962,
                                                    serialization.PublicFormat.UncompressedPoint))
            db.merge(AppSetting(key="vapid_private_pem", value=pem))
            db.merge(AppSetting(key="vapid_public", value=pub))
            db.commit()
            private, public = AppSetting(value=pem), AppSetting(value=pub)
        _keys = {"private": Vapid.from_pem(private.value.encode()), "public": public.value}
        return _keys
    finally:
        db.close()


def send(user_ids, payload: dict):
    """À lancer en tâche de fond : envoie la notification à tous les appareils des comptes indiqués."""
    user_ids = set(user_ids)
    if not user_ids:
        return
    keys = vapid_keys()
    db = SessionLocal()
    try:
        subs = db.query(PushSubscription).filter(PushSubscription.user_id.in_(user_ids)).all()
        data = json.dumps(payload, ensure_ascii=False)
        for sub in subs:
            try:
                webpush({"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
                        data=data, vapid_private_key=keys["private"],
                        vapid_claims={"sub": config.PUSH_CONTACT}, ttl=86400, timeout=10)
            except WebPushException as exc:
                status = exc.response.status_code if exc.response is not None else None
                if status in (404, 410):  # appareil désabonné ou application désinstallée
                    db.delete(sub)
                else:
                    log.warning("Notification non envoyée (%s)", status)
            except Exception:
                log.exception("Erreur d'envoi de notification")
        db.commit()
    finally:
        db.close()
