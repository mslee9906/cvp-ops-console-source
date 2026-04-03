from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflow_documents (
    card_id INTEGER PRIMARY KEY,
    workflow_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    card_type TEXT NOT NULL,
    workflow_json TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    updated_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_card_type ON workflow_templates(card_type, is_system, id);
"""


class WorkflowRepository:
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

    def get_document(self, card_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT card_id, workflow_json, created_at, updated_at
                FROM workflow_documents
                WHERE card_id = ?
                """,
                (card_id,),
            ).fetchone()
        if not row:
            return None
        return self._serialize_document(row)

    def save_document(self, card_id: int, workflow: dict[str, Any], timestamp: str | None = None) -> dict[str, Any]:
        timestamp = str(timestamp or _now_iso())
        workflow_json = json.dumps(workflow, ensure_ascii=False)
        with self._connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM workflow_documents WHERE card_id = ?",
                (card_id,),
            ).fetchone()
            if exists:
                connection.execute(
                    """
                    UPDATE workflow_documents
                    SET workflow_json = ?, updated_at = ?
                    WHERE card_id = ?
                    """,
                    (workflow_json, timestamp, card_id),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO workflow_documents (card_id, workflow_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (card_id, workflow_json, timestamp, timestamp),
                )
            connection.commit()
        saved = self.get_document(card_id)
        if not saved:
            raise RuntimeError("Saved workflow document could not be reloaded.")
        return saved

    def list_templates(self, card_type: str | None = None) -> list[dict[str, Any]]:
        query = """
            SELECT
                id,
                name,
                description,
                card_type,
                workflow_json,
                is_system,
                created_by_user_id,
                updated_by_user_id,
                created_at,
                updated_at
            FROM workflow_templates
        """
        params: list[Any] = []
        if card_type:
            query += " WHERE card_type = ?"
            params.append(card_type)
        query += " ORDER BY is_system DESC, updated_at DESC, id DESC"

        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._serialize_template(row) for row in rows]

    def get_template(self, template_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    name,
                    description,
                    card_type,
                    workflow_json,
                    is_system,
                    created_by_user_id,
                    updated_by_user_id,
                    created_at,
                    updated_at
                FROM workflow_templates
                WHERE id = ?
                """,
                (template_id,),
            ).fetchone()
        if not row:
            return None
        return self._serialize_template(row)

    def create_template(
        self,
        name: str,
        description: str,
        card_type: str,
        workflow: dict[str, Any],
        created_by_user_id: int | None = None,
        is_system: bool = False,
    ) -> dict[str, Any]:
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO workflow_templates (
                    name, description, card_type, workflow_json, is_system,
                    created_by_user_id, updated_by_user_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    description,
                    card_type,
                    json.dumps(workflow, ensure_ascii=False),
                    1 if is_system else 0,
                    created_by_user_id,
                    created_by_user_id,
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
            template_id = int(cursor.lastrowid)
        template = self.get_template(template_id)
        if not template:
            raise RuntimeError("Created workflow template could not be reloaded.")
        return template

    def update_template(self, template_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        if not changes:
            return self.get_template(template_id)

        template = self.get_template(template_id)
        if not template:
            return None

        timestamp = _now_iso()
        assignments: list[str] = []
        params: list[Any] = []

        if "name" in changes:
            assignments.append("name = ?")
            params.append(changes["name"])
        if "description" in changes:
            assignments.append("description = ?")
            params.append(changes["description"])
        if "workflow" in changes:
            assignments.append("workflow_json = ?")
            params.append(json.dumps(changes["workflow"], ensure_ascii=False))
        if "updated_by_user_id" in changes:
            assignments.append("updated_by_user_id = ?")
            params.append(changes["updated_by_user_id"])

        assignments.append("updated_at = ?")
        params.append(timestamp)
        params.append(template_id)

        with self._connect() as connection:
            connection.execute(
                f"UPDATE workflow_templates SET {', '.join(assignments)} WHERE id = ?",
                params,
            )
            connection.commit()
        return self.get_template(template_id)

    def delete_template(self, template_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM workflow_templates WHERE id = ?", (template_id,))
            connection.commit()
        return cursor.rowcount > 0

    def _serialize_document(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "card_id": int(row["card_id"]),
            "workflow": json.loads(str(row["workflow_json"]) or "{}"),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }

    def _serialize_template(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "description": str(row["description"] or ""),
            "card_type": str(row["card_type"]),
            "workflow": json.loads(str(row["workflow_json"]) or "{}"),
            "is_system": bool(row["is_system"]),
            "created_by_user_id": row["created_by_user_id"],
            "updated_by_user_id": row["updated_by_user_id"],
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
