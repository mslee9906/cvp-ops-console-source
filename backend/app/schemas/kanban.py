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


class KanbanTargetKind(str, Enum):
    existing = "existing"
    new = "new"


class KanbanTargetMatchStatus(str, Enum):
    manual_only = "manual_only"
    candidate_found = "candidate_found"
    linked_to_cvp = "linked_to_cvp"
    ignored = "ignored"


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


class KanbanTargetItem(BaseModel):
    id: int | None = None
    target_kind: KanbanTargetKind = KanbanTargetKind.existing
    display_name: str = Field(..., min_length=1, max_length=120)
    mgmt_ip: str = Field(default="", max_length=120)
    model: str = Field(default="", max_length=120)
    role_hint: str = Field(default="", max_length=120)
    cvp_device_id: str = Field(default="", max_length=120)
    match_status: KanbanTargetMatchStatus = KanbanTargetMatchStatus.manual_only
    sort_order: int | None = Field(default=None, ge=1)


class KanbanTargetItemResponse(BaseModel):
    id: int
    target_kind: KanbanTargetKind
    display_name: str
    mgmt_ip: str = ""
    model: str = ""
    role_hint: str = ""
    cvp_device_id: str = ""
    match_status: KanbanTargetMatchStatus = KanbanTargetMatchStatus.manual_only
    service_status: str = "planned"
    sort_order: int
    created_at: str
    updated_at: str


class KanbanPlannedConfigItem(BaseModel):
    id: int | None = None
    target_id: int = Field(..., ge=1)
    config_text: str = Field(default="", max_length=50000)


class KanbanPlannedConfigItemResponse(BaseModel):
    id: int
    target_id: int
    config_text: str = ""
    created_at: str
    updated_at: str


class KanbanCardResponse(BaseModel):
    id: int
    card_code: str
    title: str
    description: str = ""
    due_at: str = ""
    assignee: str = ""
    assignee_user_id: int | None = None
    created_by_user_id: int | None = None
    created_by_name: str = ""
    updated_by_user_id: int | None = None
    updated_by_name: str = ""
    column_key: KanbanColumnKey
    card_type: KanbanCardType
    priority: KanbanPriority
    sort_order: int
    checklist_total: int = 0
    checklist_completed: int = 0
    progress_percent: int = 0
    checklist_items: list[KanbanChecklistItemResponse] = Field(default_factory=list)
    targets: list[KanbanTargetItemResponse] = Field(default_factory=list)
    planned_configs: list[KanbanPlannedConfigItemResponse] = Field(default_factory=list)
    created_at: str
    updated_at: str


class KanbanCardCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    due_at: str = Field(default="", max_length=40)
    assignee: str = Field(default="", max_length=120)
    assignee_user_id: int | None = Field(default=None, ge=1)
    column_key: KanbanColumnKey = KanbanColumnKey.planned
    card_type: KanbanCardType = KanbanCardType.existing
    priority: KanbanPriority = KanbanPriority.medium
    targets: list[KanbanTargetItem] = Field(default_factory=list)
    planned_configs: list[KanbanPlannedConfigItem] = Field(default_factory=list)


class KanbanCardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    due_at: str | None = Field(default=None, max_length=40)
    assignee: str | None = Field(default=None, max_length=120)
    assignee_user_id: int | None = Field(default=None, ge=1)
    column_key: KanbanColumnKey | None = None
    card_type: KanbanCardType | None = None
    priority: KanbanPriority | None = None
    checklist_items: list[KanbanChecklistItem] | None = None
    targets: list[KanbanTargetItem] | None = None
    planned_configs: list[KanbanPlannedConfigItem] | None = None


class KanbanCardPosition(BaseModel):
    id: int
    column_key: KanbanColumnKey
    sort_order: int = Field(..., ge=1)


class KanbanReorderRequest(BaseModel):
    items: list[KanbanCardPosition] = Field(default_factory=list)


class KanbanTargetSnapshotResponse(BaseModel):
    target: KanbanTargetItemResponse
    linked_device: dict = Field(default_factory=dict)
    config: dict = Field(default_factory=dict)
    bgp_entries: list[dict] = Field(default_factory=list)
    vrfs: list[dict] = Field(default_factory=list)
    vlans: list[dict] = Field(default_factory=list)
    vnis: list[dict] = Field(default_factory=list)
    ip_records: list[dict] = Field(default_factory=list)


class KanbanValidationMatch(BaseModel):
    title: str
    body: str
    severity: str = "info"
    details: dict = Field(default_factory=dict)


class KanbanValidationSection(BaseModel):
    key: str
    title: str
    items: list[KanbanValidationMatch] = Field(default_factory=list)


class KanbanValidationResponse(BaseModel):
    target_id: int
    has_conflict: bool
    sections: list[KanbanValidationSection] = Field(default_factory=list)


class KanbanValidationRequest(BaseModel):
    target_id: int = Field(..., ge=1)
    config_text: str = Field(default="", max_length=50000)


class KanbanDiffLine(BaseModel):
    left_line_number: int | None = None
    right_line_number: int | None = None
    left_text: str = ""
    right_text: str = ""
    kind: str


class KanbanDiffResponse(BaseModel):
    target_id: int
    snapshot_available: bool
    snapshot_text: str = ""
    planned_text: str = ""
    lines: list[KanbanDiffLine] = Field(default_factory=list)


class KanbanDiffRequest(BaseModel):
    target_id: int = Field(..., ge=1)
    config_text: str = Field(default="", max_length=50000)
