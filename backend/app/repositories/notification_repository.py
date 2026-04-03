from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    link_view TEXT NOT NULL DEFAULT '',
    link_card_id INTEGER,
    link_phase_id TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_is_read ON notifications(user_id, is_read, id DESC);
"""


class NotificationRepository:
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

    def list_for_user(self, user_id: int, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    user_id,
                    kind,
                    title,
                    body,
                    link_view,
                    link_card_id,
                    link_phase_id,
                    is_read,
                    created_by_user_id,
                    created_at,
                    read_at
                FROM notifications
                WHERE user_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (user_id, max(1, limit)),
            ).fetchall()
        return [self._serialize_row(row) for row in rows]

    def count_unread_for_user(self, user_id: int) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
                (user_id,),
            ).fetchone()
        return int(row["count"] if row else 0)

    def create_notification(
        self,
        *,
        user_id: int,
        kind: str,
        title: str,
        body: str = "",
        link_view: str = "",
        link_card_id: int | None = None,
        link_phase_id: str = "",
        created_by_user_id: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO notifications (
                    user_id, kind, title, body, link_view, link_card_id, link_phase_id,
                    is_read, created_by_user_id, created_at, read_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '')
                """,
                (
                    user_id,
                    kind,
                    title,
                    body,
                    link_view,
                    link_card_id,
                    link_phase_id,
                    created_by_user_id,
                    timestamp,
                ),
            )
            connection.commit()
            notification_id = int(cursor.lastrowid)
        return self.get_notification(notification_id, user_id) or {}

    def get_notification(self, notification_id: int, user_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    user_id,
                    kind,
                    title,
                    body,
                    link_view,
                    link_card_id,
                    link_phase_id,
                    is_read,
                    created_by_user_id,
                    created_at,
                    read_at
                FROM notifications
                WHERE id = ? AND user_id = ?
                """,
                (notification_id, user_id),
            ).fetchone()
        return self._serialize_row(row) if row else None

    def mark_read(self, notification_id: int, user_id: int) -> dict[str, Any] | None:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE notifications
                SET is_read = 1,
                    read_at = CASE WHEN read_at = '' THEN ? ELSE read_at END
                WHERE id = ? AND user_id = ?
                """,
                (timestamp, notification_id, user_id),
            )
            connection.commit()
        if cursor.rowcount <= 0:
            return None
        return self.get_notification(notification_id, user_id)

    def mark_all_read(self, user_id: int) -> int:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE notifications
                SET is_read = 1,
                    read_at = CASE WHEN read_at = '' THEN ? ELSE read_at END
                WHERE user_id = ? AND is_read = 0
                """,
                (timestamp, user_id),
            )
            connection.commit()
        return int(cursor.rowcount)

    def _serialize_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "user_id": int(row["user_id"]),
            "kind": str(row["kind"] or "info"),
            "title": str(row["title"] or ""),
            "body": str(row["body"] or ""),
            "link_view": str(row["link_view"] or ""),
            "link_card_id": _normalize_optional_int(row["link_card_id"]),
            "link_phase_id": str(row["link_phase_id"] or ""),
            "is_read": bool(row["is_read"]),
            "created_by_user_id": _normalize_optional_int(row["created_by_user_id"]),
            "created_at": str(row["created_at"] or ""),
            "read_at": str(row["read_at"] or ""),
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _normalize_optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
