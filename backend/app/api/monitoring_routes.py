from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.monitoring import (
    MonitoringDashboardResponse,
    MonitoringHistoryResponse,
    MonitoringSourceConfig,
    MonitoringSourceSaveRequest,
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


@router.get("/sources", response_model=list[MonitoringSourceConfig])
def list_monitoring_sources(request: Request) -> list[MonitoringSourceConfig]:
    _require_user(request)
    return request.app.state.monitoring_service.list_sources()


@router.put("/sources", response_model=list[MonitoringSourceConfig])
def save_monitoring_sources(request: Request, payload: MonitoringSourceSaveRequest) -> list[MonitoringSourceConfig]:
    _require_editor(request)
    return request.app.state.monitoring_service.save_sources([item.model_dump() for item in payload.sources])


@router.get("/live", response_model=MonitoringDashboardResponse)
def get_monitoring_live(request: Request) -> MonitoringDashboardResponse:
    _require_user(request)
    return request.app.state.monitoring_service.get_dashboard()


@router.post("/sources/{source_id}/acknowledge", response_model=MonitoringDashboardResponse)
def acknowledge_monitoring_source_alerts(request: Request, source_id: int) -> MonitoringDashboardResponse:
    _require_user(request)
    return request.app.state.monitoring_service.acknowledge_source_alerts(source_id)


@router.post("/live/refresh", response_model=MonitoringDashboardResponse)
def refresh_monitoring_live(request: Request) -> MonitoringDashboardResponse:
    _require_user(request)
    return request.app.state.monitoring_service.clear_live_events()


@router.get("/history", response_model=MonitoringHistoryResponse)
def get_monitoring_history(
    request: Request,
    query: str = Query(default=""),
    severity: str = Query(default=""),
    start_date: str = Query(default=""),
    end_date: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> MonitoringHistoryResponse:
    _require_user(request)
    return request.app.state.monitoring_service.get_history(
        query=query,
        severity=severity,
        start_date=start_date,
        end_date=end_date,
        limit=limit,
        offset=offset,
    )
