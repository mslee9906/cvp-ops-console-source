from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS kanban_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_key TEXT NOT NULL,
    card_type TEXT NOT NULL,
    priority TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_order ON kanban_cards(column_key, sort_order, id);
"""


class KanbanRepository:
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

    def list_cards(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, card_code, title, description, column_key, card_type, priority, sort_order, created_at, updated_at
                FROM kanban_cards
                ORDER BY
                    CASE column_key
                        WHEN 'blocked' THEN 1
                        WHEN 'planned' THEN 2
                        WHEN 'ready' THEN 3
                        WHEN 'in_progress' THEN 4
                        WHEN 'verifying' THEN 5
                        WHEN 'done' THEN 6
                        ELSE 99
                    END,
                    sort_order,
                    id
                """,
            ).fetchall()
        return [dict(row) for row in rows]

    def create_card(self, payload: dict[str, Any]) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            next_number = connection.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM kanban_cards").fetchone()[0]
            card_code = f"KAN-{int(next_number):03d}"
            next_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM kanban_cards WHERE column_key = ?",
                (payload["column_key"],),
            ).fetchone()[0]
            cursor = connection.execute(
                """
                INSERT INTO kanban_cards (
                    card_code, title, description, column_key, card_type, priority, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card_code,
                    payload["title"],
                    payload.get("description", ""),
                    payload["column_key"],
                    payload["card_type"],
                    payload["priority"],
                    int(next_order),
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
            card_id = int(cursor.lastrowid)
        return self.get_card(card_id) or {}

    def get_card(self, card_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, card_code, title, description, column_key, card_type, priority, sort_order, created_at, updated_at
                FROM kanban_cards
                WHERE id = ?
                """,
                (card_id,),
            ).fetchone()
        return dict(row) if row else None

    def update_card(self, card_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        if not changes:
            return self.get_card(card_id)

        allowed_fields = {"title", "description", "column_key", "card_type", "priority"}
        updates = {key: value for key, value in changes.items() if key in allowed_fields}
        if not updates:
            return self.get_card(card_id)

        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id, column_key FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not existing:
                return None

            if "column_key" in updates and updates["column_key"] != existing["column_key"]:
                next_order = connection.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM kanban_cards WHERE column_key = ?",
                    (updates["column_key"],),
                ).fetchone()[0]
                updates["sort_order"] = int(next_order)

            updates["updated_at"] = _now_iso()
            assignments = ", ".join(f"{field} = ?" for field in updates)
            params = [updates[field] for field in updates]
            params.append(card_id)
            connection.execute(
                f"UPDATE kanban_cards SET {assignments} WHERE id = ?",
                params,
            )
            connection.commit()
        return self.get_card(card_id)

    def delete_card(self, card_id: int) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT column_key FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not row:
                return False

            cursor = connection.execute("DELETE FROM kanban_cards WHERE id = ?", (card_id,))
            self._normalize_column_orders(connection, {row["column_key"]})
            connection.commit()
        return cursor.rowcount > 0

    def reorder_cards(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not items:
            return self.list_cards()

        timestamp = _now_iso()
        with self._connect() as connection:
            existing_rows = connection.execute(
                "SELECT id, column_key FROM kanban_cards",
            ).fetchall()
            existing_map = {int(row["id"]): row["column_key"] for row in existing_rows}

            submitted_ids = [int(item["id"]) for item in items]
            if len(submitted_ids) != len(set(submitted_ids)):
                raise ValueError("Reorder payload contains duplicate card ids.")

            missing_ids = [card_id for card_id in submitted_ids if card_id not in existing_map]
            if missing_ids:
                raise ValueError("Reorder payload contains unknown cards.")

            affected_columns = {existing_map[int(item["id"])] for item in items}
            affected_columns.update(str(item["column_key"]) for item in items)

            connection.executemany(
                """
                UPDATE kanban_cards
                SET column_key = ?, sort_order = ?, updated_at = ?
                WHERE id = ?
                """,
                [
                    (
                        item["column_key"],
                        int(item["sort_order"]),
                        timestamp,
                        int(item["id"]),
                    )
                    for item in items
                ],
            )
            self._normalize_column_orders(connection, affected_columns)
            connection.commit()
        return self.list_cards()

    def _normalize_column_orders(self, connection: sqlite3.Connection, column_keys: set[str]) -> None:
        for column_key in column_keys:
            rows = connection.execute(
                """
                SELECT id
                FROM kanban_cards
                WHERE column_key = ?
                ORDER BY sort_order, id
                """,
                (column_key,),
            ).fetchall()
            connection.executemany(
                "UPDATE kanban_cards SET sort_order = ? WHERE id = ?",
                [(index + 1, int(row["id"])) for index, row in enumerate(rows)],
            )


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
