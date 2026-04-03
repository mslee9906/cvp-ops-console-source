from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class EdmLinkColorKey(str, Enum):
    ocean = "ocean"
    forest = "forest"
    sunset = "sunset"
    plum = "plum"
    cobalt = "cobalt"
    slate = "slate"


class EdmLinkResponse(BaseModel):
    id: int
    title: str
    subtitle: str = ""
    link_type: str = ""
    url: str
    color_key: EdmLinkColorKey = EdmLinkColorKey.ocean
    sort_order: int
    created_at: str
    updated_at: str


class EdmLinkCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    subtitle: str = Field(default="", max_length=240)
    link_type: str = Field(default="", max_length=80)
    url: str = Field(..., min_length=1, max_length=1000)
    color_key: EdmLinkColorKey = EdmLinkColorKey.ocean


class EdmLinkUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    subtitle: str | None = Field(default=None, max_length=240)
    link_type: str | None = Field(default=None, max_length=80)
    url: str | None = Field(default=None, min_length=1, max_length=1000)
    color_key: EdmLinkColorKey | None = None
    sort_order: int | None = Field(default=None, ge=1)
