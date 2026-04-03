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

CREATE TABLE IF NOT EXISTS vni_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vlan_id TEXT NOT NULL,
    vni TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS devices_raw (
    raw_device_key TEXT PRIMARY KEY,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    serial TEXT NOT NULL,
    mgmt_ip TEXT,
    model TEXT,
    site TEXT,
    tags_json TEXT NOT NULL,
    last_collected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bgp_entries_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_device_key TEXT NOT NULL,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vrf TEXT NOT NULL,
    asn TEXT NOT NULL,
    router_id TEXT,
    shutdown INTEGER NOT NULL DEFAULT 0,
    source_path TEXT
);

CREATE TABLE IF NOT EXISTS vrfs_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_device_key TEXT NOT NULL,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vrf_name TEXT NOT NULL,
    vrf_id TEXT
);

CREATE TABLE IF NOT EXISTS vlans_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_device_key TEXT NOT NULL,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vlan_id TEXT NOT NULL,
    vlan_name TEXT NOT NULL,
    svi_name TEXT,
    description TEXT,
    source_path TEXT
);

CREATE TABLE IF NOT EXISTS vni_entries_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_device_key TEXT NOT NULL,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    vlan_id TEXT NOT NULL,
    vni TEXT NOT NULL,
    source_path TEXT
);

CREATE TABLE IF NOT EXISTS ip_records_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_device_key TEXT NOT NULL,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    interface_name TEXT NOT NULL,
    ip TEXT NOT NULL,
    address TEXT NOT NULL,
    prefix_length INTEGER NOT NULL,
    network TEXT NOT NULL,
    vrf TEXT NOT NULL,
    ip_kind TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_snapshots_raw (
    raw_device_key TEXT PRIMARY KEY,
    cvp_source TEXT NOT NULL,
    device_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_vni_entries_vni ON vni_entries(vni);
CREATE INDEX IF NOT EXISTS idx_vni_entries_vlan_id ON vni_entries(vlan_id);
CREATE INDEX IF NOT EXISTS idx_ip_records_address ON ip_records(address);
CREATE INDEX IF NOT EXISTS idx_ip_records_vrf ON ip_records(vrf COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ip_records_hostname ON ip_records(hostname);
CREATE INDEX IF NOT EXISTS idx_devices_raw_source ON devices_raw(cvp_source);
CREATE INDEX IF NOT EXISTS idx_devices_raw_serial ON devices_raw(serial);
CREATE INDEX IF NOT EXISTS idx_devices_raw_mgmt_ip ON devices_raw(mgmt_ip);
CREATE INDEX IF NOT EXISTS idx_bgp_entries_raw_asn ON bgp_entries_raw(asn);
CREATE INDEX IF NOT EXISTS idx_vrfs_raw_name ON vrfs_raw(vrf_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vlans_raw_vlan_id ON vlans_raw(vlan_id);
CREATE INDEX IF NOT EXISTS idx_vni_entries_raw_vni ON vni_entries_raw(vni);
CREATE INDEX IF NOT EXISTS idx_ip_records_raw_address ON ip_records_raw(address);
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
        normalized_snapshot = self._normalize_snapshot(snapshot)
        normalized_metadata = [self._normalize_config_metadata(item) for item in config_metadata]
        merged_snapshot, merged_metadata = self._build_merged_snapshot(normalized_snapshot, normalized_metadata)

        with self._connect() as connection:
            cursor = connection.cursor()
            self._clear_snapshot_tables(cursor)
            self._insert_raw_snapshot(cursor, normalized_snapshot, normalized_metadata)
            self._insert_merged_snapshot(cursor, merged_snapshot, merged_metadata)
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
                "vni_count": connection.execute("SELECT COUNT(*) FROM vni_entries").fetchone()[0],
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

    def list_raw_sources(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    cvp_source,
                    COUNT(*) AS raw_device_count,
                    MAX(last_collected_at) AS latest_collected_at
                FROM devices_raw
                GROUP BY cvp_source
                ORDER BY cvp_source
                """,
            ).fetchall()
        return [dict(row) for row in rows]

    def list_raw_devices(self, source_name: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    d.raw_device_key,
                    d.cvp_source,
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
                FROM devices_raw AS d
                LEFT JOIN config_snapshots_raw AS c
                    ON c.raw_device_key = d.raw_device_key
                WHERE d.cvp_source = ?
                ORDER BY d.hostname, d.device_id
                """,
                (source_name,),
            ).fetchall()
        devices = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json"))
            item["has_config"] = bool(item.get("config_hash"))
            devices.append(item)
        return devices

    def get_raw_device_config(self, source_name: str, device_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    cvp_source,
                    device_id,
                    hostname,
                    config_hash,
                    file_path,
                    collected_at,
                    line_count
                FROM config_snapshots_raw
                WHERE cvp_source = ? AND device_id = ?
                """,
                (source_name, device_id),
            ).fetchone()
        return dict(row) if row else None

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

    def get_device(self, device_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT device_id, hostname, serial, mgmt_ip, model, site, tags_json, last_collected_at
                FROM devices
                WHERE device_id = ?
                """,
                (device_id,),
            ).fetchone()
        if not row:
            return None
        item = dict(row)
        item["tags"] = json.loads(item.pop("tags_json"))
        return item

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

    def list_bgp_entries(self, limit: int | None = 200) -> list[dict[str, Any]]:
        query = """
            SELECT device_id, hostname, vrf, asn, router_id, shutdown, source_path
            FROM bgp_entries
            ORDER BY hostname, vrf
        """
        params: tuple[Any, ...] = ()
        if limit is not None:
            query += " LIMIT ?"
            params = (limit,)
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_bgp_entries_for_device(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf, asn, router_id, shutdown, source_path
                FROM bgp_entries
                WHERE device_id = ?
                ORDER BY vrf, asn
                """,
                (device_id,),
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

    def list_vrf_entries(self, limit: int | None = 200) -> list[dict[str, Any]]:
        query = """
            SELECT device_id, hostname, vrf_name, vrf_id
            FROM vrfs
            ORDER BY hostname, vrf_name
        """
        params: tuple[Any, ...] = ()
        if limit is not None:
            query += " LIMIT ?"
            params = (limit,)
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_vrf_entries_for_device(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vrf_name, vrf_id
                FROM vrfs
                WHERE device_id = ?
                ORDER BY vrf_name
                """,
                (device_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_config_snapshots(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT c.device_id, c.hostname, c.config_hash, c.file_path, c.collected_at, c.line_count, d.mgmt_ip
                FROM config_snapshots AS c
                LEFT JOIN devices AS d ON d.device_id = c.device_id
                ORDER BY c.hostname
                """,
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

    def get_vlan_entries_for_device(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vlan_id, vlan_name, svi_name, description, source_path
                FROM vlans
                WHERE device_id = ?
                ORDER BY vlan_id
                """,
                (device_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_vni_entries(
        self,
        vni: str | None = None,
        vlan_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT device_id, hostname, vlan_id, vni, source_path
            FROM vni_entries
            WHERE 1 = 1
        """
        params: list[Any] = []
        if vni:
            query += " AND vni = ?"
            params.append(vni)
        if vlan_id:
            query += " AND vlan_id = ?"
            params.append(vlan_id)
        query += " ORDER BY vni, hostname, vlan_id"
        if limit is not None:
            query += " LIMIT ?"
            params.append(limit)
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_vni_entries_for_device(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT device_id, hostname, vlan_id, vni, source_path
                FROM vni_entries
                WHERE device_id = ?
                ORDER BY vni, vlan_id
                """,
                (device_id,),
            ).fetchall()
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

    def get_ip_records_for_device(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
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
                WHERE device_id = ?
                ORDER BY interface_name, ip
                """,
                (device_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _clear_snapshot_tables(self, cursor: sqlite3.Cursor) -> None:
        cursor.executescript(
            """
            DELETE FROM bgp_entries;
            DELETE FROM vrfs;
            DELETE FROM vlans;
            DELETE FROM vni_entries;
            DELETE FROM ip_records;
            DELETE FROM devices;
            DELETE FROM config_snapshots;
            DELETE FROM bgp_entries_raw;
            DELETE FROM vrfs_raw;
            DELETE FROM vlans_raw;
            DELETE FROM vni_entries_raw;
            DELETE FROM ip_records_raw;
            DELETE FROM devices_raw;
            DELETE FROM config_snapshots_raw;
            """,
        )

    def _insert_raw_snapshot(
        self,
        cursor: sqlite3.Cursor,
        snapshot: dict[str, Any],
        config_metadata: list[dict[str, Any]],
    ) -> None:
        cursor.executemany(
            """
            INSERT INTO devices_raw (
                raw_device_key, cvp_source, device_id, hostname, serial, mgmt_ip, model, site, tags_json, last_collected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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
            INSERT INTO bgp_entries_raw (
                raw_device_key, cvp_source, device_id, hostname, vrf, asn, router_id, shutdown, source_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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
            INSERT INTO vrfs_raw (raw_device_key, cvp_source, device_id, hostname, vrf_name, vrf_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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
            INSERT INTO vlans_raw (
                raw_device_key, cvp_source, device_id, hostname, vlan_id, vlan_name, svi_name, description, source_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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
            INSERT INTO vni_entries_raw (
                raw_device_key, cvp_source, device_id, hostname, vlan_id, vni, source_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
                    item["device_id"],
                    item["hostname"],
                    str(item["vlan_id"]),
                    str(item["vni"]),
                    item.get("source_path", ""),
                )
                for item in snapshot.get("vnis", [])
            ],
        )

        cursor.executemany(
            """
            INSERT INTO ip_records_raw (
                raw_device_key, cvp_source, device_id, hostname, interface_name, ip, address, prefix_length, network, vrf, ip_kind, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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
            INSERT INTO config_snapshots_raw (
                raw_device_key, cvp_source, device_id, hostname, config_hash, file_path, collected_at, line_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    self._raw_device_key(item["cvp_source"], item["device_id"]),
                    item["cvp_source"],
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

    def _insert_merged_snapshot(
        self,
        cursor: sqlite3.Cursor,
        snapshot: dict[str, Any],
        config_metadata: list[dict[str, Any]],
    ) -> None:
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
            INSERT INTO vni_entries (
                device_id, hostname, vlan_id, vni, source_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    item["device_id"],
                    item["hostname"],
                    str(item["vlan_id"]),
                    str(item["vni"]),
                    item.get("source_path", ""),
                )
                for item in snapshot.get("vnis", [])
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

    def _build_merged_snapshot(
        self,
        snapshot: dict[str, Any],
        config_metadata: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        source_order: dict[str, int] = {}
        for item in snapshot.get("devices", []):
            source = item["cvp_source"]
            if source not in source_order:
                source_order[source] = len(source_order)

        grouped_devices: dict[str, list[dict[str, Any]]] = {}
        for item in snapshot.get("devices", []):
            grouped_devices.setdefault(self._device_merge_key(item), []).append(item)

        representative_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for group in grouped_devices.values():
            representative = min(group, key=lambda item: self._device_sort_key(item, source_order))
            representative_rows.append((representative, group))
        representative_rows.sort(key=lambda item: self._device_sort_key(item[0], source_order))

        used_merged_ids: set[str] = set()
        raw_to_merged: dict[str, str] = {}
        representative_devices: dict[str, dict[str, Any]] = {}
        merged_devices: list[dict[str, Any]] = []

        for representative, _group in representative_rows:
            raw_key = self._raw_device_key(representative["cvp_source"], representative["device_id"])
            merged_id = str(representative["device_id"]).strip() or raw_key
            if merged_id in used_merged_ids:
                merged_id = raw_key
            used_merged_ids.add(merged_id)
            raw_to_merged[raw_key] = merged_id
            representative_devices[raw_key] = representative
            merged_devices.append(
                {
                    "device_id": merged_id,
                    "hostname": representative["hostname"],
                    "serial": representative.get("serial", representative["device_id"]),
                    "mgmt_ip": representative.get("mgmt_ip", ""),
                    "model": representative.get("model", ""),
                    "site": representative.get("site", ""),
                    "tags": list(representative.get("tags", [])),
                    "last_collected_at": representative["last_collected_at"],
                }
            )

        def merge_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            merged_rows: list[dict[str, Any]] = []
            for item in rows:
                raw_key = self._raw_device_key(item["cvp_source"], item["device_id"])
                merged_id = raw_to_merged.get(raw_key)
                if not merged_id:
                    continue
                representative = representative_devices[raw_key]
                merged_item = dict(item)
                merged_item["device_id"] = merged_id
                merged_item["hostname"] = representative["hostname"]
                merged_item.pop("cvp_source", None)
                merged_rows.append(merged_item)
            return merged_rows

        merged_metadata: list[dict[str, Any]] = []
        for item in config_metadata:
            raw_key = self._raw_device_key(item["cvp_source"], item["device_id"])
            merged_id = raw_to_merged.get(raw_key)
            if not merged_id:
                continue
            representative = representative_devices[raw_key]
            merged_metadata.append(
                {
                    "device_id": merged_id,
                    "hostname": representative["hostname"],
                    "config_hash": item["config_hash"],
                    "file_path": item["file_path"],
                    "collected_at": item["collected_at"],
                    "line_count": item["line_count"],
                }
            )

        merged_snapshot = {
            "devices": merged_devices,
            "bgp": merge_rows(snapshot.get("bgp", [])),
            "vrfs": merge_rows(snapshot.get("vrfs", [])),
            "vlans": merge_rows(snapshot.get("vlans", [])),
            "vnis": merge_rows(snapshot.get("vnis", [])),
            "ip_records": merge_rows(snapshot.get("ip_records", [])),
            "configs": [],
        }
        return merged_snapshot, merged_metadata

    def _normalize_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        normalized = {
            "devices": [],
            "bgp": [],
            "vrfs": [],
            "vlans": [],
            "vnis": [],
            "ip_records": [],
            "configs": [],
        }
        for key in normalized:
            for item in snapshot.get(key, []):
                normalized[key].append(self._normalize_snapshot_item(item))
        return normalized

    def _normalize_snapshot_item(self, item: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(item)
        normalized["cvp_source"] = self._normalize_source(item.get("cvp_source"))
        return normalized

    def _normalize_config_metadata(self, item: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(item)
        normalized["cvp_source"] = self._normalize_source(item.get("cvp_source"))
        return normalized

    def _normalize_source(self, raw_source: Any) -> str:
        source = str(raw_source or "default").strip()
        return source or "default"

    def _device_merge_key(self, item: dict[str, Any]) -> str:
        serial = str(item.get("serial", "") or "").strip().lower()
        if serial:
            return f"serial:{serial}"
        mgmt_ip = str(item.get("mgmt_ip", "") or "").strip().lower()
        if mgmt_ip:
            return f"mgmt:{mgmt_ip}"
        return f"raw:{self._raw_device_key(item['cvp_source'], item['device_id'])}"

    def _device_sort_key(self, item: dict[str, Any], source_order: dict[str, int]) -> tuple[int, str, str]:
        return (
            source_order.get(item["cvp_source"], 9999),
            str(item.get("hostname", "") or "").lower(),
            str(item.get("device_id", "") or "").lower(),
        )

    def _raw_device_key(self, cvp_source: str, device_id: str) -> str:
        return f"{self._normalize_source(cvp_source)}::{str(device_id).strip()}"
