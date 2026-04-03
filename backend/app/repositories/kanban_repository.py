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
    due_at TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    assignee_user_id INTEGER,
    created_by_user_id INTEGER,
    updated_by_user_id INTEGER,
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
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kanban_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    target_kind TEXT NOT NULL,
    display_name TEXT NOT NULL,
    mgmt_ip TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    role_hint TEXT NOT NULL DEFAULT '',
    cvp_device_id TEXT NOT NULL DEFAULT '',
    match_status TEXT NOT NULL DEFAULT 'manual_only',
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kanban_planned_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL UNIQUE,
    config_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(target_id) REFERENCES kanban_targets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_order ON kanban_cards(column_key, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_kanban_checklist_items_card_order ON kanban_checklist_items(card_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_kanban_targets_card_order ON kanban_targets(card_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_kanban_targets_cvp_device_id ON kanban_targets(cvp_device_id);
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
                SELECT
                    c.id,
                    c.card_code,
                    c.title,
                    c.description,
                    c.due_at,
                    COALESCE(assignee_user.display_name, c.assignee, '') AS assignee,
                    c.assignee_user_id,
                    c.created_by_user_id,
                    COALESCE(created_user.display_name, '') AS created_by_name,
                    c.updated_by_user_id,
                    COALESCE(updated_user.display_name, '') AS updated_by_name,
                    c.column_key,
                    c.card_type,
                    c.priority,
                    c.sort_order,
                    c.created_at,
                    c.updated_at
                FROM kanban_cards AS c
                LEFT JOIN users AS assignee_user ON assignee_user.id = c.assignee_user_id
                LEFT JOIN users AS created_user ON created_user.id = c.created_by_user_id
                LEFT JOIN users AS updated_user ON updated_user.id = c.updated_by_user_id
                ORDER BY
                    """
                + _CARD_ORDER_SQL
                + """,
                    c.sort_order,
                    c.id
                """,
            ).fetchall()
            card_ids = [int(row["id"]) for row in rows]
            checklist_map = self._get_checklist_map(connection, card_ids)
            target_map = self._get_target_map(connection, card_ids)
            planned_config_map = self._get_planned_config_map(connection, card_ids)
        return [
            self._hydrate_card(
                row,
                checklist_map.get(int(row["id"]), []),
                target_map.get(int(row["id"]), []),
                planned_config_map.get(int(row["id"]), []),
            )
            for row in rows
        ]

    def create_card(self, payload: dict[str, Any]) -> dict[str, Any]:
        timestamp = _now_iso()
        checklist_items = payload.get("checklist_items") or []
        target_items = payload.get("targets") or []
        planned_configs = payload.get("planned_configs") or []

        with self._connect() as connection:
            next_number = connection.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM kanban_cards").fetchone()[0]
            card_code = f"KAN-{int(next_number):03d}"
            next_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM kanban_cards WHERE column_key = ?",
                (payload["column_key"],),
            ).fetchone()[0]
            assignee_user_id = _normalize_optional_int(payload.get("assignee_user_id"))
            created_by_user_id = _normalize_optional_int(payload.get("created_by_user_id"))
            updated_by_user_id = _normalize_optional_int(payload.get("updated_by_user_id")) or created_by_user_id
            assignee = self._resolve_user_display_name(connection, assignee_user_id, str(payload.get("assignee", "") or ""))
            cursor = connection.execute(
                """
                INSERT INTO kanban_cards (
                    card_code, title, description, assignee, assignee_user_id, created_by_user_id, updated_by_user_id,
                    column_key, card_type, priority, sort_order, created_at, updated_at, due_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card_code,
                    payload["title"],
                    payload.get("description", ""),
                    assignee,
                    assignee_user_id,
                    created_by_user_id,
                    updated_by_user_id,
                    payload["column_key"],
                    payload["card_type"],
                    payload["priority"],
                    int(next_order),
                    timestamp,
                    timestamp,
                    str(payload.get("due_at", "") or "").strip(),
                ),
            )
            card_id = int(cursor.lastrowid)
            self._replace_checklist_items(connection, card_id, checklist_items, timestamp)
            target_id_map = self._replace_target_items(connection, card_id, target_items, timestamp)
            self._replace_planned_config_items(connection, card_id, planned_configs, timestamp, target_id_map)
            connection.commit()
        return self.get_card(card_id) or {}

    def get_card(self, card_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            return self._get_card(connection, card_id)

    def get_target(self, target_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, card_id, target_kind, display_name, mgmt_ip, model, role_hint, cvp_device_id, match_status,
                       sort_order, created_at, updated_at
                FROM kanban_targets
                WHERE id = ?
                """,
                (target_id,),
            ).fetchone()
            if not row:
                return None

            target = dict(row)
            target["target_kind"] = _normalize_enum_value(target.get("target_kind"), "existing")
            target["match_status"] = _normalize_enum_value(target.get("match_status"), "manual_only")
            target["service_status"] = self._calculate_service_status(connection, target.get("cvp_device_id", ""))
            return target

    def get_planned_config(self, target_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, target_id, config_text, created_at, updated_at
                FROM kanban_planned_configs
                WHERE target_id = ?
                """,
                (target_id,),
            ).fetchone()
        return dict(row) if row else None

    def update_card(self, card_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        if not changes:
            return self.get_card(card_id)

        allowed_fields = {
            "title",
            "description",
            "due_at",
            "assignee",
            "assignee_user_id",
            "updated_by_user_id",
            "column_key",
            "card_type",
            "priority",
        }
        updates = {key: value for key, value in changes.items() if key in allowed_fields}
        checklist_items = changes.get("checklist_items")
        target_items = changes.get("targets")
        planned_configs = changes.get("planned_configs")
        if not updates and checklist_items is None and target_items is None and planned_configs is None:
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
            if updates or checklist_items is not None or target_items is not None or planned_configs is not None:
                updates["updated_at"] = timestamp

            if "assignee_user_id" in updates or "assignee" in updates:
                assignee_user_id = _normalize_optional_int(updates.get("assignee_user_id"))
                updates["assignee_user_id"] = assignee_user_id
                updates["assignee"] = self._resolve_user_display_name(
                    connection,
                    assignee_user_id,
                    str(updates.get("assignee", "") or ""),
                )

            if "due_at" in updates:
                updates["due_at"] = str(updates.get("due_at", "") or "").strip()

            if "updated_by_user_id" in updates:
                updates["updated_by_user_id"] = _normalize_optional_int(updates.get("updated_by_user_id"))

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

            target_id_map: dict[int, int] = {}
            if target_items is not None:
                target_id_map = self._replace_target_items(connection, card_id, target_items, timestamp)

            if planned_configs is not None:
                self._replace_planned_config_items(connection, card_id, planned_configs, timestamp, target_id_map)

            if len(affected_columns) > 1:
                self._normalize_column_orders(connection, affected_columns)
            connection.commit()
            return self._get_card(connection, card_id)

    def touch_card(
        self,
        card_id: int,
        updated_by_user_id: int | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any] | None:
        resolved_timestamp = str(timestamp or _now_iso())
        normalized_user_id = _normalize_optional_int(updated_by_user_id) if updated_by_user_id is not None else None

        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not existing:
                return None

            if normalized_user_id is None:
                connection.execute(
                    "UPDATE kanban_cards SET updated_at = ? WHERE id = ?",
                    (resolved_timestamp, card_id),
                )
            else:
                connection.execute(
                    "UPDATE kanban_cards SET updated_at = ?, updated_by_user_id = ? WHERE id = ?",
                    (resolved_timestamp, normalized_user_id, card_id),
                )
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

            cursor = connection.execute("DELETE FROM kanban_cards WHERE id = ?", (card_id,))
            self._normalize_column_orders(connection, {str(row["column_key"])})
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
            SELECT
                c.id,
                c.card_code,
                c.title,
                c.description,
                c.due_at,
                COALESCE(assignee_user.display_name, c.assignee, '') AS assignee,
                c.assignee_user_id,
                c.created_by_user_id,
                COALESCE(created_user.display_name, '') AS created_by_name,
                c.updated_by_user_id,
                COALESCE(updated_user.display_name, '') AS updated_by_name,
                c.column_key,
                c.card_type,
                c.priority,
                c.sort_order,
                c.created_at,
                c.updated_at
            FROM kanban_cards AS c
            LEFT JOIN users AS assignee_user ON assignee_user.id = c.assignee_user_id
            LEFT JOIN users AS created_user ON created_user.id = c.created_by_user_id
            LEFT JOIN users AS updated_user ON updated_user.id = c.updated_by_user_id
            WHERE c.id = ?
            """,
            (card_id,),
        ).fetchone()
        if not row:
            return None

        checklist_map = self._get_checklist_map(connection, [card_id])
        target_map = self._get_target_map(connection, [card_id])
        planned_config_map = self._get_planned_config_map(connection, [card_id])
        return self._hydrate_card(
            row,
            checklist_map.get(card_id, []),
            target_map.get(card_id, []),
            planned_config_map.get(card_id, []),
        )

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

    def _get_target_map(
        self,
        connection: sqlite3.Connection,
        card_ids: list[int] | None = None,
    ) -> dict[int, list[dict[str, Any]]]:
        query = """
            SELECT id, card_id, target_kind, display_name, mgmt_ip, model, role_hint, cvp_device_id, match_status,
                   sort_order, created_at, updated_at
            FROM kanban_targets
        """
        params: list[Any] = []
        if card_ids:
            placeholders = ", ".join("?" for _ in card_ids)
            query += f" WHERE card_id IN ({placeholders})"
            params.extend(card_ids)
        query += " ORDER BY card_id, sort_order, id"

        rows = connection.execute(query, params).fetchall()
        service_status_map = self._get_service_status_map(connection, rows)
        target_map: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            item["target_kind"] = _normalize_enum_value(item.get("target_kind"), "existing")
            item["match_status"] = _normalize_enum_value(item.get("match_status"), "manual_only")
            item["service_status"] = service_status_map.get(int(item["id"]), "planned")
            target_map.setdefault(int(item["card_id"]), []).append(item)
        return target_map

    def _get_planned_config_map(
        self,
        connection: sqlite3.Connection,
        card_ids: list[int] | None = None,
    ) -> dict[int, list[dict[str, Any]]]:
        query = """
            SELECT p.id, p.target_id, p.config_text, p.created_at, p.updated_at, t.card_id
            FROM kanban_planned_configs AS p
            INNER JOIN kanban_targets AS t ON t.id = p.target_id
        """
        params: list[Any] = []
        if card_ids:
            placeholders = ", ".join("?" for _ in card_ids)
            query += f" WHERE t.card_id IN ({placeholders})"
            params.extend(card_ids)
        query += " ORDER BY t.card_id, t.sort_order, p.id"

        rows = connection.execute(query, params).fetchall()
        planned_config_map: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            card_id = int(item.pop("card_id"))
            planned_config_map.setdefault(card_id, []).append(item)
        return planned_config_map

    def _hydrate_card(
        self,
        row: sqlite3.Row,
        checklist_items: list[dict[str, Any]],
        targets: list[dict[str, Any]],
        planned_configs: list[dict[str, Any]],
    ) -> dict[str, Any]:
        card = dict(row)
        completed = sum(1 for item in checklist_items if item["is_completed"])
        total = len(checklist_items)
        progress_percent = int(round((completed / total) * 100)) if total else 0
        card["due_at"] = str(card.get("due_at", "") or "").strip()
        card["assignee"] = card.get("assignee", "") or ""
        card["assignee_user_id"] = _normalize_optional_int(card.get("assignee_user_id"))
        card["created_by_user_id"] = _normalize_optional_int(card.get("created_by_user_id"))
        card["updated_by_user_id"] = _normalize_optional_int(card.get("updated_by_user_id"))
        card["created_by_name"] = card.get("created_by_name", "") or ""
        card["updated_by_name"] = card.get("updated_by_name", "") or ""
        card["checklist_items"] = checklist_items
        card["targets"] = targets
        card["planned_configs"] = planned_configs
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

    def _replace_target_items(
        self,
        connection: sqlite3.Connection,
        card_id: int,
        items: list[dict[str, Any]],
        timestamp: str,
    ) -> dict[int, int]:
        existing_rows = connection.execute(
            """
            SELECT id
            FROM kanban_targets
            WHERE card_id = ?
            """,
            (card_id,),
        ).fetchall()
        existing_ids = {int(row["id"]) for row in existing_rows}
        retained_existing_ids: set[int] = set()
        target_id_map: dict[int, int] = {}

        for index, raw_item in enumerate(items, start=1):
            display_name = str(raw_item.get("display_name", "")).strip()
            if not display_name:
                continue

            raw_item_id = raw_item.get("id")
            item_id = int(raw_item_id) if raw_item_id is not None else None
            sort_order = int(raw_item.get("sort_order") or index)
            values = (
                _normalize_enum_value(raw_item.get("target_kind"), "existing"),
                display_name,
                str(raw_item.get("mgmt_ip", "") or ""),
                str(raw_item.get("model", "") or ""),
                str(raw_item.get("role_hint", "") or ""),
                str(raw_item.get("cvp_device_id", "") or ""),
                _normalize_enum_value(raw_item.get("match_status"), "manual_only"),
                sort_order,
                timestamp,
            )

            if item_id is not None and item_id in existing_ids:
                retained_existing_ids.add(item_id)
                connection.execute(
                    """
                    UPDATE kanban_targets
                    SET target_kind = ?, display_name = ?, mgmt_ip = ?, model = ?, role_hint = ?,
                        cvp_device_id = ?, match_status = ?, sort_order = ?, updated_at = ?
                    WHERE id = ? AND card_id = ?
                    """,
                    (*values, item_id, card_id),
                )
                target_id_map[item_id] = item_id
                continue

            cursor = connection.execute(
                """
                INSERT INTO kanban_targets (
                    card_id, target_kind, display_name, mgmt_ip, model, role_hint, cvp_device_id,
                    match_status, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (card_id, *values[:-1], timestamp, timestamp),
            )
            inserted_id = int(cursor.lastrowid)
            retained_existing_ids.add(inserted_id)
            if item_id is not None:
                target_id_map[item_id] = inserted_id
            target_id_map[inserted_id] = inserted_id

        removed_ids = existing_ids - retained_existing_ids
        if removed_ids:
            placeholders = ", ".join("?" for _ in removed_ids)
            connection.execute(
                f"DELETE FROM kanban_targets WHERE card_id = ? AND id IN ({placeholders})",
                [card_id, *sorted(removed_ids)],
            )

        self._normalize_target_orders(connection, card_id)

        current_ids = [
            int(row["id"])
            for row in connection.execute(
                """
                SELECT id
                FROM kanban_targets
                WHERE card_id = ?
                ORDER BY sort_order, id
                """,
                (card_id,),
            ).fetchall()
        ]
        for current_id in current_ids:
            target_id_map.setdefault(current_id, current_id)
        return target_id_map

    def _replace_planned_config_items(
        self,
        connection: sqlite3.Connection,
        card_id: int,
        items: list[dict[str, Any]],
        timestamp: str,
        target_id_map: dict[int, int] | None = None,
    ) -> None:
        target_rows = connection.execute(
            """
            SELECT id
            FROM kanban_targets
            WHERE card_id = ?
            """,
            (card_id,),
        ).fetchall()
        valid_target_ids = {int(row["id"]) for row in target_rows}
        existing_rows = connection.execute(
            """
            SELECT p.id, p.target_id
            FROM kanban_planned_configs AS p
            INNER JOIN kanban_targets AS t ON t.id = p.target_id
            WHERE t.card_id = ?
            """,
            (card_id,),
        ).fetchall()
        existing_by_target = {
            int(row["target_id"]): int(row["id"])
            for row in existing_rows
        }
        retained_targets: set[int] = set()
        resolved_id_map = target_id_map or {}

        for raw_item in items:
            raw_target_id = raw_item.get("target_id")
            if raw_target_id is None:
                continue
            target_id = resolved_id_map.get(int(raw_target_id), int(raw_target_id))
            if target_id not in valid_target_ids:
                continue

            config_text = str(raw_item.get("config_text", "") or "").rstrip()
            retained_targets.add(target_id)

            existing_id = existing_by_target.get(target_id)
            if existing_id is not None:
                connection.execute(
                    """
                    UPDATE kanban_planned_configs
                    SET config_text = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (config_text, timestamp, existing_id),
                )
                continue

            connection.execute(
                """
                INSERT INTO kanban_planned_configs (target_id, config_text, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (target_id, config_text, timestamp, timestamp),
            )

        removed_target_ids = set(existing_by_target) - retained_targets
        if removed_target_ids:
            placeholders = ", ".join("?" for _ in removed_target_ids)
            connection.execute(
                f"DELETE FROM kanban_planned_configs WHERE target_id IN ({placeholders})",
                sorted(removed_target_ids),
            )

    def _get_service_status_map(
        self,
        connection: sqlite3.Connection,
        target_rows: list[sqlite3.Row],
    ) -> dict[int, str]:
        linked_target_ids = {
            int(row["id"]): str(row["cvp_device_id"] or "")
            for row in target_rows
            if str(row["cvp_device_id"] or "").strip()
        }
        return {
            target_id: self._calculate_service_status(connection, device_id)
            for target_id, device_id in linked_target_ids.items()
        }

    def _calculate_service_status(self, connection: sqlite3.Connection, device_id: str) -> str:
        normalized_device_id = str(device_id or "").strip()
        if not normalized_device_id:
            return "planned"

        device_exists = connection.execute(
            "SELECT 1 FROM devices WHERE device_id = ? LIMIT 1",
            (normalized_device_id,),
        ).fetchone()
        if not device_exists:
            return "planned"

        has_config = bool(
            connection.execute(
                "SELECT 1 FROM config_snapshots WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )
        has_bgp = bool(
            connection.execute(
                "SELECT 1 FROM bgp_entries WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )
        has_vrf = bool(
            connection.execute(
                "SELECT 1 FROM vrfs WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )
        has_vlan = bool(
            connection.execute(
                "SELECT 1 FROM vlans WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )
        has_vni = bool(
            connection.execute(
                "SELECT 1 FROM vni_entries WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )
        has_ip = bool(
            connection.execute(
                "SELECT 1 FROM ip_records WHERE device_id = ? LIMIT 1",
                (normalized_device_id,),
            ).fetchone()
        )

        signal_count = sum(1 for flag in [has_config, has_bgp, has_vrf, has_vlan, has_vni, has_ip] if flag)
        if signal_count == 0:
            return "mgmt_only"
        if has_config and signal_count >= 2:
            return "service_ready"
        return "service_partial"

    def _resolve_user_display_name(
        self,
        connection: sqlite3.Connection,
        user_id: int | None,
        fallback: str = "",
    ) -> str:
        if user_id is None:
            return fallback.strip()
        row = connection.execute(
            "SELECT display_name FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return str(row["display_name"]).strip() if row else fallback.strip()

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

    def _normalize_target_orders(self, connection: sqlite3.Connection, card_id: int) -> None:
        rows = connection.execute(
            """
            SELECT id
            FROM kanban_targets
            WHERE card_id = ?
            ORDER BY sort_order, id
            """,
            (card_id,),
        ).fetchall()
        connection.executemany(
            "UPDATE kanban_targets SET sort_order = ? WHERE id = ?",
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
        if "due_at" not in card_columns:
            connection.execute("ALTER TABLE kanban_cards ADD COLUMN due_at TEXT NOT NULL DEFAULT ''")
        if "assignee_user_id" not in card_columns:
            connection.execute("ALTER TABLE kanban_cards ADD COLUMN assignee_user_id INTEGER")
        if "created_by_user_id" not in card_columns:
            connection.execute("ALTER TABLE kanban_cards ADD COLUMN created_by_user_id INTEGER")
        if "updated_by_user_id" not in card_columns:
            connection.execute("ALTER TABLE kanban_cards ADD COLUMN updated_by_user_id INTEGER")

        target_table_exists = bool(
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_targets'",
            ).fetchone()
        )
        if target_table_exists:
            connection.execute(
                """
                UPDATE kanban_targets
                SET target_kind = CASE
                    WHEN instr(target_kind, '.') > 0 THEN substr(target_kind, instr(target_kind, '.') + 1)
                    ELSE target_kind
                END,
                match_status = CASE
                    WHEN instr(match_status, '.') > 0 THEN substr(match_status, instr(match_status, '.') + 1)
                    ELSE match_status
                END
                """,
            )


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _normalize_enum_value(value: Any, default: str) -> str:
    if value is None:
        return default
    raw_value = getattr(value, "value", value)
    token = str(raw_value or default).strip()
    if "." in token:
        token = token.rsplit(".", 1)[-1]
    return token or default


def _normalize_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    token = str(value).strip()
    if not token:
        return None
    return int(token)


_CARD_ORDER_SQL = """
CASE c.column_key
    WHEN 'blocked' THEN 1
    WHEN 'planned' THEN 2
    WHEN 'ready' THEN 3
    WHEN 'in_progress' THEN 4
    WHEN 'verifying' THEN 5
    WHEN 'done' THEN 6
    ELSE 99
END
"""
