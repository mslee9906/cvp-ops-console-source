from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS work_history_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_card_id INTEGER NOT NULL,
    card_code TEXT NOT NULL,
    title TEXT NOT NULL,
    card_type TEXT NOT NULL,
    completed_note TEXT NOT NULL DEFAULT '',
    completed_by_user_id INTEGER,
    completed_by_name TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL,
    restored_card_id INTEGER,
    restored_at TEXT NOT NULL DEFAULT '',
    restored_by_user_id INTEGER,
    archived_card_json TEXT NOT NULL,
    archived_workflow_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_history_completed_at ON work_history_entries(completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_work_history_card_code ON work_history_entries(card_code, id DESC);
"""


class HistoryRepository:
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

    def list_entries(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM work_history_entries
                ORDER BY completed_at DESC, id DESC
                """
            ).fetchall()
        return [self._serialize_entry(row) for row in rows]

    def get_entry(self, history_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM work_history_entries WHERE id = ?",
                (history_id,),
            ).fetchone()
        return self._serialize_entry(row) if row else None

    def archive_entry(
        self,
        *,
        original_card_id: int,
        card_code: str,
        title: str,
        card_type: str,
        completed_note: str,
        completed_by_user_id: int | None,
        completed_by_name: str,
        completed_at: str,
        archived_card: dict[str, Any],
        archived_workflow: dict[str, Any],
    ) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO work_history_entries (
                    original_card_id, card_code, title, card_type, completed_note,
                    completed_by_user_id, completed_by_name, completed_at,
                    archived_card_json, archived_workflow_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    original_card_id,
                    card_code,
                    title,
                    card_type,
                    completed_note,
                    completed_by_user_id,
                    completed_by_name,
                    completed_at,
                    json.dumps(archived_card, ensure_ascii=False),
                    json.dumps(archived_workflow, ensure_ascii=False),
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
            history_id = int(cursor.lastrowid)
        saved = self.get_entry(history_id)
        if not saved:
            raise RuntimeError("Archived history entry could not be reloaded.")
        return saved

    def mark_restored(
        self,
        history_id: int,
        *,
        restored_card_id: int,
        restored_by_user_id: int | None,
        restored_at: str | None = None,
    ) -> dict[str, Any] | None:
        timestamp = str(restored_at or _now_iso())
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE work_history_entries
                SET restored_card_id = ?, restored_by_user_id = ?, restored_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (restored_card_id, restored_by_user_id, timestamp, timestamp, history_id),
            )
            connection.commit()
        return self.get_entry(history_id)

    def _serialize_entry(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "original_card_id": int(row["original_card_id"]),
            "card_code": str(row["card_code"]),
            "title": str(row["title"]),
            "card_type": str(row["card_type"]),
            "completed_note": str(row["completed_note"] or ""),
            "completed_by_user_id": row["completed_by_user_id"],
            "completed_by_name": str(row["completed_by_name"] or ""),
            "completed_at": str(row["completed_at"]),
            "restored_card_id": row["restored_card_id"],
            "restored_at": str(row["restored_at"] or ""),
            "restored_by_user_id": row["restored_by_user_id"],
            "archived_card": json.loads(str(row["archived_card_json"]) or "{}"),
            "archived_workflow": json.loads(str(row["archived_workflow_json"]) or "{}"),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
