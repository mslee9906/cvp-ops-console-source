from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import logging
import re
import ssl
import sys
import time
from threading import Lock, Thread
from typing import Any
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

import grpc
import requests
from google.protobuf import wrappers_pb2 as wrappers

from app.core.settings import CVPSourceEndpoint
from app.services.kanban_service import KanbanService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _TargetRuntime:
    device_id: str
    input_name: str
    hostname: str
    mgmt_ip: str
    model: str
    serial: str
    config_text: str
    cvp_host: str
    endpoint: CVPSourceEndpoint
    snapshot_template_id: str


class WorkPlanService:
    LEGACY_CLUSTER_ADDR_MAP = {
        "PRD-Cluster.addr": "10.172.152.33",
        "ETC-Cluster.addr": "10.172.152.36",
        "PT-Cluster.addr": "10.172.64.252",
        "Cluster.addr": "10.172.152.33",
    }
    CHANGE_OVERVIEW_SHEET = "①변경개요"
    CHECK_SHEET = "③Check(전 후)"
    CONFIG_SHEET = "④ 사전 Config 검증"
    SCENARIO_SHEET = "⑥ 작업시나리오"
    STEP_LABEL = "작업 전"
    RESULT_ROOT_NAME = "workplan-runtime"
    SNAPSHOT_WAIT_SECONDS = 10
    REQUEST_TIMEOUT = 30
    SNAPSHOT_LINK_BASE_ROW = 153
    SNAPSHOT_ACTION_ID = "snapshot1"
    NA_LABEL = "N/A"
    EXCEL_LABEL_MAX_LENGTH = 240
    CHECK_COLUMNS = [
        "단계",
        "_device_time",
        "_hostname",
        "_ip",
        "_model",
        "_vendor",
        "_version",
        "comp_ver",
        "cpu",
        "mem",
        "environment",
        "module",
        "Port-Channel",
        "Transceiver",
        "Interface",
        "Mlag",
        "OSPF Neighbor",
        "BGP Neighbor",
        "Route",
        "LOG",
        "Traffic (50% ↓)",
        "uptime",
        "lldp",
    ]

    def __init__(self, kanban_service: KanbanService, settings: Any) -> None:
        self.kanban_service = kanban_service
        self.snapshot_repository = kanban_service.snapshot_repository
        self.settings = settings
        self._job_lock = Lock()
        self._excel_lock = Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._job_threads: dict[str, Thread] = {}
        self._changecontrol_modules: tuple[Any, Any, Any] | None = None

    def export_workbook(self, card_id: int, payload: dict[str, Any]) -> tuple[BytesIO, str]:
        stream, filename, _ = self._generate_workbook(card_id, payload)
        return stream, filename

    def start_export_job(self, card_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        card = self.kanban_service.get_card(card_id) or {}
        project_name = str(payload.get("project_name") or card.get("title") or card.get("card_code") or "").strip()
        now = self._now_iso()
        job_id = uuid4().hex
        job_state = {
            "job_id": job_id,
            "card_id": card_id,
            "project_name": project_name,
            "status": "queued",
            "progress_percent": 1,
            "step": "queued",
            "detail": "작업 계획서 생성을 대기 중입니다.",
            "started_at": now,
            "updated_at": now,
            "finished_at": "",
            "filename": "",
            "error_message": "",
            "download_ready": False,
            "result_path": "",
        }
        worker = Thread(target=self._run_export_job, args=(job_id, card_id, dict(payload)), daemon=True)
        with self._job_lock:
            self._jobs[job_id] = job_state
            self._job_threads[job_id] = worker
        self._log_job(job_id, f"작업 계획서 job 생성: card_id={card_id}, project_name={project_name or '(empty)'}")
        worker.start()
        return self.get_job_progress(job_id)

    def get_job_progress(self, job_id: str) -> dict[str, Any]:
        with self._job_lock:
            job_state = self._jobs.get(job_id)
            if not job_state:
                raise ValueError("작업 계획서 생성 작업을 찾을 수 없습니다.")
            return self._public_job_state(job_state)

    def download_job_workbook(self, job_id: str) -> tuple[Path, str]:
        with self._job_lock:
            job_state = self._jobs.get(job_id)
            if not job_state:
                raise ValueError("작업 계획서 생성 작업을 찾을 수 없습니다.")
            status = str(job_state.get("status") or "")
            if status == "failed":
                raise RuntimeError(str(job_state.get("error_message") or "작업 계획서 생성에 실패했습니다."))
            if status != "success":
                raise RuntimeError("작업 계획서 생성이 아직 완료되지 않았습니다.")
            result_path = Path(str(job_state.get("result_path") or "").strip())
            filename = str(job_state.get("filename") or "").strip()
        if not result_path.exists() or not result_path.is_file():
            raise RuntimeError("생성된 작업 계획서 파일을 찾을 수 없습니다.")
        return result_path, filename or result_path.name

    def download_job_snapshot_archive(self, job_id: str) -> tuple[Path, str]:
        with self._job_lock:
            job_state = self._jobs.get(job_id)
            if not job_state:
                raise ValueError("작업 계획서 생성 작업을 찾을 수 없습니다.")
            status = str(job_state.get("status") or "")
            if status == "failed":
                raise RuntimeError(str(job_state.get("error_message") or "작업 계획서 생성이 실패했습니다."))
            if status != "success":
                raise RuntimeError("작업 계획서 생성이 완료된 후 snapshot 산출물을 받을 수 있습니다.")
            project_name = str(job_state.get("project_name") or "").strip()

        source_root = self._job_snapshot_output_dir(job_id)
        if not source_root.exists() or not any(path.is_file() for path in source_root.rglob("*")):
            raise RuntimeError("다운로드할 snapshot 산출물이 없습니다.")

        archive_filename = self._sanitize_filename(f"{project_name or f'workplan-{job_id}'}_snapshot_outputs.zip")
        archive_path = self._job_output_dir(job_id) / archive_filename
        self._build_snapshot_archive(source_root, archive_path)
        return archive_path, archive_filename

    def _run_export_job(self, job_id: str, card_id: int, payload: dict[str, Any]) -> None:
        try:
            self._set_job_progress(
                job_id,
                status="running",
                progress_percent=2,
                step="prepare",
                detail="작업 계획서 생성을 시작합니다.",
            )
            self._log_job(job_id, f"작업 계획서 생성 시작: card_id={card_id}")
            stream, filename, project_name = self._generate_workbook(card_id, payload, job_id=job_id)
            output_dir = self._job_output_dir(job_id)
            result_path = output_dir / (filename or f"{job_id}.xlsx")
            with result_path.open("wb") as file_handle:
                file_handle.write(stream.getvalue())
            finished_at = self._now_iso()
            self._log_job(job_id, f"작업 계획서 생성 완료: filename={filename}, result_path={result_path}")
            self._set_job_progress(
                job_id,
                status="success",
                progress_percent=100,
                step="completed",
                detail="작업 계획서 생성이 완료되었습니다.",
                project_name=project_name,
                filename=filename,
                finished_at=finished_at,
                updated_at=finished_at,
                error_message="",
                result_path=str(result_path),
                download_ready=True,
            )
        except Exception as exc:
            finished_at = self._now_iso()
            self._log_job(job_id, f"작업 계획서 생성 실패: {exc}", level="error")
            error_message = f"{exc} (로그: {self._job_log_path(job_id)})"
            self._set_job_progress(
                job_id,
                status="failed",
                progress_percent=100,
                step="failed",
                detail=error_message,
                error_message=error_message,
                finished_at=finished_at,
                updated_at=finished_at,
                download_ready=False,
            )

    def _generate_workbook(
        self,
        card_id: int,
        payload: dict[str, Any],
        job_id: str | None = None,
    ) -> tuple[BytesIO, str, str]:
        card = self.kanban_service.get_card(card_id)
        if not card:
            raise ValueError("작업 카드를 찾을 수 없습니다.")

        project_name = str(payload.get("project_name") or card.get("title") or card.get("card_code") or "").strip()
        if not project_name:
            project_name = f"작업계획서_{card_id}"

        self._set_job_progress(
            job_id,
            card_id=card_id,
            project_name=project_name,
            status="running",
            progress_percent=4,
            step="card",
            detail="작업 카드와 대상 장비를 확인하는 중입니다.",
        )
        targets = self._resolve_card_targets(card)
        results: list[dict[str, Any]] = []
        target_count = max(len(targets), 1)
        for index, target in enumerate(targets, start=1):
            device_label = str(target.get("display_name") or target.get("mgmt_ip") or f"target-{index}").strip()
            range_start = 8 + int(((index - 1) / target_count) * 76)
            range_end = 8 + int((index / target_count) * 76)
            progress_callback = self._build_job_callback(job_id, device_label, range_start, range_end)
            progress_callback(3, "target_prepare", "장비 작업계획서 데이터를 수집하는 중입니다.")
            results.append(self._collect_target_result(target, project_name, progress_callback=progress_callback, job_id=job_id))

        self._set_job_progress(
            job_id,
            progress_percent=88,
            step="template",
            detail="작업 계획서 템플릿을 불러오는 중입니다.",
        )
        self._set_job_progress(
            job_id,
            progress_percent=94,
            step="workbook",
            detail="엑셀 시트에 수집 결과를 채우는 중입니다.",
        )
        self._set_job_progress(
            job_id,
            progress_percent=98,
            step="save",
            detail="xlsx 파일을 저장하는 중입니다.",
        )
        stream = self._render_workbook_stream(project_name, results, job_id=job_id)
        filename = self._sanitize_filename(f"{self.STEP_LABEL}_{project_name}.xlsx")
        return stream, filename, project_name

    def _public_job_state(self, job_state: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in job_state.items()
            if key != "result_path"
        }

    def _set_job_progress(self, job_id: str | None, **changes: Any) -> None:
        if not job_id:
            return

        with self._job_lock:
            job_state = self._jobs.get(job_id)
            if not job_state:
                return
            for key, value in changes.items():
                if key == "progress_percent":
                    job_state[key] = max(0, min(int(value), 100))
                elif value is not None:
                    job_state[key] = value
            if "updated_at" not in changes:
                job_state["updated_at"] = self._now_iso()
            job_state["download_ready"] = bool(
                job_state.get("status") == "success"
                and str(job_state.get("filename") or "").strip()
                and str(job_state.get("result_path") or "").strip()
            ) or bool(changes.get("download_ready"))

    def _build_job_callback(
        self,
        job_id: str | None,
        device_label: str,
        range_start: int,
        range_end: int,
    ) -> Any:
        def relay(local_percent: int, step: str, detail: str) -> None:
            if not job_id:
                return
            bounded_percent = max(0, min(int(local_percent), 100))
            spread = max(range_end - range_start, 1)
            scaled_percent = range_start + int((bounded_percent / 100) * spread)
            message = detail.strip() if detail else step
            self._set_job_progress(
                job_id,
                status="running",
                progress_percent=scaled_percent,
                step=step,
                detail=f"[{device_label}] {message}",
            )
            self._log_job(job_id, f"[{device_label}] {step}: {message}")

        return relay

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    def _job_output_dir(self, job_id: str) -> Path:
        job_dir = self._workplan_result_root() / "jobs" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        return job_dir

    def _job_snapshot_output_dir(self, job_id: str) -> Path:
        snapshot_dir = self._job_output_dir(job_id) / "snapshot-outputs"
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        return snapshot_dir

    def _job_log_path(self, job_id: str) -> Path:
        logs_root = self._workplan_result_root() / "logs"
        logs_root.mkdir(parents=True, exist_ok=True)
        return logs_root / f"{job_id}.log"

    def _log_job(self, job_id: str | None, message: str, level: str = "info") -> None:
        log_line = f"{self._now_iso()} | {level.upper()} | {message}"
        if level == "error":
            logger.error(message)
        elif level == "warning":
            logger.warning(message)
        else:
            logger.info(message)
        if not job_id:
            return
        log_path = self._job_log_path(job_id)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(log_line + "\n")

    def _extract_ipv4_address(self, text: Any) -> str:
        raw = str(text or "")
        match = re.search(r"(?<!\d)(\d{1,3}(?:\.\d{1,3}){3})(?!\d)", raw)
        return match.group(1) if match else ""

    def _find_cvp_binding_lines(self, config_text: str) -> list[str]:
        lines: list[str] = []
        for raw_line in config_text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if "-cvaddr=" in line or "Cluster.addr" in line:
                lines.append(line)
        return lines

    def _resolve_card_targets(self, card: dict[str, Any]) -> list[dict[str, Any]]:
        targets = list(card.get("targets") or [])
        if not targets:
            raise ValueError("작업 카드에 대상장비가 없습니다.")

        targets.sort(
            key=lambda item: (
                int(item.get("sort_order") or 0),
                int(item.get("id") or 0),
                str(item.get("display_name") or "").lower(),
            )
        )

        missing_cvp = [
            str(item.get("display_name") or item.get("mgmt_ip") or f"target-{index + 1}")
            for index, item in enumerate(targets)
            if not str(item.get("cvp_device_id") or "").strip()
        ]
        if missing_cvp:
            raise ValueError(
                "다음 대상장비는 CVP 연결 정보가 없어 작업계획서를 생성할 수 없습니다: "
                + ", ".join(missing_cvp)
            )

        return targets

    def _collect_target_result(
        self,
        target: dict[str, Any],
        project_name: str,
        progress_callback: Any | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        if progress_callback:
            progress_callback(8, "target_runtime", "running-config와 CVP 매핑 정보를 확인하는 중입니다.")
        runtime = self._build_target_runtime(target)
        binding_lines = self._find_cvp_binding_lines(runtime.config_text)
        self._log_job(
            job_id,
            f"대상 장비 런타임 확인: device={runtime.input_name}, hostname={runtime.hostname or self.NA_LABEL}, "
            f"mgmt_ip={runtime.mgmt_ip or self.NA_LABEL}, cvp_host={runtime.cvp_host}, snapshot_template_id={runtime.snapshot_template_id}",
        )
        self._log_job(
            job_id,
            f"{runtime.input_name}: running-config CVP binding lines -> {binding_lines or [self.NA_LABEL]}",
        )
        self._log_device_source_diagnostics(job_id, runtime)
        if progress_callback:
            progress_callback(18, "target_auth", f"{runtime.cvp_host} CVP에 접속하는 중입니다.")
        session, token, verify = self._open_rest_session(runtime.endpoint)
        try:
            if progress_callback:
                progress_callback(32, "target_serial", "CVP inventory에서 장비 serial을 조회하는 중입니다.")
            serial = self._resolve_serial(session, token, verify, runtime)
            if progress_callback:
                progress_callback(48, "target_snapshot", "Snapshot Change Control을 실행하는 중입니다.")
            self._execute_snapshot(runtime.endpoint, token, runtime.snapshot_template_id, serial)
            if progress_callback:
                progress_callback(62, "target_wait", "Snapshot 결과가 생성되기를 기다리는 중입니다.")
            time.sleep(self.SNAPSHOT_WAIT_SECONDS)
            if progress_callback:
                progress_callback(78, "target_fetch", "Snapshot 결과를 조회하는 중입니다.")
            snapshot_status = self._request_json(
                session,
                token,
                verify,
                f"https://{runtime.endpoint.host}:{runtime.endpoint.port}/api/v1/rest/cvp/snapshots/status/{serial}/snapshots/ids/{runtime.snapshot_template_id}",
            )
        except Exception as exc:
            device_label = runtime.hostname or runtime.input_name or runtime.device_id
            raise RuntimeError(f"{device_label} snapshot 수집에 실패했습니다: {exc}") from exc
        finally:
            session.close()

        if progress_callback:
            progress_callback(90, "target_extract", "명령 결과를 정리하는 중입니다.")
        command_outputs = self._extract_snapshot_outputs(
            snapshot_status,
            runtime.snapshot_template_id,
            project_name,
            runtime.hostname or runtime.input_name or runtime.device_id,
            job_id=job_id,
        )
        if progress_callback:
            progress_callback(97, "target_parse", "Snapshot 결과를 파싱하는 중입니다.")
        result = self._parse_snapshot_outputs(command_outputs, self.STEP_LABEL)

        if not result.get("running-config"):
            result["running-config"] = runtime.config_text
        if not result.get("_hostname"):
            result["_hostname"] = runtime.hostname
        if not result.get("_ip"):
            result["_ip"] = runtime.mgmt_ip
        if not result.get("_model"):
            result["_model"] = runtime.model
        if not result.get("_vendor") and (runtime.hostname or runtime.model):
            result["_vendor"] = "Arista EOS"
        if not result.get("serial"):
            result["serial"] = serial
        if not result.get("cvpaddr"):
            result["cvpaddr"] = runtime.cvp_host

        result["단계"] = self.STEP_LABEL
        result["device_name"] = runtime.input_name
        result["device_id"] = runtime.device_id
        result["snapshot_template_id"] = runtime.snapshot_template_id
        result = self._normalize_snapshot_result(result, runtime, job_id=job_id)
        if progress_callback:
            progress_callback(100, "target_done", "장비 작업계획서 데이터 수집을 완료했습니다.")
        return result

    def _build_target_runtime(self, target: dict[str, Any]) -> _TargetRuntime:
        device_id = str(target.get("cvp_device_id") or "").strip()
        linked_device = self.snapshot_repository.get_device(device_id) if device_id else None
        config_metadata = self.snapshot_repository.get_device_config(device_id) if device_id else None
        config_text = self._read_config_text(config_metadata)

        if not config_text:
            name = str(target.get("display_name") or device_id or "대상장비").strip()
            raise RuntimeError(f"{name} running-config snapshot을 찾을 수 없습니다.")

        input_name = str(target.get("display_name") or "").strip()
        hostname = str((linked_device or {}).get("hostname") or input_name or device_id).strip()
        mgmt_ip = str((linked_device or {}).get("mgmt_ip") or target.get("mgmt_ip") or "").strip()
        model = str((linked_device or {}).get("model") or target.get("model") or "").strip()
        serial = str((linked_device or {}).get("serial") or device_id).strip()
        cvp_host = self._extract_cvp_address(config_text)
        if not cvp_host:
            raise RuntimeError(f"{hostname or input_name or device_id} running-config에서 CVP 주소를 찾을 수 없습니다.")

        endpoint = self._resolve_endpoint(cvp_host)
        snapshot_template_id = self._resolve_snapshot_template_id(cvp_host)
        if not snapshot_template_id:
            raise RuntimeError(f"{cvp_host}에 대한 Snapshot Template ID가 설정되어 있지 않습니다.")

        return _TargetRuntime(
            device_id=device_id,
            input_name=input_name or hostname or device_id,
            hostname=hostname,
            mgmt_ip=mgmt_ip,
            model=model,
            serial=serial,
            config_text=config_text,
            cvp_host=cvp_host,
            endpoint=endpoint,
            snapshot_template_id=snapshot_template_id,
        )

    def _normalize_snapshot_result(
        self,
        result: dict[str, Any],
        runtime: _TargetRuntime,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        normalized = dict(result)
        fallbacks = {
            "_hostname": runtime.hostname or runtime.input_name or runtime.device_id,
            "_ip": runtime.mgmt_ip,
            "_model": runtime.model,
            "_vendor": "Arista EOS" if (runtime.hostname or runtime.model or runtime.input_name) else "",
            "serial": runtime.serial,
            "cvpaddr": runtime.cvp_host,
            "running-config": runtime.config_text,
            "device_name": runtime.input_name or runtime.hostname or runtime.device_id,
            "device_id": runtime.device_id,
        }

        for field_name, fallback in fallbacks.items():
            current_value = normalized.get(field_name)
            if self._is_blank_value(current_value):
                replacement = self._normalize_text_value(
                    fallback,
                    allow_multiline=(field_name == "running-config"),
                )
                normalized[field_name] = replacement or self.NA_LABEL
                self._log_job(
                    job_id,
                    f"{runtime.input_name}: snapshot 필드 '{field_name}' 값이 비어 있어 '{normalized[field_name]}'로 대체했습니다.",
                    level="warning",
                )
            elif isinstance(current_value, str):
                normalized[field_name] = self._normalize_text_value(
                    current_value,
                    allow_multiline=(field_name == "running-config"),
                ) or self.NA_LABEL

        cvpaddr_value = self._normalize_text_value(normalized.get("cvpaddr"))
        cvpaddr_ipv4 = self._extract_ipv4_address(cvpaddr_value)
        runtime_cvpaddr = self._normalize_text_value(runtime.cvp_host)
        if cvpaddr_ipv4:
            normalized["cvpaddr"] = cvpaddr_ipv4
        elif runtime_cvpaddr:
            normalized["cvpaddr"] = runtime_cvpaddr
            self._log_job(
                job_id,
                f"{runtime.input_name}: invalid snapshot cvpaddr '{cvpaddr_value or self.NA_LABEL}' was replaced with runtime cvp_host '{runtime_cvpaddr}'.",
                level="warning",
            )

        for field_name in self.CHECK_COLUMNS:
            if field_name == "단계":
                normalized[field_name] = self.STEP_LABEL
                continue
            current_value = normalized.get(field_name)
            if self._is_blank_value(current_value):
                normalized[field_name] = self.NA_LABEL
                self._log_job(
                    job_id,
                    f"{runtime.input_name}: snapshot 필드 '{field_name}' 값이 비어 있어 'N/A'로 대체했습니다.",
                    level="warning",
                )
            elif isinstance(current_value, str):
                cleaned = self._normalize_text_value(current_value)
                if not cleaned:
                    normalized[field_name] = self.NA_LABEL
                    self._log_job(
                        job_id,
                        f"{runtime.input_name}: snapshot 필드 '{field_name}' 값이 정리 후 비어 있어 'N/A'로 대체했습니다.",
                        level="warning",
                    )
                else:
                    normalized[field_name] = cleaned

        return normalized

    def _is_blank_value(self, value: Any) -> bool:
        if value is None:
            return True
        if isinstance(value, str):
            return not value.strip()
        if isinstance(value, (list, tuple, set, dict)):
            return len(value) == 0
        return False

    def _is_na_marker(self, value: Any) -> bool:
        text = self._normalize_text_value(value)
        return not text or text.upper() == self.NA_LABEL

    def _normalize_text_value(self, value: Any, allow_multiline: bool = False) -> str:
        if value is None:
            return ""
        text = str(value)
        text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
        if allow_multiline:
            text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
            text = "\n".join(line.strip() for line in text.splitlines()).strip()
            return text
        text = text.replace("\n", " ").replace("\t", " ")
        text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _normalize_excel_label(self, value: Any, fallback: str, job_id: str | None = None, context: str = "") -> str:
        cleaned = self._normalize_text_value(value)
        if not cleaned:
            cleaned = self._normalize_text_value(fallback) or self.NA_LABEL
            self._log_job(job_id, f"{context} label이 비어 있어 '{cleaned}'로 대체했습니다.", level="warning")
        if len(cleaned) > self.EXCEL_LABEL_MAX_LENGTH:
            shortened = cleaned[: self.EXCEL_LABEL_MAX_LENGTH].rstrip()
            self._log_job(
                job_id,
                f"{context} label 길이 {len(cleaned)}자가 제한을 초과해 {len(shortened)}자로 잘랐습니다.",
                level="warning",
            )
            cleaned = shortened
        return cleaned

    def _escape_excel_formula_text(self, value: Any) -> str:
        return str(value or "").replace('"', '""')

    def _write_snapshot_hyperlink(
        self,
        target_cell: Any,
        *,
        address: str,
        display_name: str,
        row_number: int,
        job_id: str | None = None,
    ) -> None:
        try:
            target_cell.api.Hyperlinks.Add(
                Anchor=target_cell.api,
                Address=address,
                TextToDisplay=display_name,
            )
            return
        except Exception as exc:
            self._log_job(
                job_id,
                f"Snapshot hyperlink COM add failed(row={row_number}, label='{display_name}', address='{address}'): {exc}",
                level="warning",
            )

        formula = f'=HYPERLINK("{self._escape_excel_formula_text(address)}","{self._escape_excel_formula_text(display_name)}")'
        try:
            target_cell.formula = formula
            self._log_job(
                job_id,
                f"Snapshot hyperlink COM add failed and Excel formula fallback was used(row={row_number})",
                level="warning",
            )
            return
        except Exception as exc:
            self._log_job(
                job_id,
                f"Snapshot hyperlink formula fallback failed(row={row_number}, label='{display_name}', address='{address}'): {exc}",
                level="error",
            )
            raise RuntimeError(
                f"작업시나리오 hyperlink 추가 실패(row={row_number}, label='{display_name}', address='{address}'): {exc}"
            ) from exc

    def _display_name_for_result(self, result: dict[str, Any]) -> str:
        for candidate in [
            result.get("_hostname"),
            result.get("device_name"),
            result.get("_ip"),
            result.get("device_id"),
        ]:
            text = self._normalize_text_value(candidate)
            if text and text.upper() != self.NA_LABEL:
                return text
        return self.NA_LABEL

    def _log_device_source_diagnostics(self, job_id: str | None, runtime: _TargetRuntime) -> None:
        raw_variants = self.snapshot_repository.find_raw_device_variants(
            serial=runtime.serial,
            mgmt_ip=runtime.mgmt_ip,
            hostname=runtime.hostname,
        )
        if not raw_variants:
            self._log_job(
                job_id,
                f"{runtime.input_name}: raw source 변형을 찾지 못했습니다. merged device_id={runtime.device_id}, serial={runtime.serial or self.NA_LABEL}",
                level="warning",
            )
            return

        source_hosts: set[str] = set()
        variant_summaries: list[str] = []
        for item in raw_variants:
            cvp_source = self._normalize_text_value(item.get("cvp_source")) or self.NA_LABEL
            source_host = cvp_source.split(":", 1)[0].strip().lower()
            if source_host:
                source_hosts.add(source_host)
            config_file_path = self._normalize_text_value(item.get("config_file_path"))
            config_host = self.NA_LABEL
            if config_file_path:
                config_text = self._read_config_text({"file_path": config_file_path})
                extracted_host = self._extract_cvp_address(config_text)
                if extracted_host:
                    config_host = extracted_host
            variant_summaries.append(
                "source={source}, device_id={device_id}, hostname={hostname}, mgmt_ip={mgmt_ip}, config_cvp={config_cvp}".format(
                    source=cvp_source,
                    device_id=self._normalize_text_value(item.get("device_id")) or self.NA_LABEL,
                    hostname=self._normalize_text_value(item.get("hostname")) or self.NA_LABEL,
                    mgmt_ip=self._normalize_text_value(item.get("mgmt_ip")) or self.NA_LABEL,
                    config_cvp=config_host,
                )
            )

        self._log_job(
            job_id,
            f"{runtime.input_name}: raw source variants {len(raw_variants)}건 확인 -> " + " | ".join(variant_summaries),
        )

        if len(source_hosts) > 1:
            self._log_job(
                job_id,
                f"{runtime.input_name}: 같은 장비가 여러 CVP source에 존재합니다. merged_config_cvp={runtime.cvp_host}, raw_sources={sorted(source_hosts)}",
                level="warning",
            )

        if runtime.cvp_host.strip().lower() not in source_hosts and source_hosts:
            self._log_job(
                job_id,
                f"{runtime.input_name}: merged running-config에서 읽은 cvp_host={runtime.cvp_host} 가 raw source 집합 {sorted(source_hosts)} 와 일치하지 않습니다.",
                level="warning",
            )

    def _resolve_endpoint(self, cvp_host: str) -> CVPSourceEndpoint:
        normalized_host = self._extract_ipv4_address(cvp_host) or str(cvp_host or "").strip().split(":", 1)[0].strip()
        for source in getattr(self.settings, "cvp_sources", []):
            if source.host == normalized_host:
                return source
        return CVPSourceEndpoint(
            name=f"{normalized_host}:{self.settings.cvp_port}",
            host=normalized_host,
            port=int(getattr(self.settings, "cvp_port", 443) or 443),
        )

    def _open_rest_session(self, endpoint: CVPSourceEndpoint) -> tuple[requests.Session, str, str | bool]:
        username = str(getattr(self.settings, "cvp_username", "") or "").strip()
        password = str(getattr(self.settings, "cvp_password", "") or "").strip()
        token = str(getattr(self.settings, "cvp_token", "") or "").strip()
        if not token and not (username and password):
            raise RuntimeError("CVP 인증 정보가 설정되어 있지 않습니다.")

        verify = self._requests_verify()
        session = requests.Session()
        session.headers.update({"Accept": "application/json"})

        if not token:
            response = session.post(
                f"https://{endpoint.host}:{endpoint.port}/cvpservice/login/authenticate.do",
                auth=(username, password),
                verify=verify,
                timeout=self.REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
            token = str(payload.get("sessionId", "") or "").strip()
            if not token:
                raise RuntimeError("CVP 인증에 성공했지만 sessionId를 받지 못했습니다.")

        session.headers["Authorization"] = f"Bearer {token}"
        session.cookies.set("access_token", token)
        return session, token, verify

    def _requests_verify(self) -> str | bool:
        ca_file = str(getattr(self.settings, "cvp_ca_file", "") or "").strip()
        if ca_file:
            return ca_file
        return False

    def _resolve_serial(
        self,
        session: requests.Session,
        token: str,
        verify: str | bool,
        runtime: _TargetRuntime,
    ) -> str:
        inventory = self._request_json(
            session,
            token,
            verify,
            f"https://{runtime.endpoint.host}:{runtime.endpoint.port}/cvpservice/inventory/devices",
        )
        if not isinstance(inventory, list):
            if runtime.serial:
                return runtime.serial
            raise RuntimeError("CVP inventory 응답 형식이 올바르지 않습니다.")

        candidate_names = {
            runtime.hostname,
            runtime.input_name,
            runtime.device_id,
            runtime.serial,
            runtime.mgmt_ip,
        }
        for item in inventory:
            hostname = str(item.get("hostname") or "").strip()
            serial = str(item.get("serialNumber") or "").strip()
            mgmt_ip = str(item.get("ipAddress") or item.get("ipAddressString") or item.get("deviceIPAddress") or "").strip()
            if hostname in candidate_names or serial in candidate_names or mgmt_ip in candidate_names:
                return serial or runtime.serial

        if runtime.serial:
            return runtime.serial
        raise RuntimeError(f"{runtime.hostname or runtime.input_name} 장비의 serial을 찾을 수 없습니다.")

    def _request_json(
        self,
        session: requests.Session,
        token: str,
        verify: str | bool,
        url: str,
    ) -> Any:
        last_response: requests.Response | None = None
        attempts = [
            ({}, {}),
            ({"Authorization": f"Bearer {token}"}, {}),
            ({}, {"access_token": token}),
            ({"Authorization": f"Bearer {token}"}, {"access_token": token}),
        ]
        for headers, cookies in attempts:
            response = session.get(
                url,
                headers=headers or None,
                cookies=cookies or None,
                verify=verify,
                timeout=self.REQUEST_TIMEOUT,
            )
            last_response = response
            if response.ok:
                try:
                    return response.json()
                except ValueError as exc:
                    raise RuntimeError(f"JSON 응답 파싱에 실패했습니다: {url}") from exc
        status = last_response.status_code if last_response is not None else "unknown"
        body = last_response.text[:400] if last_response is not None else ""
        raise RuntimeError(f"HTTP {status}: {body}")

    def _execute_snapshot(
        self,
        endpoint: CVPSourceEndpoint,
        token: str,
        snapshot_template_id: str,
        serial: str,
    ) -> None:
        channel = self._create_grpc_channel(endpoint, token)
        try:
            change_control_id = str(uuid4())
            action_args = {
                self.SNAPSHOT_ACTION_ID: {
                    "TemplateID": snapshot_template_id,
                    "DeviceID": serial,
                }
            }
            timestamp = self._add_change_control(channel, change_control_id, action_args)
            self._approve_change_control(channel, change_control_id, timestamp)
            self._start_change_control(channel, change_control_id)
        finally:
            channel.close()

    def _create_grpc_channel(self, endpoint: CVPSourceEndpoint, token: str) -> grpc.Channel:
        root_certificates = self._read_root_certificates(endpoint)
        private_key = None
        certificate_chain = None
        cert_file = str(getattr(self.settings, "cvp_cert_file", "") or "").strip()
        key_file = str(getattr(self.settings, "cvp_key_file", "") or "").strip()
        if key_file:
            private_key = Path(key_file).read_bytes()
        if cert_file:
            certificate_chain = Path(cert_file).read_bytes()

        call_credentials = grpc.access_token_call_credentials(token)
        channel_credentials = grpc.ssl_channel_credentials(
            root_certificates=root_certificates,
            private_key=private_key,
            certificate_chain=certificate_chain,
        )
        connection_credentials = grpc.composite_channel_credentials(channel_credentials, call_credentials)
        return grpc.secure_channel(f"{endpoint.host}:{endpoint.port}", connection_credentials)

    def _load_changecontrol_modules(self) -> tuple[Any, Any, Any]:
        if self._changecontrol_modules is not None:
            return self._changecontrol_modules

        library_root = str(getattr(self.settings, "cvp_library_root", "") or "").strip()
        if not library_root:
            raise RuntimeError("CVP library root is not configured.")
        if library_root not in sys.path:
            sys.path.insert(0, library_root)

        from arista.changecontrol.v1 import models, services  # type: ignore
        from fmp import wrappers_pb2 as fmp_wrappers  # type: ignore

        self._changecontrol_modules = (models, services, fmp_wrappers)
        return self._changecontrol_modules

    def _read_root_certificates(self, endpoint: CVPSourceEndpoint) -> bytes:
        ca_file = str(getattr(self.settings, "cvp_ca_file", "") or "").strip()
        if ca_file:
            return Path(ca_file).read_bytes()
        return ssl.get_server_certificate((endpoint.host, endpoint.port)).encode("utf-8")

    def _add_change_control(
        self,
        channel: grpc.Channel,
        change_control_id: str,
        actions_and_args: dict[str, dict[str, str]],
    ) -> Any:
        models, services, fmp_wrappers = self._load_changecontrol_modules()
        root_stage_id = "stage-root"
        root_stage_rows = []
        stage_map: dict[str, models.StageConfig] = {}

        for action_id, args in actions_and_args.items():
            current_action_id = f"stage-action {action_id}"
            action = models.Action(
                name=wrappers.StringValue(value="snapshot"),
                args=fmp_wrappers.MapStringString(values=args),
            )
            root_stage_rows.append(fmp_wrappers.RepeatedString(values=[current_action_id]))
            stage_map[current_action_id] = models.StageConfig(
                name=wrappers.StringValue(value=f"Scheduled action {action_id}"),
                action=action,
            )

        stage_map[root_stage_id] = models.StageConfig(
            name=wrappers.StringValue(value="run_action script created change Root"),
            rows=models.RepeatedRepeatedString(values=root_stage_rows),
        )

        request = services.ChangeControlConfigSetRequest(
            value=models.ChangeControlConfig(
                key=models.ChangeControlKey(id=wrappers.StringValue(value=change_control_id)),
                change=models.ChangeConfig(
                    name=wrappers.StringValue(value="run_action script created change"),
                    root_stage_id=wrappers.StringValue(value=root_stage_id),
                    stages=models.StageConfigMap(values=stage_map),
                    notes=wrappers.StringValue(value="Created and managed by script"),
                ),
            )
        )
        response = services.ChangeControlConfigServiceStub(channel).Set(request, timeout=self.REQUEST_TIMEOUT)
        return response.time

    def _approve_change_control(self, channel: grpc.Channel, change_control_id: str, timestamp: Any) -> None:
        models, services, _fmp_wrappers = self._load_changecontrol_modules()
        request = services.ApproveConfigSetRequest(
            value=models.ApproveConfig(
                key=models.ChangeControlKey(id=wrappers.StringValue(value=change_control_id)),
                approve=models.FlagConfig(value=wrappers.BoolValue(value=True)),
                version=timestamp,
            )
        )
        services.ApproveConfigServiceStub(channel).Set(request, timeout=self.REQUEST_TIMEOUT)

    def _start_change_control(self, channel: grpc.Channel, change_control_id: str) -> None:
        models, services, _fmp_wrappers = self._load_changecontrol_modules()
        request = services.ChangeControlConfigSetRequest(
            value=models.ChangeControlConfig(
                key=models.ChangeControlKey(id=wrappers.StringValue(value=change_control_id)),
                start=models.FlagConfig(value=wrappers.BoolValue(value=True)),
            )
        )
        services.ChangeControlConfigServiceStub(channel).Set(request, timeout=self.REQUEST_TIMEOUT)

    def _extract_snapshot_outputs(
        self,
        snapshot_status: dict[str, Any],
        snapshot_id: str,
        project_name: str,
        device_name: str,
        job_id: str | None = None,
    ) -> dict[str, str]:
        notifications = snapshot_status.get("notifications") or []
        command_map: dict[str, str] = {}
        chunk_map: dict[str, dict[int, str]] = {}

        for notification in notifications:
            updates = notification.get("updates") or {}
            output_list = (((updates.get(snapshot_id) or {}).get("value") or {}).get("Output")) or []
            for item in output_list:
                command = str(item.get("Command") or "").strip()
                result_key = str(item.get("Result") or "").strip()
                parts = result_key.split("_")
                if command and len(parts) > 1:
                    command_map[parts[1]] = self._sanitize_command_filename(command)

        pattern = re.compile(rf"^{re.escape(snapshot_id)}Output_(.+)_(\d+)$")
        for notification in notifications:
            updates = notification.get("updates") or {}
            for raw_key, raw_value in updates.items():
                match = pattern.match(str(raw_key))
                if not match:
                    continue
                command_key = match.group(1)
                index = int(match.group(2))
                value = str((raw_value or {}).get("value") or "")
                chunk_map.setdefault(command_key, {})[index] = value

        if job_id:
            output_dir = (
                self._job_snapshot_output_dir(job_id)
                / self._safe_segment(project_name)
                / f"{self._safe_segment(device_name)}_{self.STEP_LABEL}"
            )
        else:
            output_dir = self._workplan_result_root() / self._safe_segment(project_name) / f"{self._safe_segment(device_name)}_{self.STEP_LABEL}"
        output_dir.mkdir(parents=True, exist_ok=True)

        outputs: dict[str, str] = {}
        for command_key, parts in sorted(chunk_map.items(), key=lambda item: self._natural_sort_key(item[0])):
            filename = command_map.get(command_key, command_key)
            content = "".join(parts[index] for index in sorted(parts))
            if filename in outputs:
                outputs[filename] = outputs[filename] + content
            else:
                outputs[filename] = content
            (output_dir / f"{filename}.txt").write_text(outputs[filename], encoding="utf-8")

        return outputs

    def _parse_snapshot_outputs(self, outputs: dict[str, str], step: str) -> dict[str, Any]:
        result: dict[str, Any] = {"단계": step}
        if not outputs:
            return result

        for filename, content in outputs.items():
            filename_lower = filename.lower()

            if "show hostname" in filename_lower:
                for line in content.splitlines():
                    if "Hostname" in line:
                        result["_hostname"] = line.split(":")[-1].strip()

            elif "show ip interface brief" in filename_lower:
                ip = ""
                for line in content.splitlines():
                    if "Management0" in line or "Management1" in line:
                        parts = line.split()
                        if len(parts) >= 2:
                            ip_with_mask = parts[1]
                            ip = ip_with_mask.split("/")[0]
                            result["_ip"] = ip
                            break
                if ip == "unassigned":
                    result["_ip"] = "확인 필요"

            elif "show version" in filename_lower:
                total_mem = 0
                free_mem = 0
                for line in content.splitlines():
                    if "Software image version" in line:
                        version = line.split(":")[-1].strip()
                        result["_version"] = version
                        result["comp_ver"] = "O" if version == "4.34.4M" else "X"
                    elif "Arista" in line:
                        result["_model"] = line.split(" ")[-1].strip()
                        result["_vendor"] = "Arista EOS"
                    elif "Total memory" in line:
                        try:
                            total_mem = int(line.split()[-2])
                        except (IndexError, ValueError):
                            total_mem = 0
                    elif "Free memory" in line:
                        try:
                            free_mem = int(line.split()[-2])
                        except (IndexError, ValueError):
                            free_mem = 0
                        if total_mem > 0:
                            result["mem"] = f"{round((total_mem - free_mem) / total_mem * 100, 2)}%"
                    elif "Serial number" in line:
                        result["serial"] = line.split(":")[-1].strip()

            elif "show processes top once" in filename_lower:
                lines = content.splitlines()
                if lines:
                    parts = lines[0].split()
                    if len(parts) >= 8:
                        cpu_data = parts[7]
                        if cpu_data == "100.0":
                            result["cpu"] = "0%"
                        else:
                            try:
                                result["cpu"] = f"{round(100 - float(cpu_data), 3)}%"
                            except ValueError:
                                pass

            elif "show system environment all" in filename_lower:
                tem_check = ""
                fan_check = ""
                pwr_check = ""
                for line in content.splitlines():
                    if "System temperature status is:" in line:
                        tem_check = line.split(" ")[-1]
                    elif "System cooling status is:" in line:
                        fan_check = line.split(" ")[-1]
                    elif "PWR-" in line:
                        parts = line.split()
                        if len(parts) >= 7:
                            pwr_check = parts[6]
                result["environment"] = "OK" if tem_check == "Ok" and fan_check == "Ok" and pwr_check == "Ok" else "NOK"

            elif "show module" in filename_lower:
                for line in content.splitlines():
                    if "Status" in line:
                        mod = line.split(" ")[-1]
                        if "ok" or "active" or "standby" in mod:
                            result["module"] = "OK"
                        else:
                            result["module"] = "NOK"
                            break
                    elif "Not Support" in line:
                        result["module"] = "N/A"

            elif "show uptime" in filename_lower:
                parts = content.split()
                if len(parts) >= 5:
                    result["uptime"] = f"{parts[2]} {parts[3]} {parts[4].rstrip(',')}"

            elif "show clock" in filename_lower:
                lines = content.splitlines()
                if lines:
                    result["_device_time"] = f"{lines[0]} / KST"

            elif "show interfaces status connected" in filename_lower:
                interface_count = 0
                port_channel = "N/A"
                for index, line in enumerate(content.splitlines()):
                    if index < 1:
                        continue
                    interface_hits = line.count("Et")
                    connected_hits = line.count("connected")
                    port_channel_hits = line.count("Po")
                    if interface_hits == 1 or interface_hits == 2:
                        if connected_hits == 1:
                            interface_count += 1
                    elif port_channel_hits == 1 or port_channel_hits == 2:
                        port_channel = "OK" if connected_hits == 1 else "NOK"
                    else:
                        continue
                    result["Interface"] = interface_count
                    result["Port-Channel"] = port_channel

            elif "show interfaces transceiver detail" in filename_lower:
                for line in content.splitlines():
                    if "Et" not in line:
                        continue
                    parts = line.split()
                    if len(parts) < 6:
                        continue
                    current = parts[1].strip("-")
                    high_warm_alarm = parts[3].strip("-")
                    low_warm_alarm = parts[5].strip("-")
                    if current == "N/A" or high_warm_alarm == "N/A" or low_warm_alarm == "N/A":
                        continue
                    try:
                        current_value = float(current)
                        high_value = float(high_warm_alarm)
                        low_value = float(low_warm_alarm)
                    except ValueError:
                        continue
                    result["Transceiver"] = "NOK" if low_value < current_value and high_value < current_value else "OK"

            elif "show mlag detail" in filename_lower:
                mlag_stat = None
                mlag_partial = None
                mlag_full = None
                for line in content.splitlines():
                    if "peer-config" in line:
                        mlag_stat = line.split()[-1].strip()
                    elif "Active-partial" in line:
                        mlag_partial = line.split()[-1].strip()
                    elif "Active-full" in line:
                        mlag_full = line.split()[-1].strip()
                    elif "0.0.0.0" in line:
                        result["Mlag"] = "N/A"
                        break
                    if "consistent" == mlag_stat:
                        result["Mlag"] = f"Partial: {mlag_partial}, Full: {mlag_full}"
                    else:
                        result["Mlag"] = "NOK"

            elif "show ip ospf neighbor vrf all" in filename_lower:
                ospf_vrf_list: dict[str, int] = {}
                ospf_neighbor = ""
                for line in content.splitlines():
                    ospf_list = line.split()
                    if len(ospf_list) < 3:
                        continue
                    ospf_vrf = ospf_list[2]
                    if "FULL" in line:
                        ospf_vrf_list[ospf_vrf] = ospf_vrf_list.get(ospf_vrf, 0) + 1
                for index, vrf in enumerate(ospf_vrf_list.keys()):
                    if index == 0 and vrf == "default":
                        ospf_neighbor = f"vrf {vrf}: {ospf_vrf_list.get(vrf)}"
                    else:
                        ospf_neighbor += f", vrf {vrf}: {ospf_vrf_list.get(vrf)}"
                result["OSPF Neighbor"] = "N/A" if not content.splitlines() else ospf_neighbor

            elif "show ip bgp" in filename_lower:
                bgp_vrf_list: dict[str, int] = {}
                bgp_neighbor = ""
                bgp_vrf = "default"
                for line in content.splitlines():
                    bgp_list = line.split()
                    if "VRF" in line and len(bgp_list) >= 6:
                        bgp_vrf = bgp_list[5]
                    elif "Estab" in line:
                        bgp_vrf_list[bgp_vrf] = bgp_vrf_list.get(bgp_vrf, 0) + 1
                if "default" not in bgp_vrf_list:
                    bgp_vrf_list["default"] = 0
                for vrf in bgp_vrf_list.keys():
                    if vrf:
                        bgp_neighbor += f"vrf {vrf}: {bgp_vrf_list.get(vrf)}, "
                    elif "default" in vrf:
                        bgp_neighbor = f"vrf {vrf}: {bgp_vrf_list.get(vrf)}"
                    else:
                        bgp_neighbor = "N/A"
                result["BGP Neighbor"] = "N/A" if not content.splitlines() else bgp_neighbor

            elif "show ip route vrf all summary" in filename_lower:
                route_vrf_list: dict[str, int] = {}
                route_count = ""
                default_route_count = ""
                route_vrf = "default"
                vrf_int_count = 0
                vrf_att_count = 0
                for line in content.splitlines():
                    route_list = line.split()
                    if "VRF" in line and len(route_list) >= 2:
                        route_vrf = route_list[1]
                    elif "internal" in line and len(route_list) >= 2:
                        try:
                            vrf_int_count = int(route_list[1])
                        except ValueError:
                            vrf_int_count = 0
                    elif "attached" in line and len(route_list) >= 2:
                        try:
                            vrf_att_count = int(route_list[1])
                        except ValueError:
                            vrf_att_count = 0
                    elif "Total Routes" in line and len(route_list) >= 3:
                        try:
                            vrf_total_count = int(route_list[2])
                        except ValueError:
                            vrf_total_count = 0
                        route_vrf_list[route_vrf] = vrf_total_count - (vrf_int_count + vrf_att_count)
                for vrf in route_vrf_list.keys():
                    if vrf == "default":
                        default_route_count = f"vrf {vrf}: {route_vrf_list.get(vrf)}"
                    else:
                        route_count += f", vrf {vrf}: {route_vrf_list.get(vrf)}"
                result["Route"] = default_route_count + route_count

            elif "show logging threshold warnings" in filename_lower:
                for line in content.splitlines():
                    if len(line) > 2:
                        result["LOG"] = "NOK"
                    else:
                        result["LOG"] = "OK"

            elif "show interfaces counters rates" in filename_lower:
                traffic_ok = True
                for line in content.splitlines():
                    line_parts = line.split()
                    if len(line_parts) < 8:
                        continue
                    for value in (line_parts[4], line_parts[7]):
                        if "%" in value:
                            try:
                                if float(value.replace("%", "")) > 45.0:
                                    traffic_ok = False
                            except ValueError:
                                continue
                result["Traffic (50% ↓)"] = "OK" if traffic_ok else "NOK"

            elif "show lldp neighbors" in filename_lower:
                count = 0
                for line in content.splitlines():
                    et_count = line.count("Et")
                    ma_count = line.count("Ma")
                    if et_count == 1 or et_count:
                        count += 1
                    elif ma_count == 1:
                        count += 1
                        break
                    else:
                        result["lldp"] = "N/A"
                result["lldp"] = count

            elif "show running-config" in filename_lower:
                running_config = ""
                for line in content.splitlines():
                    running_config += f"{line.strip()}\n"
                parsed_cvpaddr = self._extract_cvp_address(running_config)
                if parsed_cvpaddr:
                    result["cvpaddr"] = parsed_cvpaddr
                result["running-config"] = running_config

        return result

    def _render_workbook_stream(self, project_name: str, results: list[dict[str, Any]], job_id: str | None = None) -> BytesIO:
        temp_dir = self._workplan_result_root() / "temp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_path = temp_dir / f"{uuid4().hex}.xlsx"
        try:
            self._write_workbook_file(temp_path, project_name, results, job_id=job_id)
            return BytesIO(temp_path.read_bytes())
        finally:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def _write_workbook_file(self, output_path: Path, project_name: str, results: list[dict[str, Any]], job_id: str | None = None) -> None:
        xw = self._load_xlwings()
        with self._excel_lock:
            app = None
            workbook = None
            try:
                try:
                    app = xw.App(visible=False, add_book=False)
                except Exception as exc:
                    raise RuntimeError("Microsoft Excel이 설치되어 있지 않거나 COM 등록이 되어 있지 않습니다.") from exc
                app.display_alerts = False
                app.screen_updating = False
                workbook, using_template = self._open_or_create_workbook(app)
                self._populate_workbook(workbook, project_name, results, using_template, job_id=job_id)
                workbook.save(str(output_path))
            except Exception as exc:
                raise RuntimeError(f"xlwings 작업계획서 저장에 실패했습니다: {exc}") from exc
            finally:
                if workbook is not None:
                    workbook.close()
                if app is not None:
                    app.quit()

    def _populate_workbook_legacy(
        self,
        workbook: Any,
        project_name: str,
        results: list[dict[str, Any]],
        using_template: bool,
        job_id: str | None = None,
    ) -> None:
        device_names = [self._display_name_for_result(item) for item in results]
        links = self._build_snapshot_links(results, job_id=job_id)

        if not using_template:
            self._prepare_blank_workbook(workbook)

        change_sheet = workbook.sheets[self.CHANGE_OVERVIEW_SHEET]
        check_sheet = workbook.sheets[self.CHECK_SHEET]
        config_sheet = workbook.sheets[self.CONFIG_SHEET]
        scenario_sheet = workbook.sheets[self.SCENARIO_SHEET]

        change_sheet.range("D7").value = "\n".join(device_names)
        self._log_job(job_id, f"엑셀 변경개요 시트 작성: device_count={len(device_names)}")

        before_row = 6
        after_row = 7
        for _ in range(max(0, len(results) - 1)):
            check_sheet.range("6:7").api.Copy()
            check_sheet.api.Rows("8:9").Insert()
        for device_name in device_names:
            check_sheet.range(f"B{before_row}:B{after_row}").value = device_name
            before_row += 2
            after_row += 2
        before_row = 6
        after_row = 7
        for result in results:
            row_values = [result.get(column, self.NA_LABEL) for column in self.CHECK_COLUMNS]
            start_cell = f"C{before_row}" if self.STEP_LABEL == "작업 전" else f"C{after_row}"
            check_sheet.range(start_cell).value = row_values
            if self.STEP_LABEL == "작업 전":
                before_row += 2
            else:
                after_row += 2
        self._log_job(job_id, "엑셀 Check 시트 작성 완료")

        for _ in range(max(0, len(device_names) - 1)):
            config_sheet.range("B:G").api.Copy()
            config_sheet.api.Columns("H:H").Insert()
        config_headers: list[str] = []
        for device_name in device_names:
            config_headers.extend([f"{device_name} 작업 전", "Compare", f"{device_name} 작업 후", "o/x", "비고", ""])
        config_sheet.range("B2").value = [config_headers]
        for index, result in enumerate(results):
            config_lines = [[line.strip()] for line in str(result.get("running-config") or "").splitlines()]
            config_column = index * 6 + (2 if self.STEP_LABEL == "작업 전" else 3)
            target_range = config_sheet.range((3, config_column))
            target_range.value = config_lines
            target_range.api.WrapText = True
        self._log_job(job_id, "엑셀 Config 검증 시트 작성 완료")

        scenario_row = 16
        mgmt_list = [self._normalize_text_value(item.get("_ip")) or self.NA_LABEL for item in results]
        for _ in range(max(0, len(device_names) - 1)):
            scenario_sheet.range("16:16").api.Copy()
            scenario_sheet.api.Rows("17:17").Insert()
        for index, device_name in enumerate(device_names):
            scenario_sheet.range(f"D{scenario_row}").value = device_name
            scenario_sheet.range(f"E{scenario_row}").value = mgmt_list[index] if index < len(mgmt_list) else ""
            scenario_row += 1
        if scenario_row > 17:
            scenario_sheet.range(f"B16:B{scenario_row - 1}").api.Merge()
            scenario_sheet.range(f"C16:C{scenario_row - 1}").api.Merge()
            scenario_sheet.range(f"F16:F{scenario_row - 1}").api.Merge()

        link_start_row = len(results) + self.SNAPSHOT_LINK_BASE_ROW
        for _ in range(max(0, len(device_names) - 1)):
            scenario_sheet.range(f"{link_start_row}:{link_start_row}").api.Copy()
            scenario_sheet.api.Rows(f"{link_start_row + 1}:{link_start_row + 1}").Insert()
        for index, (address, display_name) in enumerate(links):
            target_cell = scenario_sheet.range(f"F{link_start_row + index}")
            self._log_job(
                job_id,
                f"Snapshot hyperlink 추가: row={link_start_row + index}, label_length={len(display_name)}, address={address}",
            )
            try:
                target_cell.api.Hyperlinks.Add(
                    Anchor=target_cell.api,
                    Address=address,
                    TextToDisplay=display_name,
                )
            except Exception as exc:
                raise RuntimeError(
                    f"작업시나리오 hyperlink 추가 실패(row={link_start_row + index}, label='{display_name}', address='{address}'): {exc}"
                ) from exc
        scenario_sheet.range(f"15:{scenario_row}").api.Copy()
        scenario_sheet.api.Rows(f"{link_start_row + len(links) + 3}:{link_start_row + len(links) + 3}").Insert()
        self._log_job(job_id, "엑셀 작업시나리오 시트 작성 완료")

    def _build_snapshot_links_legacy(self, results: list[dict[str, Any]], job_id: str | None = None) -> list[tuple[str, str]]:
        links: list[tuple[str, str]] = []
        for item in results:
            serial = self._normalize_text_value(item.get("serial"))
            cvpaddr = self._normalize_text_value(item.get("cvpaddr"))
            hostname = self._display_name_for_result(item)
            if self._is_na_marker(serial) or self._is_na_marker(cvpaddr):
                self._log_job(
                    job_id,
                    f"{hostname}: snapshot 링크 생성을 건너뜁니다. serial={serial or self.NA_LABEL}, cvpaddr={cvpaddr or self.NA_LABEL}",
                    level="warning",
                )
                continue
            display_name = self._normalize_excel_label(
                f"{hostname} {self.STEP_LABEL} 스냅샷 비교",
                fallback=f"{hostname} 스냅샷 비교",
                job_id=job_id,
                context=hostname,
            )
            links.append(
                (
                    f"https://{cvpaddr}/cv/comparison/snapshots/{serial}/{serial}",
                    display_name,
                )
            )
        return links

    def _prepare_blank_workbook(self, workbook: Any) -> None:
        overview = workbook.sheets[self.CHANGE_OVERVIEW_SHEET]
        check = workbook.sheets[self.CHECK_SHEET]
        config = workbook.sheets[self.CONFIG_SHEET]
        scenario = workbook.sheets[self.SCENARIO_SHEET]

        overview.range("B2").value = "작업 계획서 초안"
        overview.range("D7").value = ""

        check.range("B5").value = "대상장비"
        check.range("C5").value = [self.CHECK_COLUMNS]
        check.range("B6").value = ""
        check.range("B7").value = ""

        config.range("B2").value = ""

        scenario.range("B15:F15").value = [["구분", "단계", "대상장비", "관리 IP", "CVP Snapshot"]]
        scenario.range("B16").value = "사전 확인"
        scenario.range("C16").value = self.STEP_LABEL
        scenario.range("D16").value = ""
        scenario.range("E16").value = ""

    def _load_xlwings(self) -> Any:
        try:
            import xlwings as xw
        except ImportError as exc:
            raise RuntimeError("xlwings가 설치되어 있지 않아 작업계획서 xlsx를 생성할 수 없습니다.") from exc
        return xw

    def _open_or_create_workbook(self, app: Any) -> tuple[Any, bool]:
        template_path = Path(self.settings.workplan_template_path)
        if template_path.exists() and template_path.is_file():
            workbook = app.books.open(str(template_path))
            self._validate_template(workbook, template_path)
            return workbook, True

        workbook = app.books.add()
        self._ensure_blank_sheets(workbook)
        return workbook, False

    def _ensure_blank_sheets(self, workbook: Any) -> None:
        required_names = [
            self.CHANGE_OVERVIEW_SHEET,
            self.CHECK_SHEET,
            self.CONFIG_SHEET,
            self.SCENARIO_SHEET,
        ]
        existing_count = len(workbook.sheets)
        for index in range(existing_count):
            workbook.sheets[index].name = f"_workplan_tmp_{index + 1}_{uuid4().hex[:8]}"
        while len(workbook.sheets) < len(required_names):
            workbook.sheets.add(after=workbook.sheets[len(workbook.sheets) - 1])
        while len(workbook.sheets) > len(required_names):
            workbook.sheets[len(workbook.sheets) - 1].delete()
        for index, sheet_name in enumerate(required_names):
            workbook.sheets[index].name = sheet_name

    def _validate_template(self, workbook: Any, template_path: Path) -> None:
        sheet_names = {sheet.name for sheet in workbook.sheets}
        missing = [
            sheet_name
            for sheet_name in [
                self.CHANGE_OVERVIEW_SHEET,
                self.CHECK_SHEET,
                self.CONFIG_SHEET,
                self.SCENARIO_SHEET,
            ]
            if sheet_name not in sheet_names
        ]
        if missing:
            raise RuntimeError(
                f"작업계획서 템플릿에 필요한 시트가 없습니다: {', '.join(missing)} ({template_path})"
            )

    def _build_snapshot_archive(self, source_root: Path, archive_path: Path) -> Path:
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as archive:
            for file_path in sorted(source_root.rglob("*")):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(source_root))
        return archive_path

    def _workplan_result_root(self) -> Path:
        root = Path(self.settings.backend_dir) / "data" / self.RESULT_ROOT_NAME
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _read_config_text(self, metadata: dict[str, Any] | None) -> str:
        if not metadata:
            return ""
        file_path = Path(str(metadata.get("file_path") or "").strip())
        if not file_path.exists() or not file_path.is_file():
            return ""
        return file_path.read_text(encoding="utf-8", errors="ignore")

    def _extract_cvp_address(self, config_text: str) -> str:
        if not config_text:
            return ""
        for line in config_text.splitlines():
            if "-cvaddr=" in line:
                extracted = self._extract_ipv4_address(line.split("-cvaddr=", 1)[1])
                if extracted:
                    return extracted
            if "Cluster.addr" in line:
                for cluster_key, cluster_host in self.LEGACY_CLUSTER_ADDR_MAP.items():
                    if cluster_key in line:
                        return cluster_host
                extracted = self._extract_ipv4_address(line)
                if extracted:
                    return extracted
        return ""

    def _resolve_snapshot_template_id(self, cvp_host: str) -> str:
        normalized_host = self._extract_ipv4_address(cvp_host) or str(cvp_host or "").strip()
        if normalized_host:
            normalized_host = normalized_host.split(":", 1)[0].strip()
        snapshot_map = getattr(self.settings, "workplan_snapshot_template_map", {}) or {}
        if normalized_host and normalized_host in snapshot_map:
            return str(snapshot_map[normalized_host]).strip()
        return str(getattr(self.settings, "workplan_snapshot_template_default", "")).strip()

    def _natural_sort_key(self, value: str) -> list[Any]:
        return [int(text) if text.isdigit() else text.lower() for text in re.split(r"([0-9]+)", value)]

    def _sanitize_command_filename(self, command: str) -> str:
        sanitized = command.replace("|", " ")
        sanitized = sanitized.replace('"', " ")
        sanitized = sanitized.replace(">", " ")
        sanitized = sanitized.replace("/", " ")
        sanitized = sanitized.replace("\\", " ")
        sanitized = re.sub(r"\s+", " ", sanitized).strip()
        return sanitized or "command"

    def _safe_segment(self, value: str) -> str:
        sanitized = re.sub(r'[\\/:*?"<>|]+', "_", str(value or "").strip())
        return sanitized or "unnamed"

    def _sanitize_filename(self, raw_name: str) -> str:
        sanitized = re.sub(r'[\\/:*?"<>|]+', "_", raw_name).strip()
        return sanitized or "workplan.xlsx"

    def _populate_workbook(
        self,
        workbook: Any,
        project_name: str,
        results: list[dict[str, Any]],
        using_template: bool,
        job_id: str | None = None,
    ) -> None:
        device_names = [self._display_name_for_result(item) for item in results]
        links = self._build_snapshot_links(results, job_id=job_id)

        if not using_template:
            self._prepare_blank_workbook(workbook)

        change_sheet = workbook.sheets[self.CHANGE_OVERVIEW_SHEET]
        check_sheet = workbook.sheets[self.CHECK_SHEET]
        config_sheet = workbook.sheets[self.CONFIG_SHEET]
        scenario_sheet = workbook.sheets[self.SCENARIO_SHEET]

        change_sheet.range("D7").value = "\n".join(device_names)
        self._log_job(job_id, f"Workbook overview sheet populated: device_count={len(device_names)}")

        before_row = 6
        after_row = 7
        for _ in range(max(0, len(results) - 1)):
            check_sheet.range("6:7").api.Copy()
            check_sheet.api.Rows("8:9").Insert()
        for device_name in device_names:
            check_sheet.range(f"B{before_row}:B{after_row}").value = device_name
            before_row += 2
            after_row += 2
        before_row = 6
        for result in results:
            row_values = [result.get(column, self.NA_LABEL) for column in self.CHECK_COLUMNS]
            check_sheet.range(f"C{before_row}").value = row_values
            before_row += 2
        self._log_job(job_id, "Workbook check sheet populated")

        for _ in range(max(0, len(device_names) - 1)):
            config_sheet.range("B:G").api.Copy()
            config_sheet.api.Columns("H:H").Insert()
        config_headers: list[str] = []
        for device_name in device_names:
            config_headers.extend([f"{device_name} {self.STEP_LABEL}", "Compare", f"{device_name} {self.STEP_LABEL}", "o/x", "비고", ""])
        config_sheet.range("B2").value = [config_headers]
        for index, result in enumerate(results):
            config_lines = [[line.strip()] for line in str(result.get("running-config") or "").splitlines()]
            config_column = index * 6 + 2
            target_range = config_sheet.range((3, config_column))
            target_range.value = config_lines
            target_range.api.WrapText = True
        self._log_job(job_id, "Workbook config sheet populated")

        scenario_row = 16
        mgmt_list = [self._normalize_text_value(item.get("_ip")) or self.NA_LABEL for item in results]
        for _ in range(max(0, len(device_names) - 1)):
            scenario_sheet.range("16:16").api.Copy()
            scenario_sheet.api.Rows("17:17").Insert()
        for index, device_name in enumerate(device_names):
            scenario_sheet.range(f"D{scenario_row}").value = device_name
            scenario_sheet.range(f"E{scenario_row}").value = mgmt_list[index] if index < len(mgmt_list) else ""
            scenario_row += 1
        if scenario_row > 17:
            scenario_sheet.range(f"B16:B{scenario_row - 1}").api.Merge()
            scenario_sheet.range(f"C16:C{scenario_row - 1}").api.Merge()
            scenario_sheet.range(f"F16:F{scenario_row - 1}").api.Merge()

        link_start_row = len(results) + self.SNAPSHOT_LINK_BASE_ROW
        for _ in range(max(0, len(device_names) - 1)):
            scenario_sheet.range(f"{link_start_row}:{link_start_row}").api.Copy()
            scenario_sheet.api.Rows(f"{link_start_row + 1}:{link_start_row + 1}").Insert()
        for index, (address, display_name) in enumerate(links):
            row_number = link_start_row + index
            target_cell = scenario_sheet.range(f"F{row_number}")
            self._log_job(
                job_id,
                f"Snapshot hyperlink add: row={row_number}, label_length={len(display_name)}, address={address}",
            )
            self._write_snapshot_hyperlink(
                target_cell,
                address=address,
                display_name=display_name,
                row_number=row_number,
                job_id=job_id,
            )
        scenario_sheet.range(f"15:{scenario_row}").api.Copy()
        scenario_sheet.api.Rows(f"{link_start_row + len(links) + 3}:{link_start_row + len(links) + 3}").Insert()
        self._log_job(job_id, "Workbook scenario sheet populated")

    def _build_snapshot_links(self, results: list[dict[str, Any]], job_id: str | None = None) -> list[tuple[str, str]]:
        link_map: dict[str, str] = {}
        for item in results:
            serial = self._normalize_text_value(item.get("serial"))
            cvpaddr = self._normalize_text_value(item.get("cvpaddr"))
            hostname = self._display_name_for_result(item)
            if self._is_na_marker(serial) or self._is_na_marker(cvpaddr):
                self._log_job(
                    job_id,
                    f"{hostname}: snapshot link skipped because serial or cvpaddr is missing. serial={serial or self.NA_LABEL}, cvpaddr={cvpaddr or self.NA_LABEL}",
                    level="warning",
                )
                continue
            display_name = self._normalize_excel_label(
                f"{hostname} {self.STEP_LABEL} \uC2A4\uB0C5\uC0F7 \uBE44\uAD50",
                fallback=f"{hostname} \uC2A4\uB0C5\uC0F7 \uBE44\uAD50",
                job_id=job_id,
                context=hostname,
            )
            address = f"https://{cvpaddr}/cv/comparison/snapshots/{serial}/{serial}"
            if address in link_map:
                self._log_job(
                    job_id,
                    f"{hostname}: duplicate snapshot hyperlink detected and overwritten for original behavior. address={address}",
                    level="warning",
                )
            link_map[address] = display_name
        return list(link_map.items())
