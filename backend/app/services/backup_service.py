from __future__ import annotations

from datetime import datetime, timezone
import shutil
from pathlib import Path
from typing import Any


class BackupService:
    def __init__(
        self,
        *,
        console_dir: Path,
        backend_dir: Path,
        primary_db_path: Path,
        history_db_path: Path,
        monitoring_db_path: Path,
        config_snapshot_dir: Path,
    ) -> None:
        self.console_dir = Path(console_dir)
        self.backend_dir = Path(backend_dir)
        self.primary_db_path = Path(primary_db_path)
        self.history_db_path = Path(history_db_path)
        self.monitoring_db_path = Path(monitoring_db_path)
        self.config_snapshot_dir = Path(config_snapshot_dir)
        self.backup_root = self.backend_dir / "data" / "backups"

    def list_backups(self) -> list[dict[str, Any]]:
        self.backup_root.mkdir(parents=True, exist_ok=True)
        items: list[dict[str, Any]] = []
        for folder in sorted(self.backup_root.iterdir(), reverse=True):
            if not folder.is_dir():
                continue
            items.append(
                {
                    "name": folder.name,
                    "path": str(folder),
                    "created_at": self._format_timestamp(folder.name),
                }
            )
        return items

    def create_backup(self) -> dict[str, Any]:
        timestamp = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
        destination = self.backup_root / timestamp
        destination.mkdir(parents=True, exist_ok=True)

        self._copy_if_exists(self.primary_db_path, destination / "db" / self.primary_db_path.name)
        self._copy_if_exists(self.history_db_path, destination / "db" / self.history_db_path.name)
        self._copy_if_exists(self.monitoring_db_path, destination / "db" / self.monitoring_db_path.name)
        self._copy_dir_if_exists(self.config_snapshot_dir, destination / "configs")
        self._copy_dir_if_exists(self.backend_dir / "config", destination / "backend-config")
        self._copy_if_exists(self.backend_dir / ".env", destination / ".env")
        self._copy_if_exists(self.backend_dir / ".env.example", destination / ".env.example")

        manifest = {
            "name": timestamp,
            "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "files": sorted(
                str(path.relative_to(destination))
                for path in destination.rglob("*")
                if path.is_file()
            ),
        }
        (destination / "manifest.json").write_text(self._json_dump(manifest), encoding="utf-8")
        return {
            "name": timestamp,
            "path": str(destination),
            "created_at": manifest["created_at"],
            "files": manifest["files"],
        }

    def restore_backup(self, backup_name: str) -> dict[str, Any]:
        source = self.backup_root / backup_name
        if not source.exists() or not source.is_dir():
            raise FileNotFoundError("Backup not found")

        self._copy_if_exists(source / "db" / self.primary_db_path.name, self.primary_db_path)
        self._copy_if_exists(source / "db" / self.history_db_path.name, self.history_db_path)
        self._copy_if_exists(source / "db" / self.monitoring_db_path.name, self.monitoring_db_path)
        self._replace_dir(source / "configs", self.config_snapshot_dir)
        self._replace_dir(source / "backend-config", self.backend_dir / "config")
        self._copy_if_exists(source / ".env", self.backend_dir / ".env")
        self._copy_if_exists(source / ".env.example", self.backend_dir / ".env.example")
        return {
            "name": backup_name,
            "restored_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        }

    def _copy_if_exists(self, source: Path, destination: Path) -> None:
        if not source.exists():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    def _copy_dir_if_exists(self, source: Path, destination: Path) -> None:
        if not source.exists():
            return
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination)

    def _replace_dir(self, source: Path, destination: Path) -> None:
        if not source.exists():
            return
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination)

    def _format_timestamp(self, raw: str) -> str:
        if len(raw) != 15 or "-" not in raw:
            return raw
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]} {raw[9:11]}:{raw[11:13]}:{raw[13:15]}"

    def _json_dump(self, payload: dict[str, Any]) -> str:
        import json

        return json.dumps(payload, ensure_ascii=False, indent=2)
