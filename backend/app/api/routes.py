from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.responses import (
    CollectionProgressResponse,
    ConfigSearchResponse,
    ConfigPreviewResponse,
    DeviceSummary,
    KanbanBoardResponse,
    KanbanCardMoveRequest,
    KanbanCardResponse,
    KanbanCardUpsertRequest,
    LookupResponse,
    OverviewResponse,
    RecordListResponse,
    VniGroupListResponse,
    VrfGroupListResponse,
)


router = APIRouter()


def _require_editor(request: Request) -> None:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail='로그인이 필요합니다.')
    if user.get("role") not in {"admin", "editor"}:
        raise HTTPException(status_code=403, detail='수정 권한이 없습니다.')


@router.get('/overview', response_model=OverviewResponse)
def get_overview(request: Request) -> OverviewResponse:
    return request.app.state.query_service.get_overview(request.app.state.source_mode)


@router.get('/devices', response_model=list[DeviceSummary])
def list_devices(request: Request) -> list[DeviceSummary]:
    return request.app.state.query_service.list_devices()


@router.get('/records/ip', response_model=RecordListResponse)
def list_ip_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
    vrf: str | None = Query(default=None),
) -> RecordListResponse:
    return request.app.state.query_service.list_ip(limit=limit, vrf=vrf)


@router.get('/records/bgp', response_model=RecordListResponse)
def list_bgp_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
) -> RecordListResponse:
    return request.app.state.query_service.list_bgp(limit=limit)


@router.get('/records/vlan', response_model=RecordListResponse)
def list_vlan_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
) -> RecordListResponse:
    return request.app.state.query_service.list_vlan(limit=limit)


@router.get('/records/vrf', response_model=VrfGroupListResponse)
def list_vrf_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
    exclude_default: bool = Query(default=False),
    name: str | None = Query(default=None),
) -> VrfGroupListResponse:
    return request.app.state.query_service.list_vrf_groups(
        limit=limit,
        exclude_default=exclude_default,
        name=name,
    )


@router.get('/records/vni', response_model=VniGroupListResponse)
def list_vni_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
    vni: str | None = Query(default=None),
) -> VniGroupListResponse:
    return request.app.state.query_service.list_vni_groups(
        limit=limit,
        vni=vni,
    )


@router.get('/search/config', response_model=ConfigSearchResponse)
def search_config_records(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(default=200, ge=1, le=10000),
) -> ConfigSearchResponse:
    return request.app.state.query_service.search_configs(q, limit=limit)


@router.get('/lookup/ip', response_model=LookupResponse)
def lookup_ip(
    request: Request,
    q: str = Query(..., min_length=2),
    vrf: str | None = Query(default=None),
) -> LookupResponse:
    return request.app.state.query_service.lookup_ip(q, vrf)


@router.get('/lookup/bgp', response_model=LookupResponse)
def lookup_bgp(
    request: Request,
    asn: str = Query(..., min_length=1),
) -> LookupResponse:
    return request.app.state.query_service.lookup_bgp(asn)


@router.get('/lookup/vlan', response_model=LookupResponse)
def lookup_vlan(
    request: Request,
    vlan_id: str | None = Query(default=None),
    name: str | None = Query(default=None),
) -> LookupResponse:
    if not (vlan_id or name):
        raise HTTPException(status_code=400, detail='vlan_id or name is required')
    return request.app.state.query_service.lookup_vlan(vlan_id, name)


@router.get('/lookup/vrf', response_model=LookupResponse)
def lookup_vrf(
    request: Request,
    name: str = Query(..., min_length=1),
) -> LookupResponse:
    return request.app.state.query_service.lookup_vrf(name)


@router.get('/devices/{device_id}/config', response_model=ConfigPreviewResponse)
def get_device_config(request: Request, device_id: str) -> ConfigPreviewResponse:
    config = request.app.state.query_service.get_device_config(device_id)
    if config is None:
        raise HTTPException(status_code=404, detail='Config not found')
    return config


@router.get('/collections/status', response_model=CollectionProgressResponse)
def get_collection_status(request: Request) -> CollectionProgressResponse:
    return request.app.state.collection_service.get_progress()


@router.post('/collections/refresh', response_model=CollectionProgressResponse)
def refresh_collection(request: Request) -> CollectionProgressResponse:
    _require_editor(request)
    progress = request.app.state.collection_service.start_refresh()
    request.app.state.source_mode = progress['source_mode']
    return progress


@router.get('/kanban/cards', response_model=KanbanBoardResponse)
def list_kanban_cards(request: Request) -> KanbanBoardResponse:
    return request.app.state.kanban_service.list_board()


@router.post('/kanban/cards', response_model=KanbanCardResponse)
def create_kanban_card(
    request: Request,
    payload: KanbanCardUpsertRequest,
) -> KanbanCardResponse:
    try:
        return request.app.state.kanban_service.create_card(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put('/kanban/cards/{card_id}', response_model=KanbanCardResponse)
def update_kanban_card(
    request: Request,
    card_id: int,
    payload: KanbanCardUpsertRequest,
) -> KanbanCardResponse:
    try:
        return request.app.state.kanban_service.update_card(card_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail='Card not found') from exc


@router.post('/kanban/cards/{card_id}/move', response_model=KanbanCardResponse)
def move_kanban_card(
    request: Request,
    card_id: int,
    payload: KanbanCardMoveRequest,
) -> KanbanCardResponse:
    try:
        return request.app.state.kanban_service.move_card(card_id, payload.column_key, payload.position)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail='Card not found') from exc

