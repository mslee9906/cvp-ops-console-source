from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class ReservationKind(str, Enum):
    bgp_as = "bgp_as"
    vni = "vni"


class ReservationStatus(str, Enum):
    reserved = "reserved"
    fulfilled = "fulfilled"
    cancelled = "cancelled"


class ReservationSummaryResponse(BaseModel):
    id: int
    kind: ReservationKind
    value: str
    status: ReservationStatus
    card_id: int
    card_code: str = ""
    card_title: str = ""
    reserved_by_user_id: int | None = None
    reserved_by_name: str = ""
    created_at: str
    updated_at: str
    fulfilled_at: str = ""
    cancelled_at: str = ""


class CardReservationListResponse(BaseModel):
    card_id: int
    bgp_as: list[ReservationSummaryResponse] = Field(default_factory=list)
    vni: list[ReservationSummaryResponse] = Field(default_factory=list)


class BgpAsReservationCreateRequest(BaseModel):
    asn: str = Field(..., min_length=1, max_length=20)


class VniReservationCreateRequest(BaseModel):
    vni: str = Field(..., min_length=1, max_length=20)
