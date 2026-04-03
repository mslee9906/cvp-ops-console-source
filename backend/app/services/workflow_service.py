from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
import uuid

from app.repositories.kanban_repository import KanbanRepository
from app.repositories.workflow_repository import WorkflowRepository
from app.services.notification_service import NotificationService


STATUS_DEFAULT = "not_started"


class WorkflowService:
    def __init__(
        self,
        repository: WorkflowRepository,
        kanban_repository: KanbanRepository,
        notification_service: NotificationService,
    ) -> None:
        self.repository = repository
        self.kanban_repository = kanban_repository
        self.notification_service = notification_service

    def initialize(self) -> None:
        self.repository.initialize()
        self._ensure_system_templates()

    def get_card_workflow(self, card_id: int) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None

        existing = self.repository.get_document(card_id)
        if existing:
            workflow = self._synchronize_workflow(existing["workflow"], card)
            if workflow != existing["workflow"]:
                timestamp = str(card.get("updated_at") or card.get("created_at") or self._now_iso())
                workflow["lastUpdated"] = timestamp
                workflow["lastUpdatedBy"] = str(card.get("updated_by_name") or card.get("created_by_name") or "")
                return self.repository.save_document(card_id, workflow, timestamp=timestamp)
            return existing

        template = self._get_default_template_for_card(card)
        workflow = self._build_workflow_from_card(card, template)
        return self.repository.save_document(card_id, workflow, timestamp=str(workflow.get("lastUpdated") or self._now_iso()))

    def save_card_workflow(
        self,
        card_id: int,
        workflow: dict[str, Any],
        current_user: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None

        existing = self.repository.get_document(card_id)
        synchronized = self._synchronize_workflow(workflow, card)
        timestamp = self._now_iso()
        synchronized["lastUpdated"] = timestamp
        if current_user:
            synchronized["lastUpdatedBy"] = str(current_user.get("display_name") or current_user.get("username") or "")
        saved = self.repository.save_document(card_id, synchronized, timestamp=timestamp)
        self.kanban_repository.touch_card(
            card_id,
            updated_by_user_id=self._coerce_optional_int((current_user or {}).get("id")),
            timestamp=timestamp,
        )
        self._notify_phase_assignments(
            existing["workflow"] if existing else None,
            saved["workflow"],
            card,
            current_user,
        )
        return saved

    def complete_phase(
        self,
        card_id: int,
        phase_id: str,
        current_user: dict[str, Any],
    ) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None

        document = self.get_card_workflow(card_id)
        if not document:
            return None

        workflow = deepcopy(document["workflow"])
        phases = workflow.get("phases") or []
        phase_index = next((index for index, phase in enumerate(phases) if str(phase.get("id")) == phase_id), -1)
        if phase_index < 0:
            raise LookupError("Workflow phase not found")

        phase = phases[phase_index]
        current_user_id = int(current_user["id"])
        current_role = str(current_user.get("role") or "")
        phase_assignee_id = self._coerce_optional_int(phase.get("assigneeUserId"))
        if current_role != "admin" and phase_assignee_id != current_user_id:
            raise PermissionError("Only the phase assignee or admin can complete this phase")

        if phase.get("isCompleted"):
            return {
                **document,
                "completed_phase_id": str(phase.get("id") or ""),
                "notified_phase_id": "",
                "notified_phase_title": "",
                "notification_recipient": "",
                "notification_title": "",
                "notification_body": "",
            }

        progress = self._calculate_phase_progress(phase)
        if progress < 100:
            raise ValueError("The selected phase is not ready to complete")

        timestamp = self._now_iso()
        phase["isCompleted"] = True
        phase["completedAt"] = timestamp
        phase["completedByUserId"] = current_user_id
        phase["completedByName"] = self._user_label(current_user)
        workflow["lastUpdated"] = timestamp
        workflow["lastUpdatedBy"] = self._user_label(current_user)

        saved = self.repository.save_document(card_id, workflow, timestamp=timestamp)
        self.kanban_repository.touch_card(card_id, updated_by_user_id=current_user_id, timestamp=timestamp)

        notified_phase_id = ""
        notified_phase_title = ""
        notification_recipient = ""
        notification_title = ""
        notification_body = ""
        next_phase = self._find_next_pending_phase(saved["workflow"].get("phases") or [], phase_index + 1)
        if next_phase:
            notified_phase_id = str(next_phase.get("id") or "")
            notification_result = self._notify_next_phase_ready(card, next_phase, phase, current_user)
            notified_phase_title = str(next_phase.get("title") or "")
            notification_recipient = str(notification_result.get("recipient") or "")
            notification_title = str(notification_result.get("title") or "")
            notification_body = str(notification_result.get("body") or "")

        return {
            **saved,
            "completed_phase_id": str(phase.get("id") or ""),
            "notified_phase_id": notified_phase_id,
            "notified_phase_title": notified_phase_title,
            "notification_recipient": notification_recipient,
            "notification_title": notification_title,
            "notification_body": notification_body,
        }

    def uncomplete_phase(
        self,
        card_id: int,
        phase_id: str,
        current_user: dict[str, Any],
    ) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None

        current_user_id = int(current_user["id"])
        document = self.repository.get_document(card_id)
        if not document:
            document = self._create_document_from_card(card)
        workflow = self._synchronize_workflow(document.get("workflow") or {}, card)

        phases = workflow.get("phases") or []
        phase_index = next((index for index, phase in enumerate(phases) if str(phase.get("id") or "") == phase_id), -1)
        if phase_index == -1:
            raise LookupError("Workflow phase not found")

        phase = phases[phase_index]
        phase_assignee_user_id = self._coerce_optional_int(phase.get("assigneeUserId"))
        if current_user.get("role") != "admin" and phase_assignee_user_id != current_user_id:
            raise PermissionError("Only the phase assignee or admin can cancel this phase completion")

        timestamp = self._now_iso()
        phase["isCompleted"] = False
        phase["completedAt"] = ""
        phase["completedByUserId"] = None
        phase["completedByName"] = ""
        workflow["lastUpdated"] = timestamp
        workflow["lastUpdatedBy"] = self._user_label(current_user)

        saved = self.repository.save_document(card_id, workflow, timestamp=timestamp)
        self.kanban_repository.touch_card(card_id, updated_by_user_id=current_user_id, timestamp=timestamp)
        return saved

    def list_templates(self, card_type: str | None = None) -> list[dict[str, Any]]:
        return self.repository.list_templates(card_type)

    def create_template(self, payload: dict[str, Any], current_user: dict[str, Any] | None = None) -> dict[str, Any]:
        workflow = self._normalize_template_workflow(payload.get("workflow") or {})
        return self.repository.create_template(
            name=str(payload["name"]).strip(),
            description=str(payload.get("description", "") or "").strip(),
            card_type=str(payload["card_type"]).strip(),
            workflow=workflow,
            created_by_user_id=int(current_user["id"]) if current_user else None,
        )

    def update_template(
        self,
        template_id: int,
        changes: dict[str, Any],
        current_user: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        current = self.repository.get_template(template_id)
        if not current:
            return None

        updates: dict[str, Any] = {}
        if "name" in changes:
            updates["name"] = str(changes["name"]).strip()
        if "description" in changes:
            updates["description"] = str(changes["description"] or "").strip()
        if "workflow" in changes:
            updates["workflow"] = self._normalize_template_workflow(changes["workflow"] or {})
        if current_user:
            updates["updated_by_user_id"] = int(current_user["id"])
        return self.repository.update_template(template_id, updates)

    def delete_template(self, template_id: int) -> bool:
        template = self.repository.get_template(template_id)
        if not template or template.get("is_system"):
            return False
        return self.repository.delete_template(template_id)

    def _ensure_system_templates(self) -> None:
        existing = self.repository.list_templates()
        desired_templates = [
            (
                "existing",
                "기본 기존 장비 작업",
                "사전 검증, 작업, 사후 작업 기본 템플릿입니다.",
                self._base_template_phases("existing"),
            ),
            (
                "new",
                "기본 신규 장비 작업",
                "문서 작성, 설치, 사전 점검, 서비스 연동 기본 템플릿입니다.",
                self._base_template_phases("new"),
            ),
        ]

        for card_type, name, description, phases in desired_templates:
            current = next(
                (
                    item
                    for item in existing
                    if item.get("is_system") and str(item.get("card_type") or "") == card_type
                ),
                None,
            )
            desired_workflow = {"phases": phases}
            if current:
                self.repository.update_template(
                    int(current["id"]),
                    {
                        "name": name,
                        "description": description,
                        "workflow": desired_workflow,
                    },
                )
                continue

            self.repository.create_template(
                name=name,
                description=description,
                card_type=card_type,
                workflow=desired_workflow,
                is_system=True,
            )

    def _get_default_template_for_card(self, card: dict[str, Any]) -> dict[str, Any]:
        templates = self.repository.list_templates(str(card.get("card_type") or "existing"))
        if templates:
            return templates[0]
        return {
            "id": None,
            "name": "기본 템플릿",
            "workflow": {"phases": self._base_template_phases(str(card.get("card_type") or "existing"))},
        }

    def _build_workflow_from_card(self, card: dict[str, Any], template: dict[str, Any]) -> dict[str, Any]:
        workflow = self._normalize_template_workflow(template.get("workflow") or {})
        workflow["ticketId"] = card["card_code"]
        workflow["cardTitle"] = card["title"]
        workflow["projectName"] = card["title"]
        workflow["summary"] = str(card.get("description") or "").strip() or "작업 보드 카드 기반 워크플로우입니다."
        workflow["grade"] = workflow.get("grade") or "B"
        workflow["owner"] = str(card.get("assignee") or "").strip() or "미정"
        workflow["createdBy"] = str(card.get("created_by_name") or "").strip() or "Administrator"
        workflow["lastUpdated"] = str(card.get("updated_at") or card.get("created_at") or "")
        workflow["lastUpdatedBy"] = str(card.get("updated_by_name") or card.get("created_by_name") or "")
        workflow["templateId"] = template.get("id")
        workflow["templateName"] = str(template.get("name") or "기본 템플릿")
        workflow["targets"] = self._extract_targets(card)
        workflow["phases"] = self._hydrate_template_phases(workflow["phases"], workflow["targets"], workflow["owner"])
        return workflow

    def _synchronize_workflow(self, workflow: dict[str, Any], card: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize_template_workflow(workflow)
        normalized["ticketId"] = card["card_code"]
        normalized["cardTitle"] = card["title"]
        normalized["summary"] = normalized.get("summary") or str(card.get("description") or "").strip() or "작업 보드 카드 기반 워크플로우입니다."
        normalized["projectName"] = normalized.get("projectName") or card["title"]
        normalized["grade"] = normalized.get("grade") or "B"
        normalized["owner"] = normalized.get("owner") or str(card.get("assignee") or "").strip() or "미정"
        normalized["createdBy"] = normalized.get("createdBy") or str(card.get("created_by_name") or "").strip() or "Administrator"
        normalized["lastUpdated"] = normalized.get("lastUpdated") or str(card.get("updated_at") or card.get("created_at") or "")
        normalized["targets"] = self._extract_targets(card)
        normalized["phases"] = self._hydrate_template_phases(normalized.get("phases") or [], normalized["targets"], normalized["owner"])
        return normalized

    def _normalize_template_workflow(self, workflow: dict[str, Any]) -> dict[str, Any]:
        payload = workflow if isinstance(workflow, dict) else {}
        phases = payload.get("phases") if isinstance(payload.get("phases"), list) else []
        return {
            "ticketId": str(payload.get("ticketId") or ""),
            "cardTitle": str(payload.get("cardTitle") or ""),
            "projectName": str(payload.get("projectName") or ""),
            "summary": str(payload.get("summary") or ""),
            "grade": str(payload.get("grade") or "B"),
            "owner": str(payload.get("owner") or "미정"),
            "createdBy": str(payload.get("createdBy") or "Administrator"),
            "lastUpdated": str(payload.get("lastUpdated") or ""),
            "lastUpdatedBy": str(payload.get("lastUpdatedBy") or ""),
            "templateId": payload.get("templateId"),
            "templateName": str(payload.get("templateName") or ""),
            "targets": list(payload.get("targets") or []),
            "phases": deepcopy(phases),
        }

    def _base_template_phases(self, card_type: str) -> list[dict[str, Any]]:
        if card_type == "new":
            return [
                self._phase_definition("docs", "문서 작성", "현행화, 포설 리스트, 계획서와 Config를 정리합니다."),
                self._phase_definition("install", "장비 연동 전 설치", "랙 마운트, 전원, 관리망 연동을 준비합니다."),
                self._phase_definition("precheck", "사전 점검", "시뮬레이션, 절차 검토, 장애 대응을 점검합니다."),
                self._phase_definition("service", "서비스 연동", "실 장비 적용과 점검, 결과 정리를 수행합니다."),
            ]
        return [
            self._phase_definition("precheck", "사전 검증", "현행 확인, 영향도 검토, 절차 합의, 롤백 가능 여부를 먼저 정리합니다."),
            self._phase_definition("work", "작업", "변경 적용과 중간 검증을 수행합니다."),
            self._phase_definition("post", "사후 작업", "서비스 확인, 현황 업데이트, 결과 공유를 정리합니다."),
        ]

    def _phase_definition(self, prefix: str, title: str, subtitle: str) -> dict[str, Any]:
        return {
            "id": prefix,
            "title": title,
            "subtitle": subtitle,
            "assigneeUserId": None,
            "assigneeName": "미정",
            "includeInProgress": True,
            "blocks": [
                self._make_target_table_block(f"{prefix}-table", f"{title} 실행표", "작업 대상 장비 기준 기본 행", []),
                self._make_note_block(f"{prefix}-note", "메모 블록", "단계 특이사항이나 추가 메모를 기록합니다.", ""),
                self._make_checklist_block(f"{prefix}-check", "체크리스트", "간단 확인 항목을 관리합니다.", []),
            ],
        }

    def _extract_targets(self, card: dict[str, Any]) -> list[str]:
        targets = [
            str(target.get("display_name") or "").strip()
            for target in card.get("targets") or []
            if str(target.get("display_name") or "").strip()
        ]
        return targets or ["미정"]

    def _hydrate_template_phases(self, phases: list[dict[str, Any]], targets: list[str], owner: str) -> list[dict[str, Any]]:
        hydrated: list[dict[str, Any]] = []
        for phase in phases:
            assignee_user_id = phase.get("assigneeUserId")
            if not isinstance(assignee_user_id, int):
                assignee_user_id = None
            next_phase = {
                "id": str(phase.get("id") or self._uid("phase")),
                "title": str(phase.get("title") or "새 단계"),
                "subtitle": str(phase.get("subtitle") or ""),
                "assigneeUserId": assignee_user_id,
                "assigneeName": str(phase.get("assigneeName") or "미정"),
                "includeInProgress": self._coerce_bool(phase.get("includeInProgress"), True),
                "isCompleted": self._coerce_bool(phase.get("isCompleted"), False),
                "completedAt": str(phase.get("completedAt") or ""),
                "completedByUserId": self._coerce_optional_int(phase.get("completedByUserId")),
                "completedByName": str(phase.get("completedByName") or ""),
                "blocks": [],
            }
            blocks = phase.get("blocks") or []
            for block in blocks:
                next_phase["blocks"].append(self._hydrate_block(block, targets, owner))
            if not next_phase["blocks"]:
                next_phase["blocks"].append(self._make_note_block(self._uid("note"), "메모 블록", "새 단계의 기본 메모", ""))
            self._reconcile_phase_completion(next_phase)
            hydrated.append(next_phase)
        return hydrated

    def _hydrate_block(self, block: dict[str, Any], targets: list[str], owner: str) -> dict[str, Any]:
        block_type = str(block.get("type") or "note")
        if block_type == "table":
            return self._hydrate_table_block(block, targets, owner)
        if block_type == "checklist":
            items = [
                {
                    "text": str(item.get("text") or ""),
                    "done": bool(item.get("done", False)),
                    "assignee": str(item.get("assignee") or owner or "미정"),
                }
                for item in block.get("items") or []
            ] or [
                {"text": "추가 확인 항목 1", "done": False, "assignee": owner or "미정"},
                {"text": "추가 확인 항목 2", "done": False, "assignee": owner or "미정"},
            ]
            return {
                "id": str(block.get("id") or self._uid("check")),
                "type": "checklist",
                "title": str(block.get("title") or "체크리스트"),
                "subtitle": str(block.get("subtitle") or ""),
                "editing": bool(block.get("editing", False)),
                "size": str(block.get("size") or "regular"),
                "widthUnits": int(block.get("widthUnits") or 6),
                "heightPx": int(block.get("heightPx") or 220),
                "layoutColumn": self._coerce_optional_int(block.get("layoutColumn")),
                "layoutRow": self._coerce_optional_int(block.get("layoutRow")),
                "items": items,
            }
        if block_type == "links":
            items = [
                {
                    "label": str(item.get("label") or ""),
                    "description": str(item.get("description") or ""),
                    "url": str(item.get("url") or ""),
                }
                for item in block.get("items") or []
            ] or [
                {"label": "링크 1", "description": "관련 설명을 입력하세요.", "url": ""},
                {"label": "링크 2", "description": "관련 설명을 입력하세요.", "url": ""},
            ]
            return {
                "id": str(block.get("id") or self._uid("links")),
                "type": "links",
                "title": str(block.get("title") or "링크 블록"),
                "subtitle": str(block.get("subtitle") or ""),
                "editing": bool(block.get("editing", False)),
                "size": str(block.get("size") or "regular"),
                "widthUnits": int(block.get("widthUnits") or 6),
                "heightPx": int(block.get("heightPx") or 220),
                "layoutColumn": self._coerce_optional_int(block.get("layoutColumn")),
                "layoutRow": self._coerce_optional_int(block.get("layoutRow")),
                "items": items,
            }
        return {
            "id": str(block.get("id") or self._uid("note")),
            "type": "note",
            "title": str(block.get("title") or "메모 블록"),
            "subtitle": str(block.get("subtitle") or ""),
            "editing": bool(block.get("editing", False)),
            "size": str(block.get("size") or "regular"),
            "widthUnits": int(block.get("widthUnits") or 6),
            "heightPx": int(block.get("heightPx") or 230),
            "layoutColumn": self._coerce_optional_int(block.get("layoutColumn")),
            "layoutRow": self._coerce_optional_int(block.get("layoutRow")),
            "content": str(block.get("content") or ""),
        }

    def _hydrate_table_block(self, block: dict[str, Any], targets: list[str], owner: str) -> dict[str, Any]:
        mode = str(block.get("mode") or "custom")
        columns = [
            {
                "key": str(column.get("key") or self._uid("col")),
                "label": str(column.get("label") or "컬럼"),
                "type": str(column.get("type") or "text"),
                "width": int(column.get("width") or self._default_column_width(column)),
            }
            for column in block.get("columns") or []
        ]
        if not columns:
            columns = self._default_table_columns(mode)
        if not any(column["type"] == "status" for column in columns):
            columns.insert(min(2, len(columns)), {"key": self._uid("status"), "label": "상태", "type": "status", "width": 96})

        rows = [self._hydrate_table_row(row, columns, owner) for row in block.get("rows") or []]
        if not rows:
            rows = [self._empty_row(columns)]

        return {
            "id": str(block.get("id") or self._uid("table")),
            "type": "table",
            "mode": mode,
            "title": str(block.get("title") or "표 블록"),
            "subtitle": str(block.get("subtitle") or ""),
            "editing": bool(block.get("editing", False)),
            "size": str(block.get("size") or ("full" if mode == "target" else "wide")),
            "widthUnits": int(block.get("widthUnits") or (12 if mode == "target" else 8)),
            "heightPx": int(block.get("heightPx") or (240 if mode == "target" else 220)),
            "layoutColumn": self._coerce_optional_int(block.get("layoutColumn")),
            "layoutRow": self._coerce_optional_int(block.get("layoutRow")),
            "columns": columns,
            "rows": rows,
        }

    def _make_target_table_block(self, block_id: str, title: str, subtitle: str, targets: list[str]) -> dict[str, Any]:
        columns = self._default_table_columns("target")
        rows = self._merge_target_rows([], columns, targets or ["미정"], "미정")
        return {
            "id": block_id,
            "type": "table",
            "mode": "target",
            "title": title,
            "subtitle": subtitle,
            "editing": False,
            "size": "full",
            "widthUnits": 12,
            "heightPx": 240,
            "columns": columns,
            "rows": rows,
        }

    def _make_note_block(self, block_id: str, title: str, subtitle: str, content: str) -> dict[str, Any]:
        return {
            "id": block_id,
            "type": "note",
            "title": title,
            "subtitle": subtitle,
            "editing": False,
            "size": "regular",
            "widthUnits": 6,
            "heightPx": 230,
            "content": content,
        }

    def _make_checklist_block(self, block_id: str, title: str, subtitle: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "id": block_id,
            "type": "checklist",
            "title": title,
            "subtitle": subtitle,
            "editing": False,
            "size": "regular",
            "widthUnits": 6,
            "heightPx": 220,
            "items": items or [{"text": "체크 항목", "done": False, "assignee": "미정"}],
        }

    def _default_table_columns(self, mode: str) -> list[dict[str, Any]]:
        if mode == "target":
            base = [
                {"key": "hostname", "label": "Hostname", "type": "text"},
                {"key": "work", "label": "작업 항목", "type": "text"},
                {"key": "status", "label": "상태", "type": "status"},
                {"key": "assignee", "label": "담당자", "type": "text"},
                {"key": "note", "label": "메모", "type": "textarea"},
                {"key": "completedAt", "label": "완료 시각", "type": "text"},
            ]
        else:
            base = [
                {"key": self._uid("col"), "label": "구분", "type": "text"},
                {"key": self._uid("col"), "label": "내용", "type": "text"},
                {"key": self._uid("status"), "label": "상태", "type": "status"},
                {"key": self._uid("col"), "label": "담당자", "type": "text"},
                {"key": self._uid("col"), "label": "메모", "type": "textarea"},
            ]
        return [{**column, "width": self._default_column_width(column)} for column in base]

    def _default_column_width(self, column: dict[str, Any]) -> int:
        column_type = str(column.get("type") or "text")
        key = str(column.get("key") or "")
        if column_type == "status":
            return 96
        if column_type == "textarea":
            return 220
        if key == "hostname":
            return 132
        if key == "completedAt":
            return 144
        if key == "assignee":
            return 120
        if key == "work":
            return 190
        return 150

    def _hydrate_table_row(self, row: dict[str, Any], columns: list[dict[str, Any]], owner: str) -> dict[str, Any]:
        next_row = {}
        for column in columns:
            key = column["key"]
            if column["type"] == "status":
                next_row[key] = str(row.get(key) or row.get("status") or STATUS_DEFAULT)
            elif key == "assignee":
                next_row[key] = str(row.get(key) or owner or "미정")
            elif key == "completedAt":
                next_row[key] = str(row.get(key) or "-")
            else:
                next_row[key] = str(row.get(key) or "")
        return next_row

    def _merge_target_rows(
        self,
        existing_rows: list[dict[str, Any]],
        columns: list[dict[str, Any]],
        targets: list[str],
        owner: str,
    ) -> list[dict[str, Any]]:
        hostname_key = self._find_column_key(columns, "hostname")
        assignee_key = self._find_column_key(columns, "assignee")
        completed_key = self._find_column_key(columns, "completedAt")
        status_key = self._find_status_key(columns)
        next_rows: list[dict[str, Any]] = []

        for hostname in targets:
            existing = next(
                (
                    row
                    for row in existing_rows
                    if str(row.get(hostname_key) or "").strip().lower() == str(hostname).strip().lower()
                ),
                None,
            )
            row = self._empty_row(columns)
            row[hostname_key] = hostname
            if existing:
                for column in columns:
                    key = column["key"]
                    if key == hostname_key:
                        continue
                    value = existing.get(key)
                    if value is not None and value != "":
                        row[key] = value
            row.setdefault(status_key, STATUS_DEFAULT)
            row.setdefault(assignee_key, owner or "미정")
            row.setdefault(completed_key, "-")
            if not row.get(assignee_key):
                row[assignee_key] = owner or "미정"
            if not row.get(completed_key):
                row[completed_key] = "-"
            next_rows.append(row)
        return next_rows or [self._empty_row(columns)]

    def _empty_row(self, columns: list[dict[str, Any]]) -> dict[str, Any]:
        row: dict[str, Any] = {}
        for column in columns:
            row[column["key"]] = STATUS_DEFAULT if column["type"] == "status" else ""
        return row

    def _find_status_key(self, columns: list[dict[str, Any]]) -> str:
        for column in columns:
            if column["type"] == "status":
                return str(column["key"])
        return "status"

    def _find_column_key(self, columns: list[dict[str, Any]], fallback_key: str) -> str:
        for column in columns:
            if str(column["key"]) == fallback_key:
                return str(column["key"])
        if fallback_key == "hostname":
            return str(columns[0]["key"])
        return fallback_key

    def _notify_phase_assignments(
        self,
        previous_workflow: dict[str, Any] | None,
        current_workflow: dict[str, Any],
        card: dict[str, Any],
        current_user: dict[str, Any] | None,
    ) -> None:
        previous_phase_map = {
            str(phase.get("id") or ""): phase
            for phase in (previous_workflow or {}).get("phases") or []
            if str(phase.get("id") or "")
        }
        actor_id = self._coerce_optional_int((current_user or {}).get("id"))

        for phase in current_workflow.get("phases") or []:
            phase_id = str(phase.get("id") or "")
            new_assignee_id = self._coerce_optional_int(phase.get("assigneeUserId"))
            if not new_assignee_id or new_assignee_id == actor_id:
                continue
            previous_phase = previous_phase_map.get(phase_id) or {}
            old_assignee_id = self._coerce_optional_int(previous_phase.get("assigneeUserId"))
            if new_assignee_id == old_assignee_id:
                continue
            self.notification_service.notify(
                user_id=new_assignee_id,
                kind="assignment",
                title=f'"{phase.get("title") or "새 단계"}" 단계 담당자로 지정되었습니다.',
                body=f'{card.get("card_code") or ""} {card.get("title") or ""} 작업의 단계 담당자입니다.',
                link_view="work_plan",
                link_card_id=int(card["id"]),
                link_phase_id=phase_id,
                created_by_user_id=actor_id,
            )

    def _notify_next_phase_ready(
        self,
        card: dict[str, Any],
        next_phase: dict[str, Any],
        completed_phase: dict[str, Any],
        current_user: dict[str, Any] | None,
    ) -> dict[str, str]:
        next_assignee_id = self._coerce_optional_int(next_phase.get("assigneeUserId"))
        actor_id = self._coerce_optional_int((current_user or {}).get("id"))
        recipient = str(next_phase.get("assigneeName") or "미정")
        title = f'"{next_phase.get("title") or "다음 단계"}" 단계 진행 알림'
        body = (
            f'{card.get("card_code") or ""} {card.get("title") or ""} 작업에서 '
            f'"{completed_phase.get("title") or "이전 단계"}" 단계가 완료되었습니다.'
        )
        if not next_assignee_id or next_assignee_id == actor_id:
            return {
                "recipient": "",
                "title": "",
                "body": "",
            }
        self.notification_service.notify(
            user_id=next_assignee_id,
            kind="workflow_ready",
            title=title,
            body=body,
            link_view="work_plan",
            link_card_id=int(card["id"]),
            link_phase_id=str(next_phase.get("id") or ""),
            created_by_user_id=actor_id,
        )
        return {
            "recipient": recipient,
            "title": title,
            "body": body,
        }

    def _find_next_pending_phase(self, phases: list[dict[str, Any]], start_index: int) -> dict[str, Any] | None:
        for phase in phases[start_index:]:
            if not self._coerce_bool(phase.get("isCompleted"), False):
                return phase
        return None

    def _reconcile_phase_completion(self, phase: dict[str, Any]) -> None:
        if self._calculate_phase_progress(phase) >= 100:
            if not phase.get("isCompleted"):
                phase["completedAt"] = str(phase.get("completedAt") or "")
                phase["completedByUserId"] = self._coerce_optional_int(phase.get("completedByUserId"))
                phase["completedByName"] = str(phase.get("completedByName") or "")
            return

        phase["isCompleted"] = False
        phase["completedAt"] = ""
        phase["completedByUserId"] = None
        phase["completedByName"] = ""

    def _calculate_phase_progress(self, phase: dict[str, Any]) -> int:
        done = 0
        total = 0
        for block in phase.get("blocks") or []:
            block_type = str(block.get("type") or "")
            if block_type == "table":
                status_key = self._find_status_key(block.get("columns") or [])
                rows = block.get("rows") or []
                total += len(rows)
                done += sum(
                    1
                    for row in rows
                    if str((row or {}).get(status_key) or STATUS_DEFAULT) in {"done", "n_a"}
                )
                continue
            if block_type == "checklist":
                items = block.get("items") or []
                total += len(items)
                done += sum(1 for item in items if bool((item or {}).get("done", False)))
        if total <= 0:
            return 0
        return int(round((done / total) * 100))

    def _coerce_optional_int(self, value: Any) -> int | None:
        if value in (None, ""):
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    def _user_label(self, current_user: dict[str, Any] | None) -> str:
        if not current_user:
            return ""
        return str(current_user.get("display_name") or current_user.get("username") or "").strip()

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    def _coerce_bool(self, value: Any, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "1", "yes", "y", "on"}:
                return True
            if normalized in {"false", "0", "no", "n", "off"}:
                return False
        return bool(value)

    def _uid(self, prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:10]}"
