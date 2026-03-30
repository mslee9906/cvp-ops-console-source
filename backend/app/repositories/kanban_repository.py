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
    assignee TEXT NOT NULL DEFAULT '',
    column_key TEXT NOT NULL,
    card_type TEXT NOT NULL,
    priority TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    is_completed INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_order ON kanban_cards(column_key, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_kanban_checklist_items_card_order ON kanban_checklist_items(card_id, sort_order, id);
"""


class KanbanRepository:
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
            self._migrate_schema(connection)

    def list_cards(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, card_code, title, description, assignee, column_key, card_type, priority, sort_order, created_at, updated_at
                FROM kanban_cards
                ORDER BY
                    """ + _CARD_ORDER_SQL + """,
                    sort_order,
                    id
                """,
            ).fetchall()
            checklist_map = self._get_checklist_map(connection)
        return [self._hydrate_card(row, checklist_map.get(int(row["id"]), [])) for row in rows]

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
                    card_code, title, description, assignee, column_key, card_type, priority, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card_code,
                    payload["title"],
                    payload.get("description", ""),
                    payload.get("assignee", ""),
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
            return self._get_card(connection, card_id)

    def update_card(self, card_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        if not changes:
            return self.get_card(card_id)

        allowed_fields = {"title", "description", "assignee", "column_key", "card_type", "priority"}
        updates = {key: value for key, value in changes.items() if key in allowed_fields}
        checklist_items = changes.get("checklist_items")
        if not updates and checklist_items is None:
            return self.get_card(card_id)

        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id, column_key FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not existing:
                return None

            affected_columns = {str(existing["column_key"])}
            if "column_key" in updates and updates["column_key"] != existing["column_key"]:
                next_order = connection.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM kanban_cards WHERE column_key = ?",
                    (updates["column_key"],),
                ).fetchone()[0]
                updates["sort_order"] = int(next_order)
                affected_columns.add(str(updates["column_key"]))

            timestamp = _now_iso()
            if updates or checklist_items is not None:
                updates["updated_at"] = timestamp

            if updates:
                assignments = ", ".join(f"{field} = ?" for field in updates)
                params = [updates[field] for field in updates]
                params.append(card_id)
                connection.execute(
                    f"UPDATE kanban_cards SET {assignments} WHERE id = ?",
                    params,
                )

            if checklist_items is not None:
                self._replace_checklist_items(connection, card_id, checklist_items, timestamp)

            if len(affected_columns) > 1:
                self._normalize_column_orders(connection, affected_columns)
            connection.commit()
            return self._get_card(connection, card_id)

    def delete_card(self, card_id: int) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT column_key FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not row:
                return False

            connection.execute("DELETE FROM kanban_checklist_items WHERE card_id = ?", (card_id,))
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

    def _get_card(self, connection: sqlite3.Connection, card_id: int) -> dict[str, Any] | None:
        row = connection.execute(
            """
            SELECT id, card_code, title, description, assignee, column_key, card_type, priority, sort_order, created_at, updated_at
            FROM kanban_cards
            WHERE id = ?
            """,
            (card_id,),
        ).fetchone()
        if not row:
            return None

        checklist_map = self._get_checklist_map(connection, [card_id])
        return self._hydrate_card(row, checklist_map.get(card_id, []))

    def _get_checklist_map(
        self,
        connection: sqlite3.Connection,
        card_ids: list[int] | None = None,
    ) -> dict[int, list[dict[str, Any]]]:
        query = """
            SELECT id, card_id, title, is_completed, sort_order, created_at, updated_at
            FROM kanban_checklist_items
        """
        params: list[Any] = []
        if card_ids:
            placeholders = ", ".join("?" for _ in card_ids)
            query += f" WHERE card_id IN ({placeholders})"
            params.extend(card_ids)
        query += " ORDER BY card_id, sort_order, id"

        rows = connection.execute(query, params).fetchall()
        checklist_map: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            item["is_completed"] = bool(item["is_completed"])
            checklist_map.setdefault(int(item["card_id"]), []).append(item)
        return checklist_map

    def _hydrate_card(self, row: sqlite3.Row, checklist_items: list[dict[str, Any]]) -> dict[str, Any]:
        card = dict(row)
        completed = sum(1 for item in checklist_items if item["is_completed"])
        total = len(checklist_items)
        progress_percent = int(round((completed / total) * 100)) if total else 0
        card["assignee"] = card.get("assignee", "") or ""
        card["checklist_items"] = checklist_items
        card["checklist_total"] = total
        card["checklist_completed"] = completed
        card["progress_percent"] = progress_percent
        return card

    def _replace_checklist_items(
        self,
        connection: sqlite3.Connection,
        card_id: int,
        items: list[dict[str, Any]],
        timestamp: str,
    ) -> None:
        existing_rows = connection.execute(
            "SELECT id FROM kanban_checklist_items WHERE card_id = ?",
            (card_id,),
        ).fetchall()
        existing_ids = {int(row["id"]) for row in existing_rows}
        retained_existing_ids: set[int] = set()

        for index, raw_item in enumerate(items, start=1):
            title = str(raw_item.get("title", "")).strip()
            if not title:
                continue

            item_id = raw_item.get("id")
            sort_order = int(raw_item.get("sort_order") or index)
            is_completed = 1 if raw_item.get("is_completed", False) else 0

            if item_id is not None and int(item_id) in existing_ids:
                retained_existing_ids.add(int(item_id))
                connection.execute(
                    """
                    UPDATE kanban_checklist_items
                    SET title = ?, is_completed = ?, sort_order = ?, updated_at = ?
                    WHERE id = ? AND card_id = ?
                    """,
                    (title, is_completed, sort_order, timestamp, int(item_id), card_id),
                )
                continue

            connection.execute(
                """
                INSERT INTO kanban_checklist_items (
                    card_id, title, is_completed, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (card_id, title, is_completed, sort_order, timestamp, timestamp),
            )

        removed_ids = existing_ids - retained_existing_ids
        if removed_ids:
            placeholders = ", ".join("?" for _ in removed_ids)
            connection.execute(
                f"DELETE FROM kanban_checklist_items WHERE card_id = ? AND id IN ({placeholders})",
                [card_id, *sorted(removed_ids)],
            )

        self._normalize_checklist_orders(connection, card_id)

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

    def _normalize_checklist_orders(self, connection: sqlite3.Connection, card_id: int) -> None:
        rows = connection.execute(
            """
            SELECT id
            FROM kanban_checklist_items
            WHERE card_id = ?
            ORDER BY sort_order, id
            """,
            (card_id,),
        ).fetchall()
        connection.executemany(
            "UPDATE kanban_checklist_items SET sort_order = ? WHERE id = ?",
            [(index + 1, int(row["id"])) for index, row in enumerate(rows)],
        )

    def _migrate_schema(self, connection: sqlite3.Connection) -> None:
        card_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(kanban_cards)").fetchall()
        }
        if "assignee" not in card_columns:
            connection.execute(
                "ALTER TABLE kanban_cards ADD COLUMN assignee TEXT NOT NULL DEFAULT ''",
            )


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


_CARD_ORDER_SQL = """
CASE column_key
    WHEN 'blocked' THEN 1
    WHEN 'planned' THEN 2
    WHEN 'ready' THEN 3
    WHEN 'in_progress' THEN 4
    WHEN 'verifying' THEN 5
    WHEN 'done' THEN 6
    ELSE 99
END
"""
