from __future__ import annotations

from pydantic import BaseModel, Field


class BackupItemResponse(BaseModel):
    name: str
    path: str
    created_at: str


class BackupCreateResponse(BackupItemResponse):
    files: list[str] = Field(default_factory=list)


class BackupRestoreRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class BackupRestoreResponse(BaseModel):
    name: str
    restored_at: str
