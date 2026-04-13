from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterable


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bgp_management_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asn TEXT NOT NULL,
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('reserved', 'custom')),
    device_names_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_by_user_id INTEGER,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(asn)
);

CREATE INDEX IF NOT EXISTS idx_bgp_management_entries_kind_asn
    ON bgp_management_entries(entry_kind, asn);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_device_names(device_names: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for raw_value in device_names:
        value = str(raw_value or "").strip()
        if not value:
            continue
        lowered = value.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(value)
    return normalized


class BgpManagementRepository:
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

    def list_entries(self) -> list[dict[str, Any]]:
        query = """
            SELECT
                id,
                asn,
                entry_kind,
                device_names_json,
                note,
                created_by_user_id,
                created_by_name,
                created_at,
                updated_at
            FROM bgp_management_entries
            ORDER BY
                CASE entry_kind
                    WHEN 'reserved' THEN 1
                    ELSE 2
                END,
                CAST(asn AS INTEGER),
                asn,
                id
        """
        with self._connect() as connection:
            rows = connection.execute(query).fetchall()
        return [self._serialize_row(row) for row in rows]

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    asn,
                    entry_kind,
                    device_names_json,
                    note,
                    created_by_user_id,
                    created_by_name,
                    created_at,
                    updated_at
                FROM bgp_management_entries
                WHERE id = ?
                """,
                (entry_id,),
            ).fetchone()
        return self._serialize_row(row) if row else None

    def get_entry_by_asn(self, asn: str) -> dict[str, Any] | None:
        normalized_asn = str(asn or "").strip()
        if not normalized_asn:
            return None
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    asn,
                    entry_kind,
                    device_names_json,
                    note,
                    created_by_user_id,
                    created_by_name,
                    created_at,
                    updated_at
                FROM bgp_management_entries
                WHERE asn = ?
                LIMIT 1
                """,
                (normalized_asn,),
            ).fetchone()
        return self._serialize_row(row) if row else None

    def create_entry(
        self,
        *,
        asn: str,
        entry_kind: str,
        device_names: Iterable[str],
        note: str,
        created_by_user_id: int | None,
        created_by_name: str,
    ) -> dict[str, Any]:
        normalized_asn = str(asn or "").strip()
        normalized_kind = str(entry_kind or "").strip().lower()
        normalized_note = str(note or "").strip()
        normalized_names = _normalize_device_names(device_names)
        timestamp = _now_iso()

        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO bgp_management_entries (
                    asn,
                    entry_kind,
                    device_names_json,
                    note,
                    created_by_user_id,
                    created_by_name,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    normalized_asn,
                    normalized_kind,
                    json.dumps(normalized_names, ensure_ascii=False),
                    normalized_note,
                    created_by_user_id,
                    str(created_by_name or "").strip(),
                    timestamp,
                    timestamp,
                ),
            )
            connection.commit()
            entry_id = int(cursor.lastrowid)
        return self.get_entry(entry_id) or {}

    def update_entry(
        self,
        entry_id: int,
        *,
        asn: str,
        entry_kind: str,
        device_names: Iterable[str],
        note: str,
    ) -> dict[str, Any] | None:
        normalized_asn = str(asn or "").strip()
        normalized_kind = str(entry_kind or "").strip().lower()
        normalized_note = str(note or "").strip()
        normalized_names = _normalize_device_names(device_names)
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE bgp_management_entries
                SET
                    asn = ?,
                    entry_kind = ?,
                    device_names_json = ?,
                    note = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    normalized_asn,
                    normalized_kind,
                    json.dumps(normalized_names, ensure_ascii=False),
                    normalized_note,
                    timestamp,
                    entry_id,
                ),
            )
            connection.commit()
        if cursor.rowcount <= 0:
            return None
        return self.get_entry(entry_id)

    def delete_entry(self, entry_id: int) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM bgp_management_entries WHERE id = ?",
                (entry_id,),
            )
            connection.commit()
        return int(cursor.rowcount)

    def _serialize_row(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        raw_names = data.get("device_names_json") or "[]"
        try:
            parsed_names = json.loads(raw_names)
        except json.JSONDecodeError:
            parsed_names = []
        device_names = _normalize_device_names(parsed_names if isinstance(parsed_names, list) else [])
        return {
            "id": int(data["id"]),
            "asn": str(data.get("asn") or ""),
            "entry_kind": str(data.get("entry_kind") or ""),
            "device_names": device_names,
            "note": str(data.get("note") or ""),
            "created_by_user_id": data.get("created_by_user_id"),
            "created_by_name": str(data.get("created_by_name") or ""),
            "created_at": str(data.get("created_at") or ""),
            "updated_at": str(data.get("updated_at") or ""),
        }
