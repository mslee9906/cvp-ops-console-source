from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


MonitoringSeverity = Literal["critical", "warning", "info"]
MonitoringStatus = Literal["active", "resolved"]
MonitoringSourceRuntime = Literal["connecting", "connected", "error", "paused"]


class MonitoringSourceInput(BaseModel):
    name: str = Field(default="")
    host: str = Field(default="")
    port: int = Field(default=443)
    username: str = Field(default="")
    password: str = Field(default="")
    enabled: bool = Field(default=True)


class MonitoringSourceConfig(BaseModel):
    id: int
    name: str
    host: str
    port: int
    username: str
    password: str
    enabled: bool
    status: MonitoringSourceRuntime
    status_detail: str
    last_event_at: str
    last_connected_at: str
    created_at: str
    updated_at: str


class MonitoringSourceSaveRequest(BaseModel):
    sources: list[MonitoringSourceInput]


class MonitoringEventItem(BaseModel):
    id: int
    source_id: int
    source_name: str
    source_host: str
    source_port: int
    event_id: str
    stream_type: int
    occurred_at: str
    stored_at: str
    occurred_unix_ms: int
    severity: MonitoringSeverity
    event_type: str
    title: str
    description: str
    message: str
    hostname: str
    interface_name: str
    comp_name: str
    hostname1: str
    hostname2: str
    device_id: str
    device_id2: str
    l2_peer: str
    is_l2_internal: bool
    maintenance_name: str
    overlay: bool
    status: MonitoringStatus
    acknowledged_at: str
    bootstrap_suppressed: bool
    cvp_link: str
    raw_json: dict[str, Any]


class MonitoringSourceLive(BaseModel):
    id: int
    name: str
    region: str
    host: str
    port: int
    enabled: bool
    status: MonitoringSourceRuntime
    status_label: str
    status_detail: str
    last_event_at: str
    last_connected_at: str
    events: list[MonitoringEventItem]


class MonitoringDashboardResponse(BaseModel):
    last_updated: str
    overlay_count: int
    maintenance_count: int
    source_count: int
    sources: list[MonitoringSourceLive]


class MonitoringHistoryResponse(BaseModel):
    items: list[MonitoringEventItem]
    total_count: int
