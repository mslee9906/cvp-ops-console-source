from __future__ import annotations

from datetime import datetime, timezone
import importlib
import logging
from pathlib import Path
import sys
from threading import Event, Lock, Thread
import time
from typing import Any

from app.core.settings import Settings
from app.repositories.monitoring_repository import MonitoringRepository


logger = logging.getLogger(__name__)

ALLOWED_EVENT_TYPES = [
    "DEVICE_INTF_ERR_SMART",
    "SYSLOG_V2",
    "DEVICE_INTF_INFO",
]

STREAM_INITIAL = 1
STREAM_DELETE = 30
STREAM_RPC_TIMEOUT_S = 43200
LLDP_TAG_RPC_TIMEOUT_S = 3
INITIAL_BOOTSTRAP_WINDOW_MS = 8000
INITIAL_EVENT_CLOCK_SKEW_MS = 3000


class MonitoringService:
    def __init__(self, repository: MonitoringRepository, settings: Settings, kanban_service: Any | None = None) -> None:
        self.repository = repository
        self.settings = settings
        self.kanban_service = kanban_service
        self._worker_lock = Lock()
        self._workers: dict[int, MonitoringWorker] = {}
        self._imports_lock = Lock()
        self._event_helpers: dict[str, Any] | None = None

    def initialize(self) -> None:
        self.repository.initialize()

    def start(self) -> None:
        self._sync_workers(self.repository.list_sources())

    def shutdown(self) -> None:
        with self._worker_lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            worker.stop()

    def list_sources(self) -> list[dict[str, Any]]:
        return self.repository.list_sources()

    def save_sources(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        sources = self.repository.replace_sources(items)
        self._sync_workers(sources)
        return sources

    def acknowledge_source_alerts(self, source_id: int) -> dict[str, Any]:
        self.repository.acknowledge_source_alerts(source_id)
        return self.get_dashboard()

    def clear_live_events(self) -> dict[str, Any]:
        self.repository.clear_live_events()
        return self.get_dashboard()

    def get_dashboard(self) -> dict[str, Any]:
        sources = self.repository.list_sources()
        events_by_source = self.repository.list_recent_events_by_source(limit_per_source=100)
        live_sources: list[dict[str, Any]] = []
        overlay_count = 0
        maintenance_count = 0
        updated_markers: list[str] = []

        for source in sources:
            events = events_by_source.get(int(source["id"]), [])
            overlay_count += len(
                [
                    event
                    for event in events
                    if event["overlay"]
                    and event["status"] == "active"
                    and not event.get("acknowledged_at")
                    and not event.get("bootstrap_suppressed")
                ]
            )
            maintenance_count += len([event for event in events if event["maintenance_name"]])
            if source.get("last_event_at"):
                updated_markers.append(str(source["last_event_at"]))
            if source.get("last_connected_at"):
                updated_markers.append(str(source["last_connected_at"]))
            live_sources.append(
                {
                    "id": int(source["id"]),
                    "name": str(source["name"]),
                    "region": str(source["name"]),
                    "host": str(source["host"]),
                    "port": int(source["port"]),
                    "enabled": bool(source["enabled"]),
                    "status": str(source["status"]),
                    "status_label": self._status_label(str(source["status"]), bool(source["enabled"])),
                    "status_detail": str(source["status_detail"]),
                    "last_event_at": str(source["last_event_at"]),
                    "last_connected_at": str(source["last_connected_at"]),
                    "events": events,
                }
            )

        return {
            "last_updated": max(updated_markers) if updated_markers else "",
            "overlay_count": overlay_count,
            "maintenance_count": maintenance_count,
            "source_count": len(live_sources),
            "sources": live_sources,
        }

    def get_history(
        self,
        *,
        query: str = "",
        severity: str = "",
        start_date: str = "",
        end_date: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        items, total_count = self.repository.list_history(
            query=query,
            severity=severity,
            start_date=start_date,
            end_date=end_date,
            limit=limit,
            offset=offset,
        )
        return {"items": items, "total_count": total_count}

    def _sync_workers(self, sources: list[dict[str, Any]]) -> None:
        desired_ids = {int(source["id"]) for source in sources if source.get("enabled")}
        with self._worker_lock:
            existing_ids = set(self._workers.keys())
            remove_ids = existing_ids - desired_ids
            add_sources = [source for source in sources if source.get("enabled") and int(source["id"]) not in existing_ids]
            removed_workers = [self._workers[source_id] for source_id in remove_ids]
            self._workers = {
                source_id: worker for source_id, worker in self._workers.items() if source_id not in remove_ids
            }

        for worker in removed_workers:
            worker.stop()

        for source in sources:
            if not source.get("enabled"):
                self.repository.update_source_runtime(int(source["id"]), status="paused", status_detail="disabled")

        for source in add_sources:
            worker = MonitoringWorker(source, self.repository, self._load_helpers, self.kanban_service)
            with self._worker_lock:
                self._workers[int(source["id"])] = worker
            worker.start()

    def _load_helpers(self) -> dict[str, Any]:
        if self._event_helpers is not None:
            return self._event_helpers

        with self._imports_lock:
            if self._event_helpers is not None:
                return self._event_helpers

            cli_root = self.settings.monitoring_app_root / "cvp6_multi_cli"
            if not cli_root.exists():
                raise FileNotFoundError(f"Monitoring runtime not found: {cli_root}")
            if str(cli_root) not in sys.path:
                sys.path.insert(0, str(cli_root))

            get_token = importlib.import_module("get_token")
            sub_events = importlib.import_module("sub_events")
            desc_lldp = importlib.import_module("desc_lldp")
            setattr(desc_lldp, "TAG_RPC_TIMEOUT_S", LLDP_TAG_RPC_TIMEOUT_S)
            self._event_helpers = {
                "fetch_server_certificate_pem": getattr(get_token, "fetch_server_certificate_pem"),
                "fetch_session_token": getattr(get_token, "fetch_session_token"),
                "iter_event_stream": getattr(sub_events, "iter_event_stream"),
                "proto_to_jsonable": getattr(sub_events, "_proto_to_jsonable"),
                "DescLldpWorker": getattr(desc_lldp, "DescLldpWorker"),
                "get_token_path": cli_root / "get_token.py",
            }
            return self._event_helpers

    def _status_label(self, status: str, enabled: bool) -> str:
        if not enabled:
            return "Paused"
        if status == "connected":
            return "Connected"
        if status == "connecting":
            return "Connecting"
        if status == "error":
            return "Error"
        return "Paused"


class MonitoringWorker:
    def __init__(
        self,
        source: dict[str, Any],
        repository: MonitoringRepository,
        helper_loader: Any,
        kanban_service: Any | None = None,
    ) -> None:
        self.source = dict(source)
        self.repository = repository
        self.helper_loader = helper_loader
        self.kanban_service = kanban_service
        self.stop_event = Event()
        self.thread = Thread(target=self._run, daemon=True, name=f"monitoring-source-{source['id']}")
        self._desc_worker: Any | None = None
        self._runtime_alias = _safe_runtime_alias(
            str(source.get("name") or source.get("host") or f"source-{source['id']}")
        )

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=3.0)
        if self._desc_worker is not None:
            try:
                self._desc_worker.stop()
            except Exception:
                logger.debug("Failed to stop LLDP worker for source %s", self.source.get("id"), exc_info=True)
            self._desc_worker = None

    def _run(self) -> None:
        source_id = int(self.source["id"])
        host = str(self.source.get("host") or "").strip()
        port = int(self.source.get("port") or 443)
        server = f"{host}:{port}"
        username = str(self.source.get("username") or "")
        password = str(self.source.get("password") or "")
        last_error = ""

        if not host or not username or not password:
            self.repository.update_source_runtime(source_id, status="paused", status_detail="missing credentials")
            return

        while not self.stop_event.is_set():
            try:
                helpers = self.helper_loader()
                self._ensure_desc_worker(helpers, username=username, password=password)
                fetch_cert = helpers["fetch_server_certificate_pem"]
                fetch_token = helpers["fetch_session_token"]
                iter_event_stream = helpers["iter_event_stream"]
                proto_to_jsonable = helpers["proto_to_jsonable"]

                self.repository.update_source_runtime(source_id, status="connecting", status_detail="authenticating")
                cert_pem = fetch_cert(server=host, port=port)
                token = fetch_token(
                    server=server,
                    username=username,
                    password=password,
                    verify_tls=False,
                )
                self.repository.update_source_runtime(
                    source_id,
                    status="connected",
                    status_detail="streaming",
                    last_connected_at=_now_iso(),
                )
                connected_at_unix_ms = int(time.time() * 1000)
                last_error = ""

                for resp in iter_event_stream(
                    server=server,
                    token=token,
                    token_file_path=None,
                    reconnect=False,
                    cert_pem=cert_pem,
                    event_type=ALLOWED_EVENT_TYPES,
                    severity=None,
                    rpc_timeout_s=STREAM_RPC_TIMEOUT_S,
                ):
                    if self.stop_event.is_set():
                        break
                    if int(getattr(resp, "type", 0) or 0) == STREAM_INITIAL:
                        continue
                    value = getattr(resp, "value", resp)
                    obj = proto_to_jsonable(value)
                    if not isinstance(obj, dict):
                        obj = {"_value": obj}
                    obj["_stream_type"] = int(getattr(resp, "type", 0) or 0)
                    event_payload = self._normalize_event(obj)
                    if event_payload is None:
                        continue
                    event_payload["source_id"] = source_id
                    event_payload["source_name"] = str(self.source["name"])
                    event_payload["source_host"] = host
                    event_payload["source_port"] = port
                    if _should_skip_initial_active_event(
                        event_payload,
                        connected_at_unix_ms=connected_at_unix_ms,
                        seen_at_unix_ms=int(time.time() * 1000),
                    ):
                        continue
                    self._enrich_alert_context(event_payload, host=host, port=port)
                    event_payload["bootstrap_suppressed"] = _should_suppress_bootstrap_alert(
                        event_payload,
                        connected_at_unix_ms=connected_at_unix_ms,
                        seen_at_unix_ms=int(time.time() * 1000),
                    )
                    stored_event = self.repository.record_event(event_payload)
                    self._maybe_create_incident_card(stored_event)
            except Exception as exc:
                message = self._format_exception(exc)
                if message == "stream timeout":
                    self.repository.update_source_runtime(source_id, status="connected", status_detail="waiting events")
                else:
                    logger.warning("Monitoring source %s stream error: %s", server, message)
                    self.repository.update_source_runtime(source_id, status="error", status_detail=message[:240])
                last_error = message
                self.stop_event.wait(4.0)

        if self.stop_event.is_set():
            self.repository.update_source_runtime(source_id, status="paused", status_detail="stopped")

    def _ensure_desc_worker(self, helpers: dict[str, Any], *, username: str, password: str) -> None:
        if self._desc_worker is not None:
            return
        worker_cls = helpers.get("DescLldpWorker")
        get_token_path = helpers.get("get_token_path")
        if worker_cls is None or get_token_path is None:
            return
        runtime_dir = self.repository.db_path.parent / "monitoring_runtime" / f"source_{int(self.source['id'])}"
        runtime_dir.mkdir(parents=True, exist_ok=True)
        try:
            desc_worker = worker_cls(runtime_dir=runtime_dir, get_token_path=Path(get_token_path))
            desc_worker.configure(username=username, password=password, ssl=True)
            self._desc_worker = desc_worker
        except Exception:
            logger.warning(
                "Failed to initialize LLDP tag worker for monitoring source %s",
                self.source.get("host"),
                exc_info=True,
            )
            self._desc_worker = None

    def _maybe_create_incident_card(self, event: dict[str, Any]) -> None:
        if not self.kanban_service:
            return
        if not _is_actionable_alert_event(event):
            return
        event_row_id = int(event.get("id") or 0)
        if event_row_id <= 0:
            return
        if self.repository.has_event_card_link(event_row_id):
            return
        try:
            card = self.kanban_service.create_monitoring_alert_card(event)
            card_id = int(card.get("id") or 0)
            if card_id > 0:
                self.repository.link_event_card(event_row_id, card_id)
        except Exception:
            logger.exception(
                "Failed to create incident kanban card for monitoring event. source=%s event_row_id=%s event_type=%s",
                self.source.get("host"),
                event_row_id,
                event.get("event_type"),
            )

    def _enrich_alert_context(self, event_payload: dict[str, Any], *, host: str, port: int) -> None:
        event_type = str(event_payload.get("event_type") or "")
        severity = str(event_payload.get("severity") or "info")
        l2_peer = ""
        is_l2_internal = False
        if event_type != "SYSLOG_V2":
            l2_peer = self._resolve_l2_peer(event_payload, host=host, port=port)
            is_l2_internal = bool(l2_peer)
        event_payload["l2_peer"] = l2_peer
        event_payload["is_l2_internal"] = is_l2_internal
        event_payload["overlay"] = _is_overlay_event(event_type, severity, is_l2_internal)

    def _resolve_l2_peer(self, event_payload: dict[str, Any], *, host: str, port: int) -> str:
        if self._desc_worker is None:
            return ""
        lookup_pairs = _candidate_l2_lookup_pairs(event_payload)
        if not lookup_pairs:
            return ""
        server = f"{host}:{int(port)}"
        for device_id, interface_id in lookup_pairs:
            try:
                peer = str(
                    self._desc_worker.get_l2_peer(
                        alias=self._runtime_alias,
                        ev_addr=server,
                        auth_addr=server,
                        device_id=device_id,
                        interface_id=interface_id,
                        timeout_s=LLDP_TAG_RPC_TIMEOUT_S,
                    )
                    or ""
                )
                if peer:
                    return peer
            except Exception:
                logger.debug(
                    "LLDP tag lookup failed for source=%s device_id=%s interface=%s",
                    self.source.get("host"),
                    device_id,
                    interface_id,
                    exc_info=True,
                )
        return ""

    def _normalize_event(self, obj: dict[str, Any]) -> dict[str, Any] | None:
        event_type = _unwrap_str_field(obj.get("event_type")).strip()
        if not event_type:
            return None

        timestamp = _extract_event_timestamp(obj)
        occurred_at = datetime.fromtimestamp(timestamp, tz=timezone.utc).astimezone().isoformat(timespec="seconds")
        occurred_unix_ms = int(timestamp * 1000)
        fields = _extract_data_fields(obj.get("data", {}).get("data"))
        title = _unwrap_str_field(obj.get("title")).strip() or event_type
        description = _unwrap_str_field(obj.get("description")).strip()
        lookup_pairs = _extract_l2_lookup_pairs(fields)
        interface_name = _build_display_interface(fields)
        hostname = fields.get("hostname") or fields.get("compName") or ""
        comp_name = fields.get("compName") or ""
        hostname1 = fields.get("hostname1") or ""
        hostname2 = fields.get("hostname2") or ""
        device_id = fields.get("deviceId1") or fields.get("deviceId") or ""
        device_id2 = fields.get("deviceId2") or ""
        if not device_id2:
            lookup_device_ids = [item[0] for item in lookup_pairs]
            if lookup_device_ids:
                device_id = device_id or lookup_device_ids[0]
            if len(lookup_device_ids) > 1:
                device_id2 = lookup_device_ids[1]
        stream_type = int(obj.get("_stream_type", 0) or 0)
        status = "resolved" if _is_resolved_event(obj, stream_type) else "active"
        severity = _normalize_severity(obj.get("severity"), event_type)
        message = _build_message(title, interface_name, event_type)
        event_id = _extract_event_id(obj)

        return {
            "event_id": event_id,
            "stream_type": stream_type,
            "occurred_at": occurred_at,
            "stored_at": _now_iso(),
            "occurred_unix_ms": occurred_unix_ms,
            "severity": severity,
            "event_type": event_type,
            "title": title,
            "description": description,
            "message": message,
            "hostname": str(hostname),
            "interface_name": str(interface_name),
            "comp_name": str(comp_name),
            "hostname1": str(hostname1),
            "hostname2": str(hostname2),
            "device_id": str(device_id),
            "device_id2": str(device_id2),
            "l2_peer": "",
            "is_l2_internal": False,
            "maintenance_name": "",
            "overlay": False,
            "status": status,
            "bootstrap_suppressed": False,
            "cvp_link": _build_event_link(str(self.source["host"]), int(self.source["port"]), event_id, occurred_unix_ms),
            "tag_lookup_pairs": lookup_pairs,
            "raw_json": obj,
        }

    def _format_exception(self, exc: Exception) -> str:
        code = getattr(exc, "code", None)
        details = getattr(exc, "details", None)
        if callable(code):
            try:
                grpc_code = code()
            except Exception:
                grpc_code = None
            else:
                if str(grpc_code).endswith("DEADLINE_EXCEEDED"):
                    return "stream timeout"
        if callable(details):
            try:
                return str(details() or exc)
            except Exception:
                return str(exc)
        return str(exc)


def _unwrap_str_field(field_obj: object) -> str:
    value = field_obj
    for _ in range(3):
        if isinstance(value, dict) and "value" in value and len(value) == 1:
            value = value.get("value")
        else:
            break

    if isinstance(value, dict) and "value" in value:
        nested = value.get("value")
        if isinstance(nested, str):
            return nested
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _extract_event_timestamp(value: dict[str, Any]) -> float:
    try:
        ts = value.get("key", {}).get("timestamp")
        if isinstance(ts, dict):
            sec = ts.get("seconds")
            nanos = ts.get("nanos") or 0
            if sec is not None:
                return float(sec) + (float(nanos) / 1e9)
    except Exception:
        pass
    return time.time()


def _extract_event_id(value: dict[str, Any]) -> str:
    event_key = value.get("key", {}).get("key")
    if isinstance(event_key, dict):
        return str(event_key.get("value") or "")
    if isinstance(event_key, str):
        return event_key
    return ""


def _extract_data_fields(data_data: Any) -> dict[str, str]:
    fields: dict[str, str] = {}
    if isinstance(data_data, dict):
        for key, value in data_data.items():
            text = _unwrap_str_field(value)
            if text:
                fields[str(key)] = text
        return fields

    if isinstance(data_data, list):
        for item in data_data:
            if not isinstance(item, dict):
                continue
            key_name = str(item.get("key") or "").strip()
            value_text = _unwrap_str_field(item.get("value"))
            if key_name and value_text:
                fields[key_name] = value_text
    return fields


def _build_display_interface(fields: dict[str, str]) -> str:
    interface1 = str(fields.get("interfaceId1") or "").strip()
    interface2 = str(fields.get("interfaceId2") or "").strip()
    if interface1 and interface2:
        return f"{interface1} <-> {interface2}"
    if interface1:
        return interface1
    if interface2:
        return interface2
    return str(
        fields.get("interfaceId")
        or fields.get("interface")
        or fields.get("interfaceName")
        or fields.get("ifName")
        or ""
    ).strip()


def _extract_l2_lookup_pairs(fields: dict[str, str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []

    def add_pair(device_id: str, interface_id: str) -> None:
        normalized_device_id = str(device_id or "").strip()
        normalized_interface_id = str(interface_id or "").strip()
        if not normalized_device_id or not normalized_interface_id:
            return
        pair = (normalized_device_id, normalized_interface_id)
        if pair not in pairs:
            pairs.append(pair)

    add_pair(fields.get("deviceId1") or "", fields.get("interfaceId1") or "")
    add_pair(fields.get("deviceId2") or "", fields.get("interfaceId2") or "")

    raw_device_id = str(fields.get("deviceId") or "").strip()
    raw_interface_id = str(fields.get("interfaceId") or "").strip()
    if raw_device_id and raw_interface_id:
        device_tokens = [token.strip() for token in raw_device_id.split(",") if token.strip()]
        interface_tokens = [token.strip() for token in raw_interface_id.split(",") if token.strip()]
        if len(interface_tokens) >= 4:
            add_pair(interface_tokens[0], interface_tokens[1])
            add_pair(interface_tokens[2], interface_tokens[3])
        elif len(device_tokens) >= 2 and len(interface_tokens) >= 2:
            add_pair(device_tokens[0], interface_tokens[0])
            add_pair(device_tokens[1], interface_tokens[1])
        else:
            add_pair(raw_device_id, raw_interface_id)

    if not pairs:
        add_pair(
            str(fields.get("deviceId") or "").strip(),
            str(fields.get("interfaceId") or fields.get("interface") or fields.get("interfaceName") or fields.get("ifName") or "").strip(),
        )
    return pairs


def _candidate_l2_lookup_pairs(event_payload: dict[str, Any]) -> list[tuple[str, str]]:
    raw_pairs = event_payload.get("tag_lookup_pairs") or []
    pairs: list[tuple[str, str]] = []

    def add_pair(device_id: str, interface_id: str) -> None:
        normalized_device_id = str(device_id or "").strip()
        if not normalized_device_id:
            return
        for candidate in _expand_interface_lookup_candidates(interface_id):
            pair = (normalized_device_id, candidate)
            if pair not in pairs:
                pairs.append(pair)

    for item in raw_pairs:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        add_pair(str(item[0] or ""), str(item[1] or ""))

    if not pairs:
        add_pair(str(event_payload.get("device_id") or ""), str(event_payload.get("interface_name") or ""))
    return pairs


def _expand_interface_lookup_candidates(raw: str) -> list[str]:
    text = str(raw or "").strip()
    if not text:
        return []

    candidates: list[str] = []

    def add(value: str) -> None:
        token = str(value or "").strip()
        if token and token not in candidates:
            candidates.append(token)

    add(text)
    add(text.replace(" ", ""))

    if "," in text:
        split_tokens = [token.strip() for token in text.split(",") if token.strip()]
        if split_tokens:
            add(split_tokens[-1])

    cleaned = text
    if ")," in cleaned:
        cleaned = cleaned.split("),", 1)[1].strip()
        add(cleaned)
        add(cleaned.replace(" ", ""))

    lowered = cleaned.lower()
    if lowered.startswith("ethernet"):
        suffix = cleaned[len("Ethernet") :].strip()
        add(f"Et{suffix}")
    elif lowered.startswith("et"):
        add(f"Ethernet{cleaned[2:].strip()}")
    if lowered.startswith("port-channel"):
        suffix = cleaned[len("Port-Channel") :].strip()
        add(f"Po{suffix}")
    elif lowered.startswith("po"):
        add(f"Port-Channel{cleaned[2:].strip()}")
    return candidates


def _normalize_severity(raw: Any, event_type: str) -> str:
    if isinstance(raw, int):
        if raw >= 4:
            return "critical"
        if raw >= 2:
            return "warning"
        return "info"

    text = str(raw or "").upper()
    if "CRITICAL" in text:
        return "critical"
    if "WARNING" in text or "ERROR" in text:
        return "warning"
    if event_type.endswith("_ERROR_GROUP"):
        return "critical"
    if "_ERR" in event_type:
        return "warning"
    return "info"


def _is_resolved_event(obj: dict[str, Any], stream_type: int) -> bool:
    if stream_type == STREAM_DELETE:
        return True
    delete_time = obj.get("delete_time") or obj.get("deleteTime")
    return delete_time not in (None, "", 0, {}, [])


def _is_overlay_event(event_type: str, severity: str, is_l2_internal: bool) -> bool:
    if event_type == "SYSLOG_V2" and severity != "info":
        return True
    if event_type in {"DEVICE_INTF_ERR_SMART", "DEVICE_INTF_INFO"}:
        return bool(is_l2_internal)
    return False


def _is_actionable_alert_event(event: dict[str, Any]) -> bool:
    if str(event.get("status") or "") != "active":
        return False
    if str(event.get("acknowledged_at") or "").strip():
        return False
    if bool(event.get("bootstrap_suppressed")):
        return False
    return bool(event.get("overlay"))


def _should_suppress_bootstrap_alert(
    event: dict[str, Any],
    *,
    connected_at_unix_ms: int,
    seen_at_unix_ms: int,
) -> bool:
    if _should_skip_initial_active_event(
        event,
        connected_at_unix_ms=connected_at_unix_ms,
        seen_at_unix_ms=seen_at_unix_ms,
    ):
        return True
    if not bool(event.get("overlay")):
        return False
    if str(event.get("status") or "") != "active":
        return False
    occurred_unix_ms = int(event.get("occurred_unix_ms") or 0)
    if occurred_unix_ms <= 0:
        return False
    if seen_at_unix_ms > connected_at_unix_ms + INITIAL_BOOTSTRAP_WINDOW_MS:
        return False
    return occurred_unix_ms <= connected_at_unix_ms + INITIAL_EVENT_CLOCK_SKEW_MS


def _should_skip_initial_active_event(
    event: dict[str, Any],
    *,
    connected_at_unix_ms: int,
    seen_at_unix_ms: int,
) -> bool:
    if str(event.get("status") or "") != "active":
        return False
    occurred_unix_ms = int(event.get("occurred_unix_ms") or 0)
    if occurred_unix_ms <= 0:
        return False
    if seen_at_unix_ms > connected_at_unix_ms + INITIAL_BOOTSTRAP_WINDOW_MS:
        return False
    return occurred_unix_ms <= connected_at_unix_ms + INITIAL_EVENT_CLOCK_SKEW_MS


def _build_message(title: str, interface_name: str, event_type: str) -> str:
    if interface_name:
        return f"{title} / {interface_name}"
    if event_type == "SYSLOG_V2":
        return f"{title} / SYSLOG_V2"
    return title


def _build_event_link(host: str, port: int, event_id: str, occurred_unix_ms: int) -> str:
    if not host:
        return ""
    base = f"https://{host}:{int(port)}"
    if event_id and occurred_unix_ms > 0:
        return f"{base}/cv/events/{event_id}/{occurred_unix_ms}"
    return f"{base}/cv/events/"


def _safe_runtime_alias(raw: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in raw.strip())
    return cleaned or "monitoring"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
