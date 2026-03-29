from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.responses import (
    CollectionProgressResponse,
    ConfigPreviewResponse,
    DeviceSummary,
    LookupResponse,
    OverviewResponse,
    RecordListResponse,
)


router = APIRouter()


@router.get('/overview', response_model=OverviewResponse)
def get_overview(request: Request) -> OverviewResponse:
    return request.app.state.query_service.get_overview(request.app.state.source_mode)


@router.get('/devices', response_model=list[DeviceSummary])
def list_devices(request: Request) -> list[DeviceSummary]:
    return request.app.state.query_service.list_devices()


@router.get('/records/ip', response_model=RecordListResponse)
def list_ip_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=1000),
    vrf: str | None = Query(default=None),
) -> RecordListResponse:
    return request.app.state.query_service.list_ip(limit=limit, vrf=vrf)


@router.get('/records/bgp', response_model=RecordListResponse)
def list_bgp_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=1000),
) -> RecordListResponse:
    return request.app.state.query_service.list_bgp(limit=limit)


@router.get('/records/vlan', response_model=RecordListResponse)
def list_vlan_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=1000),
) -> RecordListResponse:
    return request.app.state.query_service.list_vlan(limit=limit)


@router.get('/records/vrf', response_model=RecordListResponse)
def list_vrf_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=1000),
) -> RecordListResponse:
    return request.app.state.query_service.list_vrf(limit=limit)


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
    progress = request.app.state.collection_service.start_refresh()
    request.app.state.source_mode = progress['source_mode']
    return progress

