import logging

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DATABASE_URL

log = logging.getLogger("cool_messenger.db")

IS_SQLITE = DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if IS_SQLITE else {}
# pool_recycle : les bases hébergées coupent les connexions restées inactives.
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True, pool_recycle=300)

if IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
BLOB = "BLOB" if IS_SQLITE else "BYTEA"


class Base(DeclarativeBase):
    pass


def _columns(table: str) -> dict:
    return {c["name"]: c for c in inspect(engine).get_columns(table)}


def _rebuild_sqlite_messages():
    """SQLite ne sait pas rendre une colonne facultative : on recopie la table des messages."""
    from .models import Message  # import local : models dépend de ce module

    old_columns = list(_columns("messages"))
    old_indexes = [i["name"] for i in inspect(engine).get_indexes("messages") if i.get("name")]
    new_columns = {c.name for c in Message.__table__.columns}
    common = ", ".join(f'"{c}"' for c in old_columns if c in new_columns)
    # Transaction gérée à la main : tout est annulé si une étape échoue.
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        conn.exec_driver_sql("BEGIN")
        try:
            conn.exec_driver_sql("ALTER TABLE messages RENAME TO messages_old")
            for name in old_indexes:
                conn.exec_driver_sql(f'DROP INDEX IF EXISTS "{name}"')
            Message.__table__.create(conn)
            conn.exec_driver_sql(f"INSERT INTO messages ({common}) SELECT {common} FROM messages_old")
            conn.exec_driver_sql("DROP TABLE messages_old")
            conn.exec_driver_sql("COMMIT")
        except Exception:
            conn.exec_driver_sql("ROLLBACK")
            raise
        finally:
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
    log.info("Table des messages mise à jour (groupes).")


def init_db():
    """Crée les tables et met à niveau une base créée par une version précédente.
    Chaque étape ne s'exécute que si elle est nécessaire : on peut relancer sans risque."""
    from . import models  # noqa: F401  (enregistre toutes les tables)

    Base.metadata.create_all(bind=engine)

    # Messages de groupe : le destinataire devient facultatif.
    if _columns("messages")["recipient_id"]["nullable"] is False:
        if IS_SQLITE:
            _rebuild_sqlite_messages()
        else:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE messages ALTER COLUMN recipient_id DROP NOT NULL"))

    additions = {
        "messages": {
            "read_at": "TIMESTAMP",
            "media_data": BLOB,
            "group_id": "INTEGER REFERENCES groups(id)",
            "kind": "VARCHAR(10)",
            "media_name": "VARCHAR(200)",
            "media_size": "INTEGER",
        },
        "users": {
            "token_version": "INTEGER NOT NULL DEFAULT 0",
            "avatar_data": BLOB,
            "avatar_type": "VARCHAR(40)",
            "avatar_version": "INTEGER NOT NULL DEFAULT 0",
        },
    }
    for table, wanted in additions.items():
        existing = _columns(table)
        with engine.begin() as conn:
            for name, sql_type in wanted.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))

    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_group_id ON messages (group_id)"))
        # Messages enregistrés avant l'apparition des types de fichiers : ce sont des vocaux.
        conn.execute(text("UPDATE messages SET kind = 'voice' WHERE media_path IS NOT NULL AND kind IS NULL"))
        conn.execute(text("UPDATE messages SET media_size = length(media_data) "
                          "WHERE media_data IS NOT NULL AND media_size IS NULL"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
