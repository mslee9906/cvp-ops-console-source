from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class AutomationSourceResponse(BaseModel):
    name: str
    host: str
    port: int
    raw_device_count: int = 0
    latest_collected_at: str | None = None


class AutomationSourceDeviceResponse(BaseModel):
    raw_device_key: str
    cvp_source: str
    device_id: str
    hostname: str
    serial: str
    mgmt_ip: str = ""
    model: str = ""
    site: str = ""
    tags: list[str] = Field(default_factory=list)
    last_collected_at: str
    has_config: bool = False
    config_collected_at: str | None = None


class AutomationConfigPreviewResponse(BaseModel):
    cvp_source: str
    device_id: str
    hostname: str
    config_hash: str
    collected_at: str
    line_count: int
    file_path: str
    content: str


class AutomationApiStep(BaseModel):
    title: str
    target: str
    detail: str


class AutomationToolSummaryResponse(BaseModel):
    slug: str
    title: str
    summary: str
    workspace_name: str


class AutomationToolDetailResponse(BaseModel):
    slug: str
    title: str
    summary: str
    description: str
    workspace_name: str
    code_preview: str
    api_steps: list[AutomationApiStep] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AutomationPreviewRequest(BaseModel):
    source: str = Field(..., min_length=1)
    target_mode: Literal["selected", "all"] = "selected"
    device_ids: list[str] = Field(default_factory=list)


class AutomationTagOperation(BaseModel):
    action: Literal["add", "remove"]
    element_type: Literal["device", "interface"]
    label: str
    value: str
    device_id: str
    interface_id: str | None = None
    display_key: str


class AutomationResolvedDevice(BaseModel):
    device_id: str
    hostname: str


class AutomationPlanResponse(BaseModel):
    slug: str
    source: str
    target_mode: Literal["selected", "all"]
    requested_device_ids: list[str] = Field(default_factory=list)
    resolved_device_ids: list[str] = Field(default_factory=list)
    resolved_devices: list[AutomationResolvedDevice] = Field(default_factory=list)
    summary: str
    add_count: int = 0
    remove_count: int = 0
    operations: list[AutomationTagOperation] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AutomationWorkspaceResult(BaseModel):
    action: Literal["add", "remove"]
    workspace_name: str
    workspace_id: str
    change_control_ids: list[str] = Field(default_factory=list)


class AutomationApplyResponse(BaseModel):
    slug: str
    source: str
    target_mode: Literal["selected", "all"]
    requested_device_ids: list[str] = Field(default_factory=list)
    resolved_device_ids: list[str] = Field(default_factory=list)
    summary: str
    add_count: int = 0
    remove_count: int = 0
    workspaces: list[AutomationWorkspaceResult] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
