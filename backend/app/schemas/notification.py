from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


NotificationKind = Literal["info", "assignment", "workflow_ready", "workflow_completed"]


class NotificationResponse(BaseModel):
    id: int
    user_id: int
    kind: NotificationKind = "info"
    title: str
    body: str = ""
    link_view: str = ""
    link_card_id: int | None = None
    link_phase_id: str = ""
    is_read: bool = False
    created_by_user_id: int | None = None
    created_at: str
    read_at: str = ""


class NotificationListResponse(BaseModel):
    items: list[NotificationResponse] = Field(default_factory=list)
    unread_count: int = 0
