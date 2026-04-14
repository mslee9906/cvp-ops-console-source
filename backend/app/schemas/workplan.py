from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class WorkPlanExportRequest(BaseModel):
    project_name: str = Field(default="", max_length=200)
    step_label: Literal["작업 전", "작업 후"] = Field(default="작업 전")
    source_workbook_name: str = Field(default="", max_length=255)
    source_workbook_base64: str = Field(default="")


class WorkPlanEvidenceStageSummary(BaseModel):
    step_label: Literal["작업 전", "작업 후"]
    exists: bool = False
    updated_at: str = ""
    workbook_filename: str = ""
    source_workbook_filename: str = ""
    snapshot_archive_filename: str = ""
    snapshot_output_count: int = 0
    history_count: int = 0


class WorkPlanEvidenceSummary(BaseModel):
    card_id: int
    project_name: str
    evidence_key: str
    root_path: str
    latest_path: str
    before: WorkPlanEvidenceStageSummary
    after: WorkPlanEvidenceStageSummary
    upload_log_count: int = 0
    upload_logs: list[str] = Field(default_factory=list)


class WinScpProfileInput(BaseModel):
    name: str = Field(default="", max_length=100)
    winscp_path: str = Field(default="", max_length=400)
    protocol: Literal["sftp", "scp", "ftp"] = Field(default="sftp")
    host: str = Field(default="", max_length=200)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=500)
    remote_path: str = Field(default="/", max_length=400)
    host_key: str = Field(default="", max_length=500)
    enabled: bool = Field(default=True)
    is_default: bool = Field(default=False)


class WinScpProfileConfig(WinScpProfileInput):
    id: int
    created_at: str = ""
    updated_at: str = ""


class WinScpProfileSaveRequest(BaseModel):
    profiles: list[WinScpProfileInput] = Field(default_factory=list)


class WorkPlanEvidenceUploadRequest(BaseModel):
    project_name: str = Field(default="", max_length=200)
    profile_id: int | None = None


class WorkPlanEvidenceUploadResponse(BaseModel):
    profile_id: int
    profile_name: str
    card_id: int
    project_name: str
    uploaded_at: str
    remote_path: str
    local_path: str
    log_path: str
