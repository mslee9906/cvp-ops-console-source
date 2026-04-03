from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS edm_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    link_type TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    color_key TEXT NOT NULL DEFAULT 'ocean',
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edm_links_order ON edm_links(sort_order, id);
"""


class EdmLinkRepository:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(SCHEMA_SQL)

    def list_links(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, title, subtitle, link_type, url, color_key, sort_order, created_at, updated_at
                FROM edm_links
                ORDER BY sort_order, id
                """,
            ).fetchall()
        return [dict(row) for row in rows]

    def create_link(self, payload: dict[str, Any]) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            next_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM edm_links",
            ).fetchone()[0]
            cursor = connection.execute(
                """
                INSERT INTO edm_links (
                    title, subtitle, link_type, url, color_key, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["title"],
                    payload.get("subtitle", ""),
                    payload.get("link_type", ""),
                    payload["url"],
                    payload.get("color_key", "ocean"),
                    int(next_order),
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
            link_id = int(cursor.lastrowid)
        return self.get_link(link_id) or {}

    def get_link(self, link_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, title, subtitle, link_type, url, color_key, sort_order, created_at, updated_at
                FROM edm_links
                WHERE id = ?
                """,
                (link_id,),
            ).fetchone()
        return dict(row) if row else None

    def update_link(self, link_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        if not changes:
            return self.get_link(link_id)

        allowed_fields = {"title", "subtitle", "link_type", "url", "color_key", "sort_order"}
        updates = {key: value for key, value in changes.items() if key in allowed_fields}
        if not updates:
            return self.get_link(link_id)

        updates["updated_at"] = _now_iso()

        with self._connect() as connection:
            exists = connection.execute("SELECT id FROM edm_links WHERE id = ?", (link_id,)).fetchone()
            if not exists:
                return None

            assignments = ", ".join(f"{field} = ?" for field in updates)
            params = [updates[field] for field in updates]
            params.append(link_id)
            connection.execute(f"UPDATE edm_links SET {assignments} WHERE id = ?", params)
            connection.commit()
        return self.get_link(link_id)

    def delete_link(self, link_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM edm_links WHERE id = ?", (link_id,))
            self._normalize_order(connection)
            connection.commit()
        return cursor.rowcount > 0

    def _normalize_order(self, connection: sqlite3.Connection) -> None:
        rows = connection.execute(
            "SELECT id FROM edm_links ORDER BY sort_order, id",
        ).fetchall()
        connection.executemany(
            "UPDATE edm_links SET sort_order = ? WHERE id = ?",
            [(index + 1, int(row["id"])) for index, row in enumerate(rows)],
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
