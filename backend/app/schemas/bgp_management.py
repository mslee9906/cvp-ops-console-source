from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, field_validator


class BgpManagementEntryKind(str, Enum):
    reserved = "reserved"
    custom = "custom"


class BgpManagementEntryCreateRequest(BaseModel):
    asn: str = Field(..., min_length=1, max_length=20)
    entry_kind: BgpManagementEntryKind
    device_names: list[str] = Field(default_factory=list)
    note: str = Field(default="", max_length=200)

    @field_validator("asn")
    @classmethod
    def normalize_asn(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if not normalized.isdigit():
            raise ValueError("ASN은 숫자만 입력할 수 있습니다.")
        return normalized

    @field_validator("device_names", mode="before")
    @classmethod
    def normalize_device_names(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            parts = value.replace(",", "\n").splitlines()
        elif isinstance(value, list):
            parts = [str(item or "") for item in value]
        else:
            raise ValueError("장비 목록 형식이 올바르지 않습니다.")
        normalized: list[str] = []
        seen: set[str] = set()
        for part in parts:
            entry = str(part or "").strip()
            if not entry:
                continue
            lowered = entry.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(entry)
        return normalized

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str) -> str:
        return str(value or "").strip()


class BgpManagementEntryUpdateRequest(BgpManagementEntryCreateRequest):
    pass
