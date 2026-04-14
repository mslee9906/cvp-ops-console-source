from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class LookupStatus(str, Enum):
    available = "available"
    in_use = "in_use"
    reserved = "reserved"
    review = "review"
    not_available = "not_available"
    error = "error"


class CollectionJobSummary(BaseModel):
    job_name: str
    source: str
    status: str
    start_time: str
    end_time: str
    error_message: str = ""


class OverviewResponse(BaseModel):
    device_count: int
    ip_count: int
    bgp_count: int
    vlan_count: int
    vni_count: int
    vrf_count: int
    config_snapshot_count: int
    latest_collection_at: str | None = None
    source_mode: str
    latest_job: CollectionJobSummary | None = None


class DeviceSummary(BaseModel):
    device_id: str
    hostname: str
    serial: str
    mgmt_ip: str
    model: str
    site: str
    tags: list[str] = Field(default_factory=list)
    last_collected_at: str
    config_hash: str | None = None
    config_collected_at: str | None = None


class LookupMatch(BaseModel):
    device_id: str
    hostname: str
    interface_name: str | None = None
    vrf: str | None = None
    match_type: str | None = None
    label: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class LookupResponse(BaseModel):
    query: str
    scope: str
    status: LookupStatus
    summary: str
    exact_match_count: int = 0
    related_match_count: int = 0
    matches: list[LookupMatch] = Field(default_factory=list)


class ConfigPreviewResponse(BaseModel):
    device_id: str
    hostname: str
    config_hash: str
    collected_at: str
    line_count: int
    file_path: str
    content: str


class RefreshResponse(BaseModel):
    message: str
    source_mode: str
    latest_job: CollectionJobSummary


class CollectionProgressResponse(BaseModel):
    source_mode: str
    status: str
    progress_percent: int
    step: str
    detail: str = ""
    started_at: str = ""
    updated_at: str = ""
    latest_job: CollectionJobSummary | None = None


class WorkPlanProgressResponse(BaseModel):
    job_id: str
    card_id: int | None = None
    project_name: str = ""
    step_label: str = "작업 전"
    status: str
    progress_percent: int
    step: str
    detail: str = ""
    started_at: str = ""
    updated_at: str = ""
    finished_at: str = ""
    filename: str = ""
    error_message: str = ""
    download_ready: bool = False


class RecordListResponse(BaseModel):
    scope: str
    total_count: int
    items: list[LookupMatch] = Field(default_factory=list)


class BgpManagementItem(BaseModel):
    device_id: str
    hostname: str
    vrf: str
    asn: str
    router_id: str = ""
    shutdown: bool = False


class BgpManagementReservation(BaseModel):
    id: int
    kind: str
    value: str
    status: str = "reserved"
    card_id: int
    card_code: str = ""
    card_title: str = ""
    reserved_by_user_id: int | None = None
    reserved_by_name: str = ""
    created_at: str = ""
    updated_at: str = ""
    fulfilled_at: str = ""
    cancelled_at: str = ""


class BgpManagementManualEntry(BaseModel):
    id: int
    asn: str
    entry_kind: str
    device_names: list[str] = Field(default_factory=list)
    note: str = ""
    created_by_user_id: int | None = None
    created_by_name: str = ""
    created_at: str = ""
    updated_at: str = ""


class BgpManagementResponse(BaseModel):
    scope: str = "bgp_management"
    total_count: int
    min_asn: int | None = None
    max_asn: int | None = None
    items: list[BgpManagementItem] = Field(default_factory=list)
    reservations: list[BgpManagementReservation] = Field(default_factory=list)
    manual_entries: list[BgpManagementManualEntry] = Field(default_factory=list)


class VrfGroupDevice(BaseModel):
    device_id: str
    hostname: str
    mgmt_ip: str = ""


class VrfGroupItem(BaseModel):
    vrf_name: str
    device_count: int
    devices: list[VrfGroupDevice] = Field(default_factory=list)


class VrfGroupListResponse(BaseModel):
    scope: str = "vrf"
    total_count: int
    items: list[VrfGroupItem] = Field(default_factory=list)


class VniGroupDevice(BaseModel):
    device_id: str
    hostname: str
    mgmt_ip: str = ""
    vlan_id: str = ""
    vlan_name: str = ""


class VniGroupItem(BaseModel):
    vni: str
    device_count: int
    status: LookupStatus = LookupStatus.in_use
    vlan_ids: list[str] = Field(default_factory=list)
    devices: list[VniGroupDevice] = Field(default_factory=list)
    reservation: dict[str, Any] | None = None


class VniGroupListResponse(BaseModel):
    scope: str = "vni"
    total_count: int
    items: list[VniGroupItem] = Field(default_factory=list)


class VmacGroupDevice(BaseModel):
    device_id: str
    hostname: str
    mgmt_ip: str = ""
    interface_name: str = ""
    vlan_id: str = ""
    vni: str = ""


class VmacGroupItem(BaseModel):
    vmac: str
    device_count: int
    vlan_ids: list[str] = Field(default_factory=list)
    vni_ids: list[str] = Field(default_factory=list)
    devices: list[VmacGroupDevice] = Field(default_factory=list)


class VmacGroupListResponse(BaseModel):
    scope: str = "vmac"
    total_count: int
    items: list[VmacGroupItem] = Field(default_factory=list)


class ConfigSearchLine(BaseModel):
    line_number: int
    text: str


class ConfigSearchMatch(BaseModel):
    device_id: str
    hostname: str
    mgmt_ip: str = ""
    collected_at: str
    match_count: int
    matched_lines: list[ConfigSearchLine] = Field(default_factory=list)


class ConfigSearchResponse(BaseModel):
    query: str
    total_count: int
    total_line_matches: int
    items: list[ConfigSearchMatch] = Field(default_factory=list)


class KanbanLinkedDevice(BaseModel):
    device_id: str
    hostname: str = ""
    mgmt_ip: str = ""
    model: str = ""
    serial: str = ""


class KanbanDraftDevice(BaseModel):
    hostname: str = ""
    mgmt_ip: str = ""
    model: str = ""
    serial: str = ""


class KanbanCardResponse(BaseModel):
    id: int
    title: str
    description: str = ""
    work_type: str
    column_key: str
    order_index: int
    existing_device_id: str | None = None
    linked_device: KanbanLinkedDevice | None = None
    draft_device: KanbanDraftDevice | None = None
    created_at: str
    updated_at: str


class KanbanBoardResponse(BaseModel):
    columns: list[str] = Field(default_factory=list)
    cards: list[KanbanCardResponse] = Field(default_factory=list)


class KanbanCardUpsertRequest(BaseModel):
    title: str
    description: str = ""
    work_type: str
    column_key: str = "draft"
    existing_device_id: str | None = None
    new_device_hostname: str = ""
    new_device_mgmt_ip: str = ""
    new_device_model: str = ""
    new_device_serial: str = ""


class KanbanCardMoveRequest(BaseModel):
    column_key: str
    position: int = 0
