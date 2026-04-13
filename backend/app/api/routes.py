from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.bgp_management import BgpManagementEntryCreateRequest, BgpManagementEntryUpdateRequest
from app.schemas.responses import (
    BgpManagementManualEntry,
    BgpManagementResponse,
    CollectionProgressResponse,
    ConfigSearchResponse,
    ConfigPreviewResponse,
    DeviceSummary,
    LookupResponse,
    OverviewResponse,
    RecordListResponse,
    VmacGroupListResponse,
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


@router.get('/bgp/management', response_model=BgpManagementResponse)
def get_bgp_management_snapshot(request: Request) -> BgpManagementResponse:
    return request.app.state.query_service.get_bgp_management_snapshot()


@router.post('/bgp/management/entries', response_model=BgpManagementManualEntry)
def create_bgp_management_entry(
    request: Request,
    payload: BgpManagementEntryCreateRequest,
) -> BgpManagementManualEntry:
    _require_editor(request)
    normalized_asn = payload.asn.strip()
    if request.app.state.query_service.bgp_as_exists(normalized_asn):
        raise HTTPException(status_code=409, detail='이미 스냅샷에서 사용 중인 ASN입니다.')
    existing = request.app.state.bgp_management_repository.get_entry_by_asn(normalized_asn)
    if existing:
        raise HTTPException(status_code=409, detail='이미 등록된 ASN입니다.')
    user = request.state.current_user
    return request.app.state.bgp_management_repository.create_entry(
        asn=normalized_asn,
        entry_kind=payload.entry_kind.value,
        device_names=payload.device_names,
        note=payload.note,
        created_by_user_id=user.get('id'),
        created_by_name=user.get('display_name') or user.get('username') or '',
    )


@router.delete('/bgp/management/entries/{entry_id}')
def delete_bgp_management_entry(request: Request, entry_id: int) -> dict[str, bool]:
    _require_editor(request)
    deleted = request.app.state.bgp_management_repository.delete_entry(entry_id)
    if deleted <= 0:
        raise HTTPException(status_code=404, detail='등록된 항목을 찾을 수 없습니다.')
    return {'ok': True}


@router.patch('/bgp/management/entries/{entry_id}', response_model=BgpManagementManualEntry)
def update_bgp_management_entry(
    request: Request,
    entry_id: int,
    payload: BgpManagementEntryUpdateRequest,
) -> BgpManagementManualEntry:
    _require_editor(request)
    existing_entry = request.app.state.bgp_management_repository.get_entry(entry_id)
    if not existing_entry:
        raise HTTPException(status_code=404, detail='등록된 항목을 찾을 수 없습니다.')
    normalized_asn = payload.asn.strip()
    if request.app.state.query_service.bgp_as_exists(normalized_asn):
        raise HTTPException(status_code=409, detail='이미 스냅샷에서 사용 중인 ASN입니다.')
    duplicate = request.app.state.bgp_management_repository.get_entry_by_asn(normalized_asn)
    if duplicate and int(duplicate['id']) != entry_id:
        raise HTTPException(status_code=409, detail='이미 등록된 ASN입니다.')
    updated = request.app.state.bgp_management_repository.update_entry(
        entry_id,
        asn=normalized_asn,
        entry_kind=payload.entry_kind.value,
        device_names=payload.device_names,
        note=payload.note,
    )
    if not updated:
        raise HTTPException(status_code=404, detail='등록된 항목을 찾을 수 없습니다.')
    return updated


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


@router.get('/records/vmac', response_model=VmacGroupListResponse)
def list_vmac_records(
    request: Request,
    limit: int = Query(default=200, ge=1, le=10000),
    vmac: str | None = Query(default=None),
) -> VmacGroupListResponse:
    return request.app.state.query_service.list_vmac_groups(
        limit=limit,
        vmac=vmac,
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



