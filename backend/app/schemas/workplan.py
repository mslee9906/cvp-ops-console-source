from __future__ import annotations

from pydantic import BaseModel, Field


class WorkPlanExportRequest(BaseModel):
    project_name: str = Field(default="", max_length=200)
