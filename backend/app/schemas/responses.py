from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class LookupStatus(str, Enum):
    available = "available"
    in_use = "in_use"
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


class RecordListResponse(BaseModel):
    scope: str
    total_count: int
    items: list[LookupMatch] = Field(default_factory=list)
