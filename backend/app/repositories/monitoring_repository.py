from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS monitoring_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'paused',
    status_detail TEXT NOT NULL DEFAULT '',
    last_event_at TEXT NOT NULL DEFAULT '',
    last_connected_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    source_name TEXT NOT NULL,
    source_host TEXT NOT NULL,
    source_port INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    stream_type INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL,
    stored_at TEXT NOT NULL,
    occurred_unix_ms INTEGER NOT NULL DEFAULT 0,
    severity TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    interface_name TEXT NOT NULL DEFAULT '',
    comp_name TEXT NOT NULL DEFAULT '',
    hostname1 TEXT NOT NULL DEFAULT '',
    hostname2 TEXT NOT NULL DEFAULT '',
    device_id TEXT NOT NULL DEFAULT '',
    device_id2 TEXT NOT NULL DEFAULT '',
    l2_peer TEXT NOT NULL DEFAULT '',
    is_l2_internal INTEGER NOT NULL DEFAULT 0,
    maintenance_name TEXT NOT NULL DEFAULT '',
    overlay INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    acknowledged_at TEXT NOT NULL DEFAULT '',
    bootstrap_suppressed INTEGER NOT NULL DEFAULT 0,
    cvp_link TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(source_id, event_id, stream_type, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_source_created_at
ON monitoring_events(source_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_created_at
ON monitoring_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_event_type
ON monitoring_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_runtime_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_event_card_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitoring_event_row_id INTEGER NOT NULL UNIQUE,
    kanban_card_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
"""


class MonitoringRepository:
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
            _ensure_column(connection, "monitoring_events", "acknowledged_at", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(connection, "monitoring_events", "l2_peer", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(connection, "monitoring_events", "is_l2_internal", "INTEGER NOT NULL DEFAULT 0")
            _ensure_column(connection, "monitoring_events", "bootstrap_suppressed", "INTEGER NOT NULL DEFAULT 0")
            connection.execute(
                """
                UPDATE monitoring_events
                SET overlay = CASE
                    WHEN event_type = 'SYSLOG_V2' AND severity != 'info' THEN 1
                    WHEN COALESCE(is_l2_internal, 0) = 1 THEN 1
                    ELSE 0
                END
                """
            )
            connection.commit()

    def list_sources(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    name,
                    host,
                    port,
                    username,
                    password,
                    enabled,
                    status,
                    status_detail,
                    last_event_at,
                    last_connected_at,
                    created_at,
                    updated_at
                FROM monitoring_sources
                ORDER BY id ASC
                """,
            ).fetchall()
        return [self._serialize_source(row) for row in rows]

    def replace_sources(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        timestamp = _now_iso()
        normalized = [
            self._normalize_source_payload(item, timestamp)
            for item in items
            if str(item.get("host", "") or "").strip()
        ]
        with self._connect() as connection:
            connection.execute("DELETE FROM monitoring_sources")
            for item in normalized:
                connection.execute(
                    """
                    INSERT INTO monitoring_sources (
                        name, host, port, username, password, enabled, status, status_detail,
                        last_event_at, last_connected_at, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item["name"],
                        item["host"],
                        item["port"],
                        item["username"],
                        item["password"],
                        item["enabled"],
                        item["status"],
                        item["status_detail"],
                        item["last_event_at"],
                        item["last_connected_at"],
                        item["created_at"],
                        item["updated_at"],
                    ),
                )
            connection.commit()
        return self.list_sources()

    def update_source_runtime(
        self,
        source_id: int,
        *,
        status: str,
        status_detail: str = "",
        last_event_at: str | None = None,
        last_connected_at: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE monitoring_sources
                SET status = ?,
                    status_detail = ?,
                    last_event_at = COALESCE(?, last_event_at),
                    last_connected_at = COALESCE(?, last_connected_at),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    status,
                    status_detail,
                    last_event_at,
                    last_connected_at,
                    _now_iso(),
                    int(source_id),
                ),
            )
            connection.commit()

    def record_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        timestamp = _now_iso()
        raw_json = payload.get("raw_json")
        raw_text = raw_json if isinstance(raw_json, str) else json.dumps(raw_json or {}, ensure_ascii=False)
        insert_payload = {
            "source_id": int(payload["source_id"]),
            "source_name": str(payload["source_name"]),
            "source_host": str(payload["source_host"]),
            "source_port": int(payload["source_port"]),
            "event_id": str(payload["event_id"]),
            "stream_type": int(payload["stream_type"]),
            "occurred_at": str(payload["occurred_at"]),
            "stored_at": str(payload["stored_at"]),
            "occurred_unix_ms": int(payload["occurred_unix_ms"]),
            "severity": str(payload["severity"]),
            "event_type": str(payload["event_type"]),
            "title": str(payload["title"]),
            "description": str(payload["description"]),
            "message": str(payload["message"]),
            "hostname": str(payload["hostname"]),
            "interface_name": str(payload["interface_name"]),
            "comp_name": str(payload["comp_name"]),
            "hostname1": str(payload["hostname1"]),
            "hostname2": str(payload["hostname2"]),
            "device_id": str(payload["device_id"]),
            "device_id2": str(payload["device_id2"]),
            "l2_peer": str(payload.get("l2_peer", "") or ""),
            "is_l2_internal": 1 if payload.get("is_l2_internal") else 0,
            "maintenance_name": str(payload.get("maintenance_name", "") or ""),
            "overlay": 1 if payload.get("overlay") else 0,
            "status": str(payload["status"]),
            "acknowledged_at": str(payload.get("acknowledged_at", "") or ""),
            "bootstrap_suppressed": 1 if payload.get("bootstrap_suppressed") else 0,
            "cvp_link": str(payload["cvp_link"]),
            "raw_json": raw_text,
            "created_at": timestamp,
        }
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO monitoring_events (
                    source_id,
                    source_name,
                    source_host,
                    source_port,
                    event_id,
                    stream_type,
                    occurred_at,
                    stored_at,
                    occurred_unix_ms,
                    severity,
                    event_type,
                    title,
                    description,
                    message,
                    hostname,
                    interface_name,
                    comp_name,
                    hostname1,
                    hostname2,
                    device_id,
                    device_id2,
                    l2_peer,
                    is_l2_internal,
                    maintenance_name,
                    overlay,
                    status,
                    acknowledged_at,
                    bootstrap_suppressed,
                    cvp_link,
                    raw_json,
                    created_at
                )
                VALUES (
                    :source_id,
                    :source_name,
                    :source_host,
                    :source_port,
                    :event_id,
                    :stream_type,
                    :occurred_at,
                    :stored_at,
                    :occurred_unix_ms,
                    :severity,
                    :event_type,
                    :title,
                    :description,
                    :message,
                    :hostname,
                    :interface_name,
                    :comp_name,
                    :hostname1,
                    :hostname2,
                    :device_id,
                    :device_id2,
                    :l2_peer,
                    :is_l2_internal,
                    :maintenance_name,
                    :overlay,
                    :status,
                    :acknowledged_at,
                    :bootstrap_suppressed,
                    :cvp_link,
                    :raw_json,
                    :created_at
                )
                """,
                insert_payload,
            )
            inserted = int(cursor.rowcount or 0) > 0
            if inserted:
                event_row_id = int(cursor.lastrowid)
                acknowledged_at = str(payload.get("acknowledged_at", "") or "")
                bootstrap_suppressed = bool(payload.get("bootstrap_suppressed"))
            else:
                existing_row = connection.execute(
                    """
                    SELECT id, acknowledged_at, bootstrap_suppressed
                    FROM monitoring_events
                    WHERE source_id = ?
                      AND event_id = ?
                      AND stream_type = ?
                      AND occurred_at = ?
                    LIMIT 1
                    """,
                    (
                        int(payload["source_id"]),
                        str(payload["event_id"]),
                        int(payload["stream_type"]),
                        str(payload["occurred_at"]),
                    ),
                ).fetchone()
                event_row_id = int(existing_row["id"]) if existing_row else 0
                acknowledged_at = str(existing_row["acknowledged_at"] or "") if existing_row else ""
                bootstrap_suppressed = bool(existing_row["bootstrap_suppressed"]) if existing_row else False
            connection.commit()

        self.update_source_runtime(
            int(payload["source_id"]),
            status="connected",
            status_detail="streaming",
            last_event_at=str(payload["stored_at"]),
            last_connected_at=timestamp,
        )
        return {
            **payload,
            "id": event_row_id,
            "acknowledged_at": acknowledged_at,
            "bootstrap_suppressed": bootstrap_suppressed,
            "inserted": inserted,
        }

    def list_recent_events_by_source(self, limit_per_source: int = 8) -> dict[int, list[dict[str, Any]]]:
        limit = max(1, int(limit_per_source))
        live_cutoff_event_id = self.get_live_cutoff_event_id()
        with self._connect() as connection:
            rows = connection.execute(
                """
                WITH ranked AS (
                    SELECT
                        *,
                        ROW_NUMBER() OVER (
                            PARTITION BY source_id
                            ORDER BY datetime(stored_at) DESC, id DESC
                        ) AS row_num
                    FROM monitoring_events
                    WHERE id > ?
                )
                SELECT *
                FROM ranked
                WHERE row_num <= ?
                ORDER BY source_id ASC, datetime(stored_at) DESC, id DESC
                """,
                (live_cutoff_event_id, limit),
            ).fetchall()

        grouped: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(int(row["source_id"]), []).append(self._serialize_event(row))
        return grouped

    def acknowledge_source_alerts(self, source_id: int) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE monitoring_events
                SET acknowledged_at = ?
                WHERE source_id = ?
                  AND status = 'active'
                  AND overlay = 1
                  AND bootstrap_suppressed = 0
                  AND COALESCE(acknowledged_at, '') = ''
                """,
                (_now_iso(), int(source_id)),
            )
            connection.commit()
            return int(cursor.rowcount or 0)

    def clear_live_events(self) -> int:
        with self._connect() as connection:
            row = connection.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM monitoring_events").fetchone()
            cutoff_event_id = int(row["max_id"] or 0) if row else 0
            connection.execute(
                """
                INSERT INTO monitoring_runtime_state (state_key, state_value, updated_at)
                VALUES ('live_cutoff_event_id', ?, ?)
                ON CONFLICT(state_key) DO UPDATE
                SET state_value = excluded.state_value,
                    updated_at = excluded.updated_at
                """,
                (str(cutoff_event_id), _now_iso()),
            )
            connection.commit()
        return cutoff_event_id

    def get_live_cutoff_event_id(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT state_value
                FROM monitoring_runtime_state
                WHERE state_key = 'live_cutoff_event_id'
                """,
            ).fetchone()
        if not row:
            return 0
        try:
            return int(str(row["state_value"] or "0"))
        except (TypeError, ValueError):
            return 0

    def list_history(
        self,
        *,
        query: str = "",
        severity: str = "",
        start_date: str = "",
        end_date: str = "",
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        terms: list[Any] = []
        where_parts = ["1=1"]
        token = query.strip().lower()
        if token:
            like = f"%{token}%"
            where_parts.append(
                """
                (
                    LOWER(source_name) LIKE ?
                    OR LOWER(hostname) LIKE ?
                    OR LOWER(interface_name) LIKE ?
                    OR LOWER(event_type) LIKE ?
                    OR LOWER(title) LIKE ?
                    OR LOWER(message) LIKE ?
                )
                """
            )
            terms.extend([like, like, like, like, like, like])
        if severity.strip():
            where_parts.append("severity = ?")
            terms.append(severity.strip().lower())
        if start_date.strip():
            where_parts.append("date(stored_at) >= date(?)")
            terms.append(start_date.strip())
        if end_date.strip():
            where_parts.append("date(stored_at) <= date(?)")
            terms.append(end_date.strip())

        base_sql = f"""
            FROM monitoring_events
            WHERE {' AND '.join(where_parts)}
        """

        sql = f"""
            SELECT *
            {base_sql}
            ORDER BY datetime(stored_at) DESC, id DESC
            LIMIT ? OFFSET ?
        """
        paging_terms = [*terms, max(1, int(limit)), max(0, int(offset))]
        with self._connect() as connection:
            total_row = connection.execute(f"SELECT COUNT(*) AS total_count {base_sql}", tuple(terms)).fetchone()
            rows = connection.execute(sql, tuple(paging_terms)).fetchall()
        total_count = int(total_row["total_count"] or 0) if total_row else 0
        return [self._serialize_event(row) for row in rows], total_count

    def get_event(self, event_row_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM monitoring_events WHERE id = ?",
                (int(event_row_id),),
            ).fetchone()
        return self._serialize_event(row) if row else None

    def has_event_card_link(self, event_row_id: int) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT 1
                FROM monitoring_event_card_links
                WHERE monitoring_event_row_id = ?
                LIMIT 1
                """,
                (int(event_row_id),),
            ).fetchone()
        return bool(row)

    def link_event_card(self, event_row_id: int, kanban_card_id: int) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO monitoring_event_card_links (
                    monitoring_event_row_id,
                    kanban_card_id,
                    created_at
                ) VALUES (?, ?, ?)
                """,
                (int(event_row_id), int(kanban_card_id), _now_iso()),
            )
            connection.commit()

    def _normalize_source_payload(self, item: dict[str, Any], timestamp: str) -> dict[str, Any]:
        host = str(item.get("host", "")).strip()
        name = str(item.get("name", "")).strip() or (host or "MON-CVP")
        port_raw = item.get("port", 443)
        try:
            port = int(port_raw)
        except (TypeError, ValueError):
            port = 443
        enabled = 1 if bool(item.get("enabled", True)) and host else 0
        return {
            "name": name,
            "host": host,
            "port": port,
            "username": str(item.get("username", "") or "").strip(),
            "password": str(item.get("password", "") or ""),
            "enabled": enabled,
            "status": "paused" if not enabled else "connecting",
            "status_detail": "" if enabled else "disabled",
            "last_event_at": "",
            "last_connected_at": "",
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def _serialize_source(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "name": str(row["name"] or ""),
            "host": str(row["host"] or ""),
            "port": int(row["port"] or 443),
            "username": str(row["username"] or ""),
            "password": str(row["password"] or ""),
            "enabled": bool(row["enabled"]),
            "status": str(row["status"] or "paused"),
            "status_detail": str(row["status_detail"] or ""),
            "last_event_at": str(row["last_event_at"] or ""),
            "last_connected_at": str(row["last_connected_at"] or ""),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }

    def _serialize_event(self, row: sqlite3.Row) -> dict[str, Any]:
        raw_text = str(row["raw_json"] or "{}")
        try:
            raw_json = json.loads(raw_text)
        except Exception:
            raw_json = {"_raw": raw_text}

        return {
            "id": int(row["id"]),
            "source_id": int(row["source_id"]),
            "source_name": str(row["source_name"] or ""),
            "source_host": str(row["source_host"] or ""),
            "source_port": int(row["source_port"] or 443),
            "event_id": str(row["event_id"] or ""),
            "stream_type": int(row["stream_type"] or 0),
            "occurred_at": str(row["occurred_at"] or ""),
            "stored_at": str(row["stored_at"] or ""),
            "occurred_unix_ms": int(row["occurred_unix_ms"] or 0),
            "severity": str(row["severity"] or "info"),
            "event_type": str(row["event_type"] or ""),
            "title": str(row["title"] or ""),
            "description": str(row["description"] or ""),
            "message": str(row["message"] or ""),
            "hostname": str(row["hostname"] or ""),
            "interface_name": str(row["interface_name"] or ""),
            "comp_name": str(row["comp_name"] or ""),
            "hostname1": str(row["hostname1"] or ""),
            "hostname2": str(row["hostname2"] or ""),
            "device_id": str(row["device_id"] or ""),
            "device_id2": str(row["device_id2"] or ""),
            "l2_peer": str(row["l2_peer"] or ""),
            "is_l2_internal": bool(row["is_l2_internal"]),
            "maintenance_name": str(row["maintenance_name"] or ""),
            "overlay": bool(row["overlay"]),
            "status": str(row["status"] or "active"),
            "acknowledged_at": str(row["acknowledged_at"] or ""),
            "bootstrap_suppressed": bool(row["bootstrap_suppressed"]),
            "cvp_link": str(row["cvp_link"] or ""),
            "raw_json": raw_json,
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _ensure_column(connection: sqlite3.Connection, table_name: str, column_name: str, column_sql: str) -> None:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    if any(str(row["name"]) == column_name for row in rows):
        return
    connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")
