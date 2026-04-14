from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS winscp_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    winscp_path TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'sftp',
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL DEFAULT '',
    password_encrypted TEXT NOT NULL DEFAULT '',
    remote_path TEXT NOT NULL DEFAULT '',
    host_key TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_winscp_profiles_default ON winscp_profiles(is_default, enabled, id);
"""


class WinScpProfileRepository:
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

    def list_profiles(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    name,
                    winscp_path,
                    protocol,
                    host,
                    port,
                    username,
                    password_encrypted,
                    remote_path,
                    host_key,
                    enabled,
                    is_default,
                    created_at,
                    updated_at
                FROM winscp_profiles
                ORDER BY is_default DESC, enabled DESC, id ASC
                """,
            ).fetchall()
        return [self._serialize_profile(row) for row in rows]

    def replace_profiles(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        timestamp = _now_iso()
        normalized = [
            self._normalize_profile_payload(item, timestamp)
            for item in items
            if str(item.get("name") or "").strip() and str(item.get("host") or "").strip()
        ]

        default_assigned = False
        for item in normalized:
            if item["is_default"] and not default_assigned:
                default_assigned = True
            else:
                item["is_default"] = False
        if normalized and not default_assigned:
            normalized[0]["is_default"] = True

        with self._connect() as connection:
            connection.execute("DELETE FROM winscp_profiles")
            for item in normalized:
                connection.execute(
                    """
                    INSERT INTO winscp_profiles (
                        name,
                        winscp_path,
                        protocol,
                        host,
                        port,
                        username,
                        password_encrypted,
                        remote_path,
                        host_key,
                        enabled,
                        is_default,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item["name"],
                        item["winscp_path"],
                        item["protocol"],
                        item["host"],
                        item["port"],
                        item["username"],
                        item["password_encrypted"],
                        item["remote_path"],
                        item["host_key"],
                        item["enabled"],
                        item["is_default"],
                        item["created_at"],
                        item["updated_at"],
                    ),
                )
            connection.commit()

        return self.list_profiles()

    def _normalize_profile_payload(self, item: dict[str, Any], timestamp: str) -> dict[str, Any]:
        return {
            "name": str(item.get("name") or "").strip(),
            "winscp_path": str(item.get("winscp_path") or "").strip(),
            "protocol": str(item.get("protocol") or "sftp").strip().lower() or "sftp",
            "host": str(item.get("host") or "").strip(),
            "port": max(1, int(item.get("port") or 22)),
            "username": str(item.get("username") or "").strip(),
            "password_encrypted": str(item.get("password_encrypted") or ""),
            "remote_path": str(item.get("remote_path") or "").strip(),
            "host_key": str(item.get("host_key") or "").strip(),
            "enabled": 1 if bool(item.get("enabled", True)) else 0,
            "is_default": 1 if bool(item.get("is_default", False)) else 0,
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def _serialize_profile(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "name": str(row["name"] or ""),
            "winscp_path": str(row["winscp_path"] or ""),
            "protocol": str(row["protocol"] or "sftp"),
            "host": str(row["host"] or ""),
            "port": int(row["port"] or 22),
            "username": str(row["username"] or ""),
            "password_encrypted": str(row["password_encrypted"] or ""),
            "remote_path": str(row["remote_path"] or ""),
            "host_key": str(row["host_key"] or ""),
            "enabled": bool(row["enabled"]),
            "is_default": bool(row["is_default"]),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
