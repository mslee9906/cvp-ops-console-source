from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class WorkflowDocumentResponse(BaseModel):
    card_id: int
    workflow: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class WorkflowPhaseCompleteResponse(WorkflowDocumentResponse):
    completed_phase_id: str
    notified_phase_id: str = ""
    notified_phase_title: str = ""
    notification_recipient: str = ""
    notification_title: str = ""
    notification_body: str = ""


class WorkflowDocumentUpdateRequest(BaseModel):
    workflow: dict[str, Any] = Field(default_factory=dict)


class WorkflowTemplateResponse(BaseModel):
    id: int
    name: str
    description: str = ""
    card_type: str
    workflow: dict[str, Any] = Field(default_factory=dict)
    is_system: bool = False
    created_by_user_id: int | None = None
    updated_by_user_id: int | None = None
    created_at: str
    updated_at: str


class WorkflowTemplateCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    card_type: str = Field(..., min_length=1, max_length=50)
    workflow: dict[str, Any] = Field(default_factory=dict)


class WorkflowTemplateUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    workflow: dict[str, Any] | None = None
