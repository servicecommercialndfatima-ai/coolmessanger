import base64
import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import HTTPException

from .config import SECRET_KEY, TOKEN_DAYS

ALGORITHM = "HS256"


def _prepare(password: str) -> bytes:
    # bcrypt ignore tout au-delà de 72 octets : on condense d'abord le mot de passe.
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prepare(password), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prepare(password), hashed.encode("ascii"))
    except ValueError:
        return False


# Vérifié quand le compte n'existe pas, pour que la réponse prenne le même temps.
DUMMY_HASH = hash_password(secrets.token_hex(16))


def create_token(user_id: int, version: int = 0) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "ver": int(version or 0), "iat": now, "exp": now + timedelta(days=TOKEN_DAYS)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def read_token(token: str) -> tuple[int, int] | None:
    """Renvoie (identifiant, version de session). Les jetons des versions précédentes valent version 0."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]})
        return int(payload["sub"]), int(payload.get("ver", 0))
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        return None


class RateLimiter:
    """Limiteur à fenêtre glissante, en mémoire (suffisant pour une seule instance)."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: int, message: str = "Trop de tentatives. Réessayez plus tard."):
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 20000:
                for k in [k for k, q in self._hits.items() if not q or q[-1] < now - 86400]:
                    del self._hits[k]
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, int(q[0] + window - now) + 1)
                raise HTTPException(429, message, headers={"Retry-After": str(retry)})
            q.append(now)


limiter = RateLimiter()
