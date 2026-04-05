from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from app.repositories.history_repository import HistoryRepository
from app.repositories.kanban_repository import KanbanRepository
from app.repositories.workflow_repository import WorkflowRepository


class HistoryService:
    def __init__(
        self,
        repository: HistoryRepository,
        kanban_repository: KanbanRepository,
        workflow_repository: WorkflowRepository,
    ) -> None:
        self.repository = repository
        self.kanban_repository = kanban_repository
        self.workflow_repository = workflow_repository

    def initialize(self) -> None:
        self.repository.initialize()
        self._archive_done_cards()

    def list_history(self) -> list[dict[str, Any]]:
        return self.repository.list_entries()

    def get_history(self, history_id: int) -> dict[str, Any] | None:
        return self.repository.get_entry(history_id)

    def complete_card(
        self,
        card_id: int,
        *,
        completed_note: str,
        current_user: dict[str, Any],
    ) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None

        workflow_document = self.workflow_repository.get_document(card_id)
        completed_at = self._now_iso()
        history_entry = self.repository.archive_entry(
            original_card_id=card_id,
            card_code=str(card.get("card_code") or f"KAN-{card_id:03d}"),
            title=str(card.get("title") or ""),
            card_type=str(card.get("card_type") or "existing"),
            completed_note=str(completed_note or "").strip(),
            completed_by_user_id=self._coerce_optional_int(current_user.get("id")),
            completed_by_name=self._user_label(current_user),
            completed_at=completed_at,
            archived_card=deepcopy(card),
            archived_workflow=deepcopy((workflow_document or {}).get("workflow") or {}),
        )
        self.kanban_repository.delete_card(card_id)
        return history_entry

    def restore_card(
        self,
        history_id: int,
        current_user: dict[str, Any],
        *,
        delete_history: bool = False,
    ) -> dict[str, Any] | None:
        entry = self.repository.get_entry(history_id)
        if not entry:
            return None

        archived_card = deepcopy(entry.get("archived_card") or {})
        archived_card_code = str(entry.get("card_code") or archived_card.get("card_code") or "").strip()
        response_history: dict[str, Any] | None = entry
        if archived_card_code:
            existing_card = self.kanban_repository.get_card_by_code(archived_card_code)
            if existing_card:
                response_history = self.repository.mark_restored(
                    history_id,
                    restored_card_id=int(existing_card["id"]),
                    restored_by_user_id=self._coerce_optional_int(current_user.get("id")),
                )
                if delete_history:
                    self.repository.delete_entry(history_id)
                    response_history = None
                return {
                    "history": response_history,
                    "history_deleted": bool(delete_history),
                    "restored_card": existing_card,
                }

        if not archived_card:
            raise ValueError("History entry does not contain archived card data")

        payload = {
            "title": str(archived_card.get("title") or ""),
            "description": str(archived_card.get("description") or ""),
            "due_at": str(archived_card.get("due_at") or ""),
            "assignee": str(archived_card.get("assignee") or ""),
            "assignee_user_id": archived_card.get("assignee_user_id"),
            "created_by_user_id": archived_card.get("created_by_user_id"),
            "updated_by_user_id": self._coerce_optional_int(current_user.get("id")) or archived_card.get("updated_by_user_id"),
            "column_key": "planned",
            "card_type": str(archived_card.get("card_type") or "existing"),
            "priority": str(archived_card.get("priority") or "medium"),
            "checklist_items": deepcopy(archived_card.get("checklist_items") or []),
            "targets": deepcopy(archived_card.get("targets") or []),
            "planned_configs": deepcopy(archived_card.get("planned_configs") or []),
        }
        restored_card = self.kanban_repository.restore_card(
            payload,
            card_code=archived_card_code,
            column_key="planned",
            created_at=str(archived_card.get("created_at") or ""),
            updated_at=self._now_iso(),
        )

        archived_workflow = deepcopy(entry.get("archived_workflow") or {})
        if archived_workflow:
            archived_workflow["ticketId"] = restored_card["card_code"]
            archived_workflow["cardTitle"] = restored_card["title"]
            archived_workflow["projectName"] = archived_workflow.get("projectName") or restored_card["title"]
            archived_workflow["lastUpdated"] = self._now_iso()
            archived_workflow["lastUpdatedBy"] = self._user_label(current_user)
            self.workflow_repository.save_document(restored_card["id"], archived_workflow, timestamp=archived_workflow["lastUpdated"])

        response_history = self.repository.mark_restored(
            history_id,
            restored_card_id=int(restored_card["id"]),
            restored_by_user_id=self._coerce_optional_int(current_user.get("id")),
        )
        if delete_history:
            self.repository.delete_entry(history_id)
            response_history = None
        return {
            "history": response_history,
            "history_deleted": bool(delete_history),
            "restored_card": restored_card,
        }

    def delete_history(self, history_id: int) -> bool:
        return self.repository.delete_entry(history_id)

    def _archive_done_cards(self) -> None:
        for card in self.kanban_repository.list_cards():
            if str(card.get("column_key") or "") != "done":
                continue
            already_archived = any(
                str(item.get("card_code") or "") == str(card.get("card_code") or "")
                for item in self.repository.list_entries()
            )
            if already_archived:
                self.kanban_repository.delete_card(int(card["id"]))
                continue
            self.complete_card(
                int(card["id"]),
                completed_note="기존 완료 컬럼 카드 자동 이관",
                current_user={"display_name": "System", "id": None},
            )

    def _coerce_optional_int(self, value: Any) -> int | None:
        if value in (None, ""):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _user_label(self, user: dict[str, Any] | None) -> str:
        if not user:
            return ""
        return str(user.get("display_name") or user.get("username") or "").strip()

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
