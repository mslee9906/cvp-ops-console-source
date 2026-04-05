from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.kanban import KanbanCardResponse
from app.schemas.workflow import WorkflowDocumentResponse


class WorkHistoryCompleteRequest(BaseModel):
    completed_note: str = Field(default="", max_length=5000)


class WorkHistoryItemResponse(BaseModel):
    id: int
    original_card_id: int
    card_code: str
    title: str
    card_type: str
    completed_note: str = ""
    completed_by_user_id: int | None = None
    completed_by_name: str = ""
    completed_at: str
    restored_card_id: int | None = None
    restored_at: str = ""
    restored_by_user_id: int | None = None
    archived_card: dict[str, Any] = Field(default_factory=dict)
    archived_workflow: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class WorkHistoryDetailResponse(WorkHistoryItemResponse):
    pass


class WorkHistoryRestoreResponse(BaseModel):
    history: WorkHistoryItemResponse
    restored_card: KanbanCardResponse
    restored_workflow: WorkflowDocumentResponse | None = None
