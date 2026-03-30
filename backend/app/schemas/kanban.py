from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class KanbanColumnKey(str, Enum):
    blocked = "blocked"
    planned = "planned"
    ready = "ready"
    in_progress = "in_progress"
    verifying = "verifying"
    done = "done"


class KanbanCardType(str, Enum):
    existing = "existing"
    new = "new"


class KanbanPriority(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class KanbanChecklistItem(BaseModel):
    id: int | None = None
    title: str = Field(..., min_length=1, max_length=300)
    is_completed: bool = False
    sort_order: int | None = Field(default=None, ge=1)


class KanbanChecklistItemResponse(BaseModel):
    id: int
    title: str
    is_completed: bool = False
    sort_order: int
    created_at: str
    updated_at: str


class KanbanCardResponse(BaseModel):
    id: int
    card_code: str
    title: str
    description: str = ""
    assignee: str = ""
    column_key: KanbanColumnKey
    card_type: KanbanCardType
    priority: KanbanPriority
    sort_order: int
    checklist_total: int = 0
    checklist_completed: int = 0
    progress_percent: int = 0
    checklist_items: list[KanbanChecklistItemResponse] = Field(default_factory=list)
    created_at: str
    updated_at: str


class KanbanCardCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    assignee: str = Field(default="", max_length=120)
    column_key: KanbanColumnKey = KanbanColumnKey.planned
    card_type: KanbanCardType = KanbanCardType.existing
    priority: KanbanPriority = KanbanPriority.medium


class KanbanCardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    assignee: str | None = Field(default=None, max_length=120)
    column_key: KanbanColumnKey | None = None
    card_type: KanbanCardType | None = None
    priority: KanbanPriority | None = None
    checklist_items: list[KanbanChecklistItem] | None = None


class KanbanCardPosition(BaseModel):
    id: int
    column_key: KanbanColumnKey
    sort_order: int = Field(..., ge=1)


class KanbanReorderRequest(BaseModel):
    items: list[KanbanCardPosition] = Field(default_factory=list)
