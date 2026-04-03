from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.automation import (
    AutomationApplyResponse,
    AutomationConfigPreviewResponse,
    AutomationPlanResponse,
    AutomationPreviewRequest,
    AutomationSourceDeviceResponse,
    AutomationSourceResponse,
    AutomationToolDetailResponse,
    AutomationToolSummaryResponse,
)


router = APIRouter()


def _require_editor(request: Request) -> None:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    if user.get("role") not in {"admin", "editor"}:
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")


@router.get("/sources", response_model=list[AutomationSourceResponse])
def list_sources(request: Request) -> list[AutomationSourceResponse]:
    return request.app.state.automation_service.list_sources()


@router.get("/sources/{source_name}/devices", response_model=list[AutomationSourceDeviceResponse])
def list_source_devices(request: Request, source_name: str) -> list[AutomationSourceDeviceResponse]:
    try:
        return request.app.state.automation_service.list_source_devices(source_name)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get(
    "/sources/{source_name}/devices/{device_id}/config",
    response_model=AutomationConfigPreviewResponse,
)
def get_source_device_config(request: Request, source_name: str, device_id: str) -> AutomationConfigPreviewResponse:
    try:
        config = request.app.state.automation_service.get_source_device_config(source_name, device_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if config is None:
        raise HTTPException(status_code=404, detail="Config not found")
    return config


@router.get("/tools", response_model=list[AutomationToolSummaryResponse])
def list_tools(request: Request) -> list[AutomationToolSummaryResponse]:
    return request.app.state.automation_service.list_tools()


@router.get("/tools/{tool_slug}", response_model=AutomationToolDetailResponse)
def get_tool_detail(request: Request, tool_slug: str) -> AutomationToolDetailResponse:
    try:
        return request.app.state.automation_service.get_tool_detail(tool_slug)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/tools/{tool_slug}/preview", response_model=AutomationPlanResponse)
def preview_tool(request: Request, tool_slug: str, payload: AutomationPreviewRequest) -> AutomationPlanResponse:
    try:
        return request.app.state.automation_service.preview_tool(
            tool_slug,
            source_name=payload.source,
            target_mode=payload.target_mode,
            device_ids=payload.device_ids,
        )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/tools/{tool_slug}/apply", response_model=AutomationApplyResponse)
def apply_tool(request: Request, tool_slug: str, payload: AutomationPreviewRequest) -> AutomationApplyResponse:
    _require_editor(request)
    try:
        return request.app.state.automation_service.apply_tool(
            tool_slug,
            source_name=payload.source,
            target_mode=payload.target_mode,
            device_ids=payload.device_ids,
        )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
