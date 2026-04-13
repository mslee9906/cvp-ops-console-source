from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bgp_as_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    asn TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    reserved_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    fulfilled_at TEXT NOT NULL DEFAULT '',
    cancelled_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE,
    FOREIGN KEY(reserved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vni_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    vni TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    reserved_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    fulfilled_at TEXT NOT NULL DEFAULT '',
    cancelled_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE,
    FOREIGN KEY(reserved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bgp_as_reservations_card_status
    ON bgp_as_reservations(card_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_vni_reservations_card_status
    ON vni_reservations(card_id, status, updated_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgp_as_reservations_active_value
    ON bgp_as_reservations(asn)
    WHERE status = 'reserved';
CREATE UNIQUE INDEX IF NOT EXISTS idx_vni_reservations_active_value
    ON vni_reservations(vni)
    WHERE status = 'reserved';
"""


class ReservationRepository:
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

    def list_card_bgp_as_reservations(self, card_id: int) -> list[dict[str, Any]]:
        return self._list_card_reservations("bgp_as", card_id)

    def list_card_vni_reservations(self, card_id: int) -> list[dict[str, Any]]:
        return self._list_card_reservations("vni", card_id)

    def get_bgp_as_reservation(self, reservation_id: int) -> dict[str, Any] | None:
        return self._get_reservation("bgp_as", reservation_id)

    def get_vni_reservation(self, reservation_id: int) -> dict[str, Any] | None:
        return self._get_reservation("vni", reservation_id)

    def get_active_bgp_as_reservation(self, asn: str) -> dict[str, Any] | None:
        return self._get_active_by_value("bgp_as", asn)

    def get_active_vni_reservation(self, vni: str) -> dict[str, Any] | None:
        return self._get_active_by_value("vni", vni)

    def list_active_bgp_as_reservations(self, asn_filter: str | None = None) -> list[dict[str, Any]]:
        filter_value = str(asn_filter or "").strip().lower()
        query = self._base_select_sql("bgp_as") + " WHERE r.status = 'reserved'"
        params: list[Any] = []
        if filter_value:
            query += " AND lower(r.asn) LIKE ?"
            params.append(f"%{filter_value}%")
        query += " ORDER BY CAST(r.asn AS INTEGER), r.asn"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._serialize_row("bgp_as", row) for row in rows]

    def list_active_vni_reservations(self, vni_filter: str | None = None) -> list[dict[str, Any]]:
        filter_value = str(vni_filter or "").strip().lower()
        query = self._base_select_sql("vni") + " WHERE r.status = 'reserved'"
        params: list[Any] = []
        if filter_value:
            query += " AND lower(r.vni) LIKE ?"
            params.append(f"%{filter_value}%")
        query += " ORDER BY CAST(r.vni AS INTEGER), r.vni"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._serialize_row("vni", row) for row in rows]

    def create_bgp_as_reservation(
        self,
        *,
        card_id: int,
        asn: str,
        reserved_by_user_id: int | None,
    ) -> dict[str, Any]:
        return self._create_reservation("bgp_as", card_id=card_id, value=asn, reserved_by_user_id=reserved_by_user_id)

    def create_vni_reservation(
        self,
        *,
        card_id: int,
        vni: str,
        reserved_by_user_id: int | None,
    ) -> dict[str, Any]:
        return self._create_reservation("vni", card_id=card_id, value=vni, reserved_by_user_id=reserved_by_user_id)

    def cancel_bgp_as_reservation(self, reservation_id: int) -> dict[str, Any] | None:
        return self._transition_reservation("bgp_as", reservation_id, status="cancelled")

    def cancel_vni_reservation(self, reservation_id: int) -> dict[str, Any] | None:
        return self._transition_reservation("vni", reservation_id, status="cancelled")

    def fulfill_bgp_as_reservations(self, asns: set[str]) -> int:
        return self._fulfill_values("bgp_as", asns)

    def fulfill_vni_reservations(self, vnis: set[str]) -> int:
        return self._fulfill_values("vni", vnis)

    def _list_card_reservations(self, kind: str, card_id: int) -> list[dict[str, Any]]:
        query = self._base_select_sql(kind) + """
            WHERE r.card_id = ?
            ORDER BY
                CASE r.status
                    WHEN 'reserved' THEN 1
                    WHEN 'fulfilled' THEN 2
                    ELSE 3
                END,
                r.updated_at DESC,
                r.id DESC
        """
        with self._connect() as connection:
            rows = connection.execute(query, (card_id,)).fetchall()
        return [self._serialize_row(kind, row) for row in rows]

    def _get_reservation(self, kind: str, reservation_id: int) -> dict[str, Any] | None:
        query = self._base_select_sql(kind) + " WHERE r.id = ?"
        with self._connect() as connection:
            row = connection.execute(query, (reservation_id,)).fetchone()
        return self._serialize_row(kind, row) if row else None

    def _get_active_by_value(self, kind: str, value: str) -> dict[str, Any] | None:
        value_column = "asn" if kind == "bgp_as" else "vni"
        query = self._base_select_sql(kind) + f" WHERE r.status = 'reserved' AND r.{value_column} = ? LIMIT 1"
        with self._connect() as connection:
            row = connection.execute(query, (value,)).fetchone()
        return self._serialize_row(kind, row) if row else None

    def _create_reservation(
        self,
        kind: str,
        *,
        card_id: int,
        value: str,
        reserved_by_user_id: int | None,
    ) -> dict[str, Any]:
        table_name = self._table_name(kind)
        value_column = "asn" if kind == "bgp_as" else "vni"
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                INSERT INTO {table_name} (
                    card_id, {value_column}, status, reserved_by_user_id,
                    created_at, updated_at, fulfilled_at, cancelled_at
                )
                VALUES (?, ?, 'reserved', ?, ?, ?, '', '')
                """,
                (card_id, value, reserved_by_user_id, timestamp, timestamp),
            )
            connection.commit()
            reservation_id = int(cursor.lastrowid)
        return self._get_reservation(kind, reservation_id) or {}

    def _transition_reservation(self, kind: str, reservation_id: int, *, status: str) -> dict[str, Any] | None:
        table_name = self._table_name(kind)
        timestamp = _now_iso()
        column_name = "fulfilled_at" if status == "fulfilled" else "cancelled_at"
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                UPDATE {table_name}
                SET status = ?, updated_at = ?, {column_name} = CASE WHEN {column_name} = '' THEN ? ELSE {column_name} END
                WHERE id = ? AND status = 'reserved'
                """,
                (status, timestamp, timestamp, reservation_id),
            )
            connection.commit()
        if cursor.rowcount <= 0:
            return self._get_reservation(kind, reservation_id)
        return self._get_reservation(kind, reservation_id)

    def _fulfill_values(self, kind: str, values: set[str]) -> int:
        normalized_values = sorted({str(value).strip() for value in values if str(value).strip()})
        if not normalized_values:
            return 0
        table_name = self._table_name(kind)
        value_column = "asn" if kind == "bgp_as" else "vni"
        placeholders = ", ".join("?" for _ in normalized_values)
        timestamp = _now_iso()
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                UPDATE {table_name}
                SET status = 'fulfilled',
                    updated_at = ?,
                    fulfilled_at = CASE WHEN fulfilled_at = '' THEN ? ELSE fulfilled_at END
                WHERE status = 'reserved' AND {value_column} IN ({placeholders})
                """,
                [timestamp, timestamp, *normalized_values],
            )
            connection.commit()
        return int(cursor.rowcount)

    def _base_select_sql(self, kind: str) -> str:
        table_name = self._table_name(kind)
        value_column = "asn" if kind == "bgp_as" else "vni"
        return f"""
            SELECT
                r.id,
                r.card_id,
                r.{value_column} AS value,
                r.status,
                r.reserved_by_user_id,
                COALESCE(u.display_name, '') AS reserved_by_name,
                COALESCE(c.card_code, '') AS card_code,
                COALESCE(c.title, '') AS card_title,
                r.created_at,
                r.updated_at,
                r.fulfilled_at,
                r.cancelled_at
            FROM {table_name} AS r
            LEFT JOIN users AS u ON u.id = r.reserved_by_user_id
            LEFT JOIN kanban_cards AS c ON c.id = r.card_id
        """

    def _serialize_row(self, kind: str, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        data = dict(row)
        return {
            "id": int(data["id"]),
            "kind": kind,
            "value": str(data.get("value") or ""),
            "status": str(data.get("status") or "reserved"),
            "card_id": int(data.get("card_id") or 0),
            "card_code": str(data.get("card_code") or ""),
            "card_title": str(data.get("card_title") or ""),
            "reserved_by_user_id": _normalize_optional_int(data.get("reserved_by_user_id")),
            "reserved_by_name": str(data.get("reserved_by_name") or ""),
            "created_at": str(data.get("created_at") or ""),
            "updated_at": str(data.get("updated_at") or ""),
            "fulfilled_at": str(data.get("fulfilled_at") or ""),
            "cancelled_at": str(data.get("cancelled_at") or ""),
        }

    def _table_name(self, kind: str) -> str:
        if kind == "bgp_as":
            return "bgp_as_reservations"
        return "vni_reservations"


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
