from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any


class ConfigFileManager:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = Path(root_dir)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def persist(self, configs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        metadata: list[dict[str, Any]] = []
        for item in configs:
            device_id = item["device_id"]
            hostname = item["hostname"]
            collected_at = item["collected_at"]
            config_text = item["config_text"]
            config_hash = sha256(config_text.encode("utf-8")).hexdigest()
            line_count = len(config_text.splitlines())

            device_dir = self.root_dir / device_id
            device_dir.mkdir(parents=True, exist_ok=True)

            safe_timestamp = collected_at.replace(":", "-")
            archive_path = device_dir / f"{safe_timestamp}_{config_hash[:10]}.cfg"
            latest_path = device_dir / "latest.cfg"

            if not archive_path.exists():
                archive_path.write_text(config_text, encoding="utf-8")
            latest_path.write_text(config_text, encoding="utf-8")

            metadata.append(
                {
                    "device_id": device_id,
                    "hostname": hostname,
                    "config_hash": config_hash,
                    "file_path": str(latest_path),
                    "collected_at": collected_at,
                    "line_count": line_count,
                },
            )
        return metadata
