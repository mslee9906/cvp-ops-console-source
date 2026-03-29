from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    serial TEXT NOT NULL,
    mgmt_ip TEXT,
    model TEXT,
    site TEXT,
    tags_json TEXT NOT NULL,
    last_collected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bgp_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vrf TEXT NOT NULL,
    asn TEXT NOT NULL,
    router_id TEXT,
    shutdown INTEGER NOT NULL DEFAULT 0,
    source_path TEXT,
    FOREIGN KEY(device_id) REFERENCES devices(device_id)
);

CREATE TABLE IF NOT EXISTS vrfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vrf_name TEXT NOT NULL,
    vrf_id TEXT,
    FOREIGN KEY(device_id) REFERENCES devices(device_id)
);

CREATE TABLE IF NOT EXISTS vlans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vlan_id TEXT NOT NULL,
    vlan_name TEXT NOT NULL,
    svi_name TEXT,
    description TEXT,
    source_path TEXT,
    FOREIGN KEY(device_id) REFERENCES devices(device_id)
);

CREATE TABLE IF NOT EXISTS ip_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    interface_name TEXT NOT NULL,
    ip TEXT NOT NULL,
    address TEXT NOT NULL,
    prefix_length INTEGER NOT NULL,
    network TEXT NOT NULL,
    vrf TEXT NOT NULL,
    ip_kind TEXT NOT NULL,
    source TEXT NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices(device_id)
);

CREATE TABLE IF NOT EXISTS config_snapshots (
    device_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    file_path TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    line_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    error_message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices(hostname);
CREATE INDEX IF NOT EXISTS idx_bgp_entries_asn ON bgp_entries(asn);
CREATE INDEX IF NOT EXISTS idx_bgp_entries_hostname ON bgp_entries(hostname);
CREATE INDEX IF NOT EXISTS idx_vrfs_name ON vrfs(vrf_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vlans_vlan_id ON vlans(vlan_id);
CREATE INDEX IF NOT EXISTS idx_vlans_vlan_name ON vlans(vlan_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ip_records_address ON ip_records(address);
CREATE INDEX IF NOT EXISTS idx_ip_records_vrf ON ip_records(vrf COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ip_records_hostname ON ip_records(hostname);
"""


class SnapshotRepository:
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

    def is_empty(self) -> bool:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM devices").fetchone()
        return bool(row["count"] == 0)

    def replace_snapshot(
        self,
        snapshot: dict[str, Any],
        config_metadata: list[dict[str, Any]],
        latest_job: dict[str, str],
    ) -> None:
        with self._connect() as connection:
            cursor = connection.cursor()
            cursor.executescript(
                """
                DELETE FROM bgp_entries;
                DELETE FROM vrfs;
                DELETE FROM vlans;
                DELETE FROM ip_records;
                DELETE FROM devices;
                DELETE FROM config_snapshots;
                """,
            )

            cursor.executemany(
                """
                INSERT INTO devices (
                    device_id, hostname, serial, mgmt_ip, model, site, tags_json, last_collected_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        item.get("serial", item["device_id"]),
                        item.get("mgmt_ip", ""),
                        item.get("model", ""),
                        item.get("site", ""),
                        json.dumps(item.get("tags", []), ensure_ascii=False),
                        item["last_collected_at"],
                    )
                    for item in snapshot.get("devices", [])
                ],
            )

            cursor.executemany(
                """
                INSERT INTO bgp_entries (
                    device_id, hostname, vrf, asn, router_id, shutdown, source_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        item.get("vrf", "default"),
                        item["asn"],
                        item.get("router_id", ""),
                        1 if item.get("shutdown", False) else 0,
                        item.get("source_path", ""),
                    )
                    for item in snapshot.get("bgp", [])
                ],
            )

            cursor.executemany(
                """
                INSERT INTO vrfs (device_id, hostname, vrf_name, vrf_id)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        item["vrf_name"],
                        item.get("vrf_id", ""),
                    )
                    for item in snapshot.get("vrfs", [])
                ],
            )

            cursor.executemany(
                """
                INSERT INTO vlans (
                    device_id, hostname, vlan_id, vlan_name, svi_name, description, source_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        str(item["vlan_id"]),
                        item.get("vlan_name", "X"),
                        item.get("svi_name", ""),
                        item.get("description", ""),
                        item.get("source_path", ""),
                    )
                    for item in snapshot.get("vlans", [])
                ],
            )

            cursor.executemany(
                """
                INSERT INTO ip_records (
                    device_id, hostname, interface_name, ip, address, prefix_length, network, vrf, ip_kind, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        item["interface_name"],
                        item["ip"],
                        item["address"],
                        int(item["prefix_length"]),
                        item["network"],
                        item.get("vrf", "default"),
                        item.get("ip_kind", "interface"),
                        item.get("source", "config"),
                    )
                    for item in snapshot.get("ip_records", [])
                ],
            )

            cursor.executemany(
                """
                INSERT INTO config_snapshots (
                    device_id, hostname, config_hash, file_path, collected_at, line_count
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["device_id"],
                        item["hostname"],
                        item["config_hash"],
                        item["file_path"],
                        item["collected_at"],
                        int(item["line_count"]),
                    )
                    for item in config_metadata
                ],
            )

            cursor.execute(
                """
                INSERT INTO collection_jobs (job_name, source, status, start_time, end_time, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    latest_job["job_name"],
                    latest_job["source"],
                    latest_job["status"],
                    latest_job["start_time"],
                    latest_job["end_time"],
                    latest_job.get("error_message", ""),
                ),
            )
            connection.commit()

    def record_job(self, latest_job: dict[str, str]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO collection_jobs (job_name, source, status, start_time, end_time, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    latest_job["job_name"],
                    latest_job["source"],
                    latest_job["status"],
                    latest_job["start_time"],
                    latest_job["end_time"],
                    latest_job.get("error_message", ""),
                ),
            )
            connection.commit()

    def get_overview(self) -> dict[str, Any]:
        with self._connect() as connection:
            counts = {
                "device_count": connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0],
                "ip_count": connection.execute("SELECT COUNT(*) FROM ip_records").fetchone()[0],
                "bgp_count": connection.execute("SELECT COUNT(*) FROM bgp_entries").fetchone()[0],
                "vlan_count": connection.execute("SELECT COUNT(*) FROM vlans").fetchone()[0],
                "vrf_count": connection.execute("SELECT COUNT(*) FROM vrfs").fetchone()[0],
                "config_snapshot_count": connection.execute(
                    "SELECT COUNT(*) FROM config_snapshots",
                ).fetchone()[0],
            }
            latest_job = connection.execute(
                """
                SELECT job_name, source, status, start_time, end_time, error_message
                FROM collection_jobs
                ORDER BY id DESC
                LIMIT 1
                """,
            ).fetchone()
        return {
            **counts,
            "latest_job": dict(latest_job) if latest_job else None,
            "latest_collection_at": latest_job["end_time"] if latest_job else None,
        }

    def list_devices(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    d.device_id,
                    d.hostname,
                    d.serial,
                    d.mgmt_ip,
                    d.model,
                    d.site,
                    d.tags_json,
                    d.last_collected_at,
                    c.config_hash,
                    c.collected_at AS config_collected_at
                FROM devices AS d
                LEFT JOIN config_snapshots AS c ON c.device_id = d.device_id
                ORDER BY d.hostname
                """,
            ).fetchall()
        devices = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json"))
            devices.append(item)
        return devices

    def get_device_config(self, device_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT device_id, hostname, config_hash, file_path, collected_at, line_count
                FROM config_snapshots
                WHERE device_id = ?
                """,
                (device_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_bgp_entries(self, asn: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf, asn, router_id, shutdown, source_path
                FROM bgp_entries
                WHERE asn = ?
                ORDER BY hostname, vrf
                """,
                (asn,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_bgp_entries(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf, asn, router_id, shutdown, source_path
                FROM bgp_entries
                ORDER BY hostname, vrf
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_vrf_entries(self, vrf_name: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf_name, vrf_id
                FROM vrfs
                WHERE vrf_name = ? COLLATE NOCASE
                ORDER BY hostname
                """,
                (vrf_name,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_vrf_entries(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf_name, vrf_id
                FROM vrfs
                ORDER BY hostname, vrf_name
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_vlan_entries(
        self,
        vlan_id: str | None = None,
        vlan_name: str | None = None,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT device_id, hostname, vlan_id, vlan_name, svi_name, description, source_path
            FROM vlans
            WHERE 1 = 1
        """
        params: list[str] = []
        if vlan_id:
            query += " AND vlan_id = ?"
            params.append(vlan_id)
        if vlan_name:
            query += " AND vlan_name = ? COLLATE NOCASE"
            params.append(vlan_name)
        query += " ORDER BY hostname, vlan_id"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_ip_records(self, vrf: str | None = None) -> list[dict[str, Any]]:
        query = """
            SELECT
                device_id,
                hostname,
                interface_name,
                ip,
                address,
                prefix_length,
                network,
                vrf,
                ip_kind,
                source
            FROM ip_records
            WHERE 1 = 1
        """
        params: list[str] = []
        if vrf:
            query += " AND vrf = ? COLLATE NOCASE"
            params.append(vrf)
        query += " ORDER BY hostname, interface_name, ip"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]
