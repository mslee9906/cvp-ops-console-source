from __future__ import annotations

from base64 import b64decode
from binascii import Error as BinasciiError
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import json
import re
import shutil
import time
from threading import Thread
from typing import Any
from uuid import uuid4

from app.services.workplan_service import WorkPlanService, _TargetRuntime


class WorkPlanRuntimeService(WorkPlanService):
    def _normalize_step_label(self, value: Any) -> str:
        return "작업 후" if str(value or "").strip() == "작업 후" else "작업 전"

    def _step_key(self, step_label: str) -> str:
        return "after" if self._normalize_step_label(step_label) == "작업 후" else "before"

    def start_export_job(self, card_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        card = self.kanban_service.get_card(card_id) or {}
        project_name = str(payload.get("project_name") or card.get("title") or card.get("card_code") or "").strip()
        step_label = self._normalize_step_label(payload.get("step_label"))
        now = self._now_iso()
        job_id = uuid4().hex
        payload_copy = dict(payload)
        payload_copy["step_label"] = step_label

        source_workbook_name = ""
        if str(payload.get("source_workbook_base64") or "").strip():
            uploaded_path, source_workbook_name = self._save_uploaded_workbook(job_id, payload)
            payload_copy["source_workbook_path"] = str(uploaded_path)
            payload_copy["source_workbook_name"] = source_workbook_name
        elif step_label == "작업 후":
            raise ValueError("작업 후 작업계획서는 기존 작업계획서 xlsx 업로드가 필요합니다.")

        job_state = {
            "job_id": job_id,
            "card_id": card_id,
            "project_name": project_name,
            "step_label": step_label,
            "status": "queued",
            "progress_percent": 1,
            "step": "queued",
            "detail": "작업 계획서 생성 대기 중입니다.",
            "started_at": now,
            "updated_at": now,
            "finished_at": "",
            "filename": "",
            "error_message": "",
            "download_ready": False,
            "result_path": "",
            "source_workbook_name": source_workbook_name,
        }

        worker = Thread(target=self._run_export_job, args=(job_id, card_id, payload_copy), daemon=True)
        with self._job_lock:
            self._jobs[job_id] = job_state
            self._job_threads[job_id] = worker
        self._log_job(job_id, f"workplan job created: card_id={card_id}, project_name={project_name or '(empty)'}, step_label={step_label}")
        worker.start()
        return self.get_job_progress(job_id)

    def _run_export_job(self, job_id: str, card_id: int, payload: dict[str, Any]) -> None:
        try:
            step_label = self._normalize_step_label(payload.get("step_label"))
            self._set_job_progress(
                job_id,
                status="running",
                progress_percent=2,
                step="prepare",
                step_label=step_label,
                detail="작업 계획서 생성을 시작합니다.",
            )
            self._log_job(job_id, f"workplan generation started: card_id={card_id}, step_label={step_label}")
            stream, filename, project_name = self._generate_workbook(card_id, payload, job_id=job_id)
            output_dir = self._job_output_dir(job_id)
            result_path = output_dir / (filename or f"{job_id}.xlsx")
            with result_path.open("wb") as file_handle:
                file_handle.write(stream.getvalue())
            self._sync_job_artifacts_to_evidence(
                job_id=job_id,
                card_id=card_id,
                project_name=project_name,
                step_label=step_label,
                workbook_path=result_path,
                source_workbook_path=Path(str(payload.get("source_workbook_path") or "").strip()) if payload.get("source_workbook_path") else None,
            )
            finished_at = self._now_iso()
            self._log_job(job_id, f"workplan generation completed: filename={filename}, result_path={result_path}")
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
                step_label=step_label,
            )
        except Exception as exc:
            finished_at = self._now_iso()
            self._log_job(job_id, f"workplan generation failed: {exc}", level="error")
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
        step_label = self._normalize_step_label(payload.get("step_label"))
        source_workbook_path = Path(str(payload.get("source_workbook_path") or "").strip()) if payload.get("source_workbook_path") else None
        if not project_name:
            project_name = f"작업계획서_{card_id}"
        if step_label == "작업 후":
            if not source_workbook_path:
                raise ValueError("작업 후 작업계획서는 기존 작업계획서 xlsx 업로드가 필요합니다.")
            if not source_workbook_path.exists() or not source_workbook_path.is_file():
                raise ValueError("업로드한 작업계획서 파일을 찾을 수 없습니다.")

        self._set_job_progress(
            job_id,
            card_id=card_id,
            project_name=project_name,
            step_label=step_label,
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
            results.append(
                self._collect_target_result(
                    target,
                    project_name,
                    step_label=step_label,
                    progress_callback=progress_callback,
                    job_id=job_id,
                )
            )

        self._set_job_progress(job_id, progress_percent=88, step="template", detail="작업 계획서 워크북을 준비하는 중입니다.")
        self._set_job_progress(job_id, progress_percent=94, step="workbook", detail="시트에 수집 결과를 채우는 중입니다.")
        self._set_job_progress(job_id, progress_percent=98, step="save", detail="xlsx 파일을 저장하는 중입니다.")
        stream = self._render_workbook_stream(
            project_name,
            results,
            step_label=step_label,
            source_workbook_path=source_workbook_path,
            job_id=job_id,
        )
        filename = self._sanitize_filename(f"{step_label}_{project_name}.xlsx")
        return stream, filename, project_name

    def _save_uploaded_workbook(self, job_id: str, payload: dict[str, Any]) -> tuple[Path, str]:
        source_name = self._sanitize_filename(str(payload.get("source_workbook_name") or "uploaded_workplan.xlsx"))
        encoded = str(payload.get("source_workbook_base64") or "").strip()
        if encoded.lower().startswith("data:") and "," in encoded:
            encoded = encoded.split(",", 1)[1]
        try:
            content = b64decode(encoded, validate=True)
        except (BinasciiError, ValueError) as exc:
            raise ValueError("업로드한 작업계획서 파일을 해석하지 못했습니다.") from exc
        if not content:
            raise ValueError("업로드한 작업계획서 파일 내용이 비어 있습니다.")
        upload_dir = self._job_output_dir(job_id) / "uploaded-source"
        upload_dir.mkdir(parents=True, exist_ok=True)
        output_path = upload_dir / source_name
        output_path.write_bytes(content)
        return output_path, source_name

    def _collect_target_result(
        self,
        target: dict[str, Any],
        project_name: str,
        step_label: str,
        progress_callback: Any | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        if progress_callback:
            progress_callback(8, "target_runtime", "running-config에서 CVP 매핑 정보를 확인하는 중입니다.")
        runtime = self._build_target_runtime(target)
        binding_lines = self._find_cvp_binding_lines(runtime.config_text)
        self._log_job(
            job_id,
            f"device runtime resolved: device={runtime.input_name}, hostname={runtime.hostname or self.NA_LABEL}, "
            f"mgmt_ip={runtime.mgmt_ip or self.NA_LABEL}, cvp_host={runtime.cvp_host}, snapshot_template_id={runtime.snapshot_template_id}",
        )
        self._log_job(job_id, f"{runtime.input_name}: running-config CVP binding lines -> {binding_lines or [self.NA_LABEL]}")
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
            step_label=step_label,
            job_id=job_id,
        )
        if progress_callback:
            progress_callback(97, "target_parse", "Snapshot 결과를 파싱하는 중입니다.")
        result = self._parse_snapshot_outputs(command_outputs, step_label)

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

        result["단계"] = step_label
        result["device_name"] = runtime.input_name
        result["device_id"] = runtime.device_id
        result["snapshot_template_id"] = runtime.snapshot_template_id
        result = self._normalize_snapshot_result(result, runtime, step_label=step_label, job_id=job_id)
        if progress_callback:
            progress_callback(100, "target_done", "장비 작업계획서 데이터 수집이 완료되었습니다.")
        return result

    def _normalize_snapshot_result(
        self,
        result: dict[str, Any],
        runtime: _TargetRuntime,
        step_label: str,
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
                replacement = self._normalize_text_value(fallback, allow_multiline=(field_name == "running-config"))
                normalized[field_name] = replacement or self.NA_LABEL
                self._log_job(
                    job_id,
                    f"{runtime.input_name}: snapshot field '{field_name}' was empty and replaced with '{normalized[field_name]}'.",
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
                normalized[field_name] = step_label
                continue
            current_value = normalized.get(field_name)
            if self._is_blank_value(current_value):
                normalized[field_name] = self.NA_LABEL
                self._log_job(
                    job_id,
                    f"{runtime.input_name}: snapshot field '{field_name}' was empty and replaced with '{self.NA_LABEL}'.",
                    level="warning",
                )
            elif isinstance(current_value, str):
                cleaned = self._normalize_text_value(current_value)
                if not cleaned:
                    normalized[field_name] = self.NA_LABEL
                    self._log_job(
                        job_id,
                        f"{runtime.input_name}: snapshot field '{field_name}' was normalized to empty and replaced with '{self.NA_LABEL}'.",
                        level="warning",
                    )
                else:
                    normalized[field_name] = cleaned
        return normalized

    def _extract_snapshot_outputs(
        self,
        snapshot_status: dict[str, Any],
        snapshot_id: str,
        project_name: str,
        device_name: str,
        step_label: str,
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

        output_dir = (
            self._job_snapshot_output_dir(job_id) / self._safe_segment(project_name) / f"{self._safe_segment(device_name)}_{step_label}"
            if job_id
            else self._workplan_result_root() / self._safe_segment(project_name) / f"{self._safe_segment(device_name)}_{step_label}"
        )
        output_dir.mkdir(parents=True, exist_ok=True)

        outputs: dict[str, str] = {}
        for command_key, parts in sorted(chunk_map.items(), key=lambda item: self._natural_sort_key(item[0])):
            filename = command_map.get(command_key, command_key)
            content = "".join(parts[index] for index in sorted(parts))
            outputs[filename] = outputs.get(filename, "") + content
            (output_dir / f"{filename}.txt").write_text(outputs[filename], encoding="utf-8")
        return outputs

    def _render_workbook_stream(
        self,
        project_name: str,
        results: list[dict[str, Any]],
        step_label: str,
        source_workbook_path: Path | None = None,
        job_id: str | None = None,
    ) -> BytesIO:
        temp_dir = self._workplan_result_root() / "temp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_path = temp_dir / f"{uuid4().hex}.xlsx"
        try:
            self._write_workbook_file(
                temp_path,
                project_name,
                results,
                step_label=step_label,
                source_workbook_path=source_workbook_path,
                job_id=job_id,
            )
            return BytesIO(temp_path.read_bytes())
        finally:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def _write_workbook_file(
        self,
        output_path: Path,
        project_name: str,
        results: list[dict[str, Any]],
        step_label: str,
        source_workbook_path: Path | None = None,
        job_id: str | None = None,
    ) -> None:
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
                workbook, using_template = self._open_or_create_workbook(app, source_workbook_path=source_workbook_path)
                self._populate_workbook(
                    workbook,
                    project_name,
                    results,
                    using_template,
                    step_label=step_label,
                    job_id=job_id,
                )
                workbook.save(str(output_path))
            except Exception as exc:
                raise RuntimeError(f"xlwings 작업계획서 저장에 실패했습니다: {exc}") from exc
            finally:
                if workbook is not None:
                    workbook.close()
                if app is not None:
                    app.quit()

    def _open_or_create_workbook(self, app: Any, source_workbook_path: Path | None = None) -> tuple[Any, bool]:
        if source_workbook_path:
            workbook = app.books.open(str(source_workbook_path))
            self._validate_template(workbook, source_workbook_path)
            return workbook, True
        return super()._open_or_create_workbook(app)

    def _prepare_blank_workbook(self, workbook: Any, step_label: str) -> None:
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
        scenario.range("C16").value = step_label
        scenario.range("D16").value = ""
        scenario.range("E16").value = ""

    def _populate_workbook(
        self,
        workbook: Any,
        project_name: str,
        results: list[dict[str, Any]],
        using_template: bool,
        step_label: str,
        job_id: str | None = None,
    ) -> None:
        device_names = [self._display_name_for_result(item) for item in results]
        links = self._build_snapshot_links(results, step_label=step_label, job_id=job_id)

        if not using_template:
            self._prepare_blank_workbook(workbook, step_label)

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
        after_row = 7
        for result in results:
            row_values = [result.get(column, self.NA_LABEL) for column in self.CHECK_COLUMNS]
            start_cell = f"C{before_row}" if step_label == "작업 전" else f"C{after_row}"
            check_sheet.range(start_cell).value = row_values
            if step_label == "작업 전":
                before_row += 2
            else:
                after_row += 2
        self._log_job(job_id, "Workbook check sheet populated")

        for _ in range(max(0, len(device_names) - 1)):
            config_sheet.range("B:G").api.Copy()
            config_sheet.api.Columns("H:H").Insert()
        config_headers: list[str] = []
        for device_name in device_names:
            config_headers.extend([f"{device_name} 작업 전", "Compare", f"{device_name} 작업 후", "o/x", "비고", ""])
        config_sheet.range("B2").value = [config_headers]
        for index, result in enumerate(results):
            config_lines = [[line.strip()] for line in str(result.get("running-config") or "").splitlines()]
            config_column = index * 6 + (2 if step_label == "작업 전" else 3)
            target_range = config_sheet.range((3, config_column))
            target_range.value = config_lines
            target_range.api.WrapText = True
        self._log_job(job_id, "Workbook config sheet populated")

        scenario_row = 16
        scenario_sheet.range("C16").value = step_label
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
            self._log_job(job_id, f"Snapshot hyperlink add: row={row_number}, label_length={len(display_name)}, address={address}")
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

    def _build_snapshot_links(
        self,
        results: list[dict[str, Any]],
        step_label: str,
        job_id: str | None = None,
    ) -> list[tuple[str, str]]:
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
                f"{hostname} {step_label} 스냅샷 비교",
                fallback=f"{hostname} 스냅샷 비교",
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

    def _evidence_root(self) -> Path:
        root = self._workplan_result_root() / "evidence"
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _evidence_card_dir(self, card_id: int, project_name: str) -> Path:
        directory = self._evidence_root() / "cards" / f"{card_id}_{self._safe_segment(project_name)}"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def get_evidence_summary(self, card_id: int, project_name: str) -> dict[str, Any]:
        card = self.kanban_service.get_card(card_id) or {}
        resolved_project_name = str(project_name or card.get("title") or card.get("card_code") or "").strip()
        if not resolved_project_name:
            raise ValueError("작업 계획서 증적을 조회할 프로젝트명을 확인할 수 없습니다.")

        evidence_dir = self._evidence_card_dir(card_id, resolved_project_name)
        latest_dir = evidence_dir / "latest"
        latest_dir.mkdir(parents=True, exist_ok=True)
        before = self._build_evidence_stage_summary(evidence_dir, "작업 전")
        after = self._build_evidence_stage_summary(evidence_dir, "작업 후")
        upload_dir = latest_dir / "uploads"
        upload_logs = sorted([path.name for path in upload_dir.glob("*.json")] if upload_dir.exists() else [], reverse=True)
        return {
            "card_id": card_id,
            "project_name": resolved_project_name,
            "evidence_key": f"{card_id}_{self._safe_segment(resolved_project_name)}",
            "root_path": str(evidence_dir),
            "latest_path": str(latest_dir),
            "before": before,
            "after": after,
            "upload_log_count": len(upload_logs),
            "upload_logs": upload_logs,
        }

    def _build_evidence_stage_summary(self, evidence_dir: Path, step_label: str) -> dict[str, Any]:
        stage_key = self._step_key(step_label)
        latest_dir = evidence_dir / "latest" / stage_key
        history_root = evidence_dir / "history"
        history_dirs = sorted(history_root.glob(f"*-{stage_key}")) if history_root.exists() else []
        manifest_path = latest_dir / "manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                return {
                    "step_label": step_label,
                    "exists": True,
                    "updated_at": str(manifest.get("updated_at") or ""),
                    "workbook_filename": str(manifest.get("workbook_filename") or ""),
                    "source_workbook_filename": str(manifest.get("source_workbook_filename") or ""),
                    "snapshot_archive_filename": str(manifest.get("snapshot_archive_filename") or ""),
                    "snapshot_output_count": int(manifest.get("snapshot_output_count") or 0),
                    "history_count": len(history_dirs),
                }
            except Exception:
                pass

        workbook_dir = latest_dir / "workbook"
        source_dir = latest_dir / "source-workbook"
        workbook_filename = next((path.name for path in sorted(workbook_dir.glob("*.xlsx"))), "") if workbook_dir.exists() else ""
        source_workbook_filename = next((path.name for path in sorted(source_dir.glob("*.xlsx"))), "") if source_dir.exists() else ""
        snapshot_archive_filename = next((path.name for path in sorted(latest_dir.glob("*snapshot_outputs.zip"))), "")
        snapshot_output_count = sum(1 for _ in (latest_dir / "snapshot-outputs").rglob("*.txt")) if (latest_dir / "snapshot-outputs").exists() else 0
        updated_at = datetime.fromtimestamp(latest_dir.stat().st_mtime, tz=timezone.utc).astimezone().isoformat(timespec="seconds") if latest_dir.exists() else ""
        return {
            "step_label": step_label,
            "exists": latest_dir.exists(),
            "updated_at": updated_at,
            "workbook_filename": workbook_filename,
            "source_workbook_filename": source_workbook_filename,
            "snapshot_archive_filename": snapshot_archive_filename,
            "snapshot_output_count": snapshot_output_count,
            "history_count": len(history_dirs),
        }

    def _sync_job_artifacts_to_evidence(
        self,
        job_id: str,
        card_id: int,
        project_name: str,
        step_label: str,
        workbook_path: Path,
        source_workbook_path: Path | None = None,
    ) -> None:
        evidence_dir = self._evidence_card_dir(card_id, project_name)
        latest_root = evidence_dir / "latest"
        latest_root.mkdir(parents=True, exist_ok=True)
        history_root = evidence_dir / "history"
        history_root.mkdir(parents=True, exist_ok=True)
        stage_key = self._step_key(step_label)
        latest_stage_dir = latest_root / stage_key
        history_stage_dir = history_root / f"{datetime.now(timezone.utc).astimezone().strftime('%Y%m%d-%H%M%S')}-{stage_key}"

        if latest_stage_dir.exists() and any(latest_stage_dir.rglob("*")):
            self._copy_tree(latest_stage_dir, history_stage_dir)
            shutil.rmtree(latest_stage_dir, ignore_errors=True)

        latest_stage_dir.mkdir(parents=True, exist_ok=True)
        history_stage_dir.mkdir(parents=True, exist_ok=True)

        workbook_target = latest_stage_dir / "workbook" / workbook_path.name
        workbook_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workbook_path, workbook_target)
        history_workbook_target = history_stage_dir / "workbook" / workbook_path.name
        history_workbook_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workbook_path, history_workbook_target)

        source_workbook_name = ""
        if source_workbook_path and source_workbook_path.exists():
            source_workbook_name = source_workbook_path.name
            latest_source_target = latest_stage_dir / "source-workbook" / source_workbook_path.name
            latest_source_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_workbook_path, latest_source_target)
            history_source_target = history_stage_dir / "source-workbook" / source_workbook_path.name
            history_source_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_workbook_path, history_source_target)

        snapshot_output_count = 0
        snapshot_archive_name = ""
        job_snapshot_root = self._job_snapshot_output_dir(job_id)
        if job_snapshot_root.exists() and any(path.is_file() for path in job_snapshot_root.rglob("*")):
            latest_snapshot_root = latest_stage_dir / "snapshot-outputs"
            history_snapshot_root = history_stage_dir / "snapshot-outputs"
            self._copy_tree(job_snapshot_root, latest_snapshot_root)
            self._copy_tree(job_snapshot_root, history_snapshot_root)
            snapshot_output_count = sum(1 for _ in latest_snapshot_root.rglob("*.txt"))
            snapshot_archive_name = self._sanitize_filename(f"{project_name}_{step_label}_snapshot_outputs.zip")
            self._build_snapshot_archive(latest_snapshot_root, latest_stage_dir / snapshot_archive_name)
            self._build_snapshot_archive(history_snapshot_root, history_stage_dir / snapshot_archive_name)

        stage_manifest = {
            "step_label": step_label,
            "updated_at": self._now_iso(),
            "workbook_filename": workbook_path.name,
            "source_workbook_filename": source_workbook_name,
            "snapshot_archive_filename": snapshot_archive_name,
            "snapshot_output_count": snapshot_output_count,
        }
        (latest_stage_dir / "manifest.json").write_text(json.dumps(stage_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (history_stage_dir / "manifest.json").write_text(json.dumps(stage_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        latest_manifest_path = latest_root / "manifest.json"
        latest_manifest = self.get_evidence_summary(card_id, project_name)
        latest_manifest_path.write_text(json.dumps(latest_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def _copy_tree(self, source: Path, destination: Path) -> None:
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(source, destination)
