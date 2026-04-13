from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import os
import re


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _read_csv(name: str) -> list[str]:
    raw = os.getenv(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _read_mapping(name: str, default: dict[str, str] | None = None) -> dict[str, str]:
    mapping = dict(default or {})
    raw = os.getenv(name, "").strip()
    if not raw:
        return mapping
    for item in re.split(r"[,\n;]+", raw):
        key, separator, value = item.partition("=")
        if not separator:
            continue
        normalized_key = key.strip()
        normalized_value = value.strip()
        if normalized_key and normalized_value:
            mapping[normalized_key] = normalized_value
    return mapping


def _read_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return int(raw.strip())


def _prefer_existing_path(*candidates: Path) -> Path:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _split_host_port(raw_host: str, default_port: int) -> tuple[str, int]:
    host = raw_host.strip()
    if not host:
        return "", default_port
    if ":" in host and host.count(":") == 1:
        name, _, port = host.partition(":")
        if port.isdigit():
            return name.strip(), int(port)
    return host, default_port


LEGACY_WORKPLAN_SNAPSHOT_MAP = {
    "10.172.152.33": "87f82434-86ec-4b32-97a4-1a35cb28fed5",
    "10.172.152.36": "ac29deb8-7758-4631-aad5-3f85364b2163",
    "10.172.64.252": "6cef45c4-97e2-4454-83be-c7943b9d350f",
}


@dataclass(frozen=True)
class CVPSourceEndpoint:
    name: str
    host: str
    port: int


@dataclass(frozen=True)
class Settings:
    backend_dir: Path
    console_dir: Path
    project_root: Path
    db_path: Path
    config_dir: Path
    workplan_template_path: Path
    workplan_snapshot_template_map: dict[str, str]
    workplan_snapshot_template_default: str
    sample_snapshot_path: Path
    telemetry_paths_path: Path
    field_mapping_path: Path
    cvp_library_root: Path
    monitoring_app_root: Path
    use_mock_data: bool
    cvp_hosts: list[str]
    cvp_port: int
    cvp_token: str
    cvp_username: str
    cvp_password: str
    cvp_ca_file: str
    cvp_cert_file: str
    cvp_key_file: str
    cvp_insecure_tls: bool
    cvp_device_ids: list[str]
    cors_origins: list[str]
    auth_session_hours: int
    default_admin_username: str
    default_admin_password: str
    default_admin_display_name: str

    @property
    def has_cvp_credentials(self) -> bool:
        return bool(self.cvp_sources and (self.cvp_token or (self.cvp_username and self.cvp_password)))

    @property
    def cvp_sources(self) -> list[CVPSourceEndpoint]:
        sources: list[CVPSourceEndpoint] = []
        for raw_host in self.cvp_hosts:
            hostname, port = _split_host_port(raw_host, self.cvp_port)
            if not hostname:
                continue
            sources.append(
                CVPSourceEndpoint(
                    name=f"{hostname}:{port}",
                    host=hostname,
                    port=port,
                )
            )
        return sources

    @property
    def cvp_hostname(self) -> str:
        return self.cvp_sources[0].host if self.cvp_sources else ""

    @property
    def cvp_resolved_port(self) -> int:
        return self.cvp_sources[0].port if self.cvp_sources else self.cvp_port

    @property
    def cvp_target(self) -> str:
        return f"{self.cvp_hostname}:{self.cvp_resolved_port}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    backend_dir = Path(__file__).resolve().parents[2]
    console_dir = backend_dir.parent
    project_root = console_dir.parent
    default_cvp_library_root = _prefer_existing_path(
        console_dir / "cloudvision-python-trunk",
        project_root / "cloudvision-python-trunk",
    )
    default_monitoring_app_root = _prefer_existing_path(
        console_dir / "monitoring-runtime" / "app",
        project_root / "CVP_Monitoring" / "app",
    )

    db_path = Path(os.getenv("OPS_CONSOLE_DB_PATH", backend_dir / "data" / "db" / "ops_console.db"))
    config_dir = Path(os.getenv("OPS_CONSOLE_CONFIG_DIR", backend_dir / "data" / "configs"))
    workplan_template_path = Path(
        os.getenv("OPS_CONSOLE_WORKPLAN_TEMPLATE", backend_dir / "data" / "workplan_template.xlsx"),
    )
    sample_snapshot_path = Path(
        os.getenv("OPS_CONSOLE_SAMPLE_SNAPSHOT", backend_dir / "data" / "sample_snapshot.json"),
    )
    telemetry_paths_path = Path(
        os.getenv("OPS_CONSOLE_TELEMETRY_PATHS", backend_dir / "config" / "telemetry_paths.yaml"),
    )
    field_mapping_path = Path(
        os.getenv("OPS_CONSOLE_FIELD_MAPPING", backend_dir / "config" / "field_mapping.yaml"),
    )

    return Settings(
        backend_dir=backend_dir,
        console_dir=console_dir,
        project_root=project_root,
        db_path=db_path,
        config_dir=config_dir,
        workplan_template_path=workplan_template_path,
        workplan_snapshot_template_map=_read_mapping(
            "OPS_CONSOLE_WORKPLAN_SNAPSHOT_MAP",
            LEGACY_WORKPLAN_SNAPSHOT_MAP,
        ),
        workplan_snapshot_template_default=os.getenv(
            "OPS_CONSOLE_WORKPLAN_SNAPSHOT_DEFAULT",
            "ff7046bc-e60e-4d26-bde8-c97215f8417f",
        ).strip(),
        sample_snapshot_path=sample_snapshot_path,
        telemetry_paths_path=telemetry_paths_path,
        field_mapping_path=field_mapping_path,
        cvp_library_root=Path(os.getenv("OPS_CONSOLE_CVP_LIBRARY_ROOT", str(default_cvp_library_root))),
        monitoring_app_root=Path(os.getenv("OPS_CONSOLE_MONITORING_APP_ROOT", str(default_monitoring_app_root))),
        use_mock_data=_read_bool("OPS_CONSOLE_USE_MOCK", True),
        cvp_hosts=_read_csv("CVP_HOST"),
        cvp_port=_read_int("CVP_PORT", 443),
        cvp_token=os.getenv("CVP_TOKEN", "").strip(),
        cvp_username=os.getenv("CVP_USERNAME", "").strip(),
        cvp_password=os.getenv("CVP_PASSWORD", "").strip(),
        cvp_ca_file=os.getenv("CVP_CA_FILE", "").strip(),
        cvp_cert_file=os.getenv("CVP_CERT_FILE", "").strip(),
        cvp_key_file=os.getenv("CVP_KEY_FILE", "").strip(),
        cvp_insecure_tls=_read_bool("CVP_INSECURE_TLS", False),
        cvp_device_ids=_read_csv("CVP_DEVICE_IDS"),
        cors_origins=_read_csv("OPS_CONSOLE_CORS")
        or ["http://localhost:5173", "http://127.0.0.1:5173"],
        auth_session_hours=_read_int("OPS_CONSOLE_AUTH_SESSION_HOURS", 8),
        default_admin_username=os.getenv("OPS_CONSOLE_ADMIN_USERNAME", "admin").strip() or "admin",
        default_admin_password=os.getenv("OPS_CONSOLE_ADMIN_PASSWORD", "admin1234").strip() or "admin1234",
        default_admin_display_name=os.getenv("OPS_CONSOLE_ADMIN_DISPLAY_NAME", "Administrator").strip() or "Administrator",
    )
