from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.reservation import (
    BgpAsReservationCreateRequest,
    CardReservationListResponse,
    ReservationSummaryResponse,
    VniReservationCreateRequest,
)


router = APIRouter()


def _require_user(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def _require_editor(request: Request) -> dict:
    user = _require_user(request)
    if user.get("role") not in {"admin", "editor"}:
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    return user


@router.get("/cards/{card_id}", response_model=CardReservationListResponse)
def get_card_reservations(request: Request, card_id: int) -> CardReservationListResponse:
    _require_user(request)
    reservations = request.app.state.reservation_service.list_card_reservations(card_id)
    if not reservations:
        raise HTTPException(status_code=404, detail="Kanban card not found")
    return reservations


@router.post("/cards/{card_id}/bgp-as", response_model=ReservationSummaryResponse)
def create_bgp_as_reservation(
    request: Request,
    card_id: int,
    payload: BgpAsReservationCreateRequest,
) -> ReservationSummaryResponse:
    current_user = _require_editor(request)
    try:
        reservation = request.app.state.reservation_service.create_bgp_as_reservation(card_id, payload.asn, current_user)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return reservation


@router.post("/cards/{card_id}/vni", response_model=ReservationSummaryResponse)
def create_vni_reservation(
    request: Request,
    card_id: int,
    payload: VniReservationCreateRequest,
) -> ReservationSummaryResponse:
    current_user = _require_editor(request)
    try:
        reservation = request.app.state.reservation_service.create_vni_reservation(card_id, payload.vni, current_user)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return reservation


@router.post("/cards/{card_id}/bgp-as/{reservation_id}/cancel", response_model=ReservationSummaryResponse)
def cancel_bgp_as_reservation(request: Request, card_id: int, reservation_id: int) -> ReservationSummaryResponse:
    _require_editor(request)
    try:
        reservation = request.app.state.reservation_service.cancel_bgp_as_reservation(card_id, reservation_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return reservation


@router.post("/cards/{card_id}/vni/{reservation_id}/cancel", response_model=ReservationSummaryResponse)
def cancel_vni_reservation(request: Request, card_id: int, reservation_id: int) -> ReservationSummaryResponse:
    _require_editor(request)
    try:
        reservation = request.app.state.reservation_service.cancel_vni_reservation(card_id, reservation_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return reservation
