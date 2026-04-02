from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
"""


class AuthRepository:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(SCHEMA_SQL)

    def count_users(self) -> int:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()
        return int(row["count"]) if row else 0

    def list_users(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, username, display_name, role, is_active, created_at, updated_at, last_login_at
                FROM users
                ORDER BY is_active DESC, display_name COLLATE NOCASE, username COLLATE NOCASE
                """,
            ).fetchall()
        return [self._serialize_user(row) for row in rows]

    def get_user_by_id(self, user_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, username, display_name, password_hash, role, is_active, created_at, updated_at, last_login_at
                FROM users
                WHERE id = ?
                """,
                (user_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, username, display_name, password_hash, role, is_active, created_at, updated_at, last_login_at
                FROM users
                WHERE lower(username) = lower(?)
                """,
                (username,),
            ).fetchone()
        return dict(row) if row else None

    def create_user(self, username: str, display_name: str, password_hash: str, role: str) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO users (username, display_name, password_hash, role, is_active, created_at, updated_at, last_login_at)
                VALUES (?, ?, ?, ?, 1, ?, ?, '')
                """,
                (username, display_name, password_hash, role, timestamp, timestamp),
            )
            connection.commit()
            user_id = int(cursor.lastrowid)
        user = self.get_user_by_id(user_id)
        if not user:
            raise RuntimeError("Created user could not be loaded.")
        return self._sanitize_user(user)

    def update_password(self, user_id: int, password_hash: str) -> dict[str, Any] | None:
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE users
                SET password_hash = ?, updated_at = ?
                WHERE id = ?
                """,
                (password_hash, timestamp, user_id),
            )
            connection.commit()
        user = self.get_user_by_id(user_id)
        return self._sanitize_user(user) if user else None

    def update_last_login(self, user_id: int) -> None:
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
                (timestamp, timestamp, user_id),
            )
            connection.commit()

    def count_active_admins(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1",
            ).fetchone()
        return int(row["count"]) if row else 0

    def delete_user(self, user_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM users WHERE id = ?", (user_id,))
            connection.commit()
        return cursor.rowcount > 0

    def create_session(self, user_id: int, token_hash: str, expires_at: str) -> None:
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO user_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_id, token_hash, timestamp, expires_at, timestamp),
            )
            connection.commit()

    def get_user_by_session_hash(self, token_hash: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    u.id,
                    u.username,
                    u.display_name,
                    u.password_hash,
                    u.role,
                    u.is_active,
                    u.created_at,
                    u.updated_at,
                    u.last_login_at,
                    s.id AS session_id,
                    s.expires_at
                FROM user_sessions AS s
                INNER JOIN users AS u ON u.id = s.user_id
                WHERE s.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
        return dict(row) if row else None

    def touch_session(self, session_id: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE user_sessions SET last_seen_at = ? WHERE id = ?",
                (_now_iso(), session_id),
            )
            connection.commit()

    def delete_session(self, token_hash: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM user_sessions WHERE token_hash = ?", (token_hash,))
            connection.commit()

    def delete_expired_sessions(self) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM user_sessions WHERE expires_at <= ?",
                (_now_iso(),),
            )
            connection.commit()

    def _serialize_user(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        data["is_active"] = bool(data.get("is_active"))
        return data

    def _sanitize_user(self, row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = self._serialize_user(row)
        data.pop("password_hash", None)
        data.pop("session_id", None)
        data.pop("expires_at", None)
        return data


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
