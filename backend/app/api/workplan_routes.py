from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from app.schemas.responses import WorkPlanProgressResponse
from app.schemas.workplan import (
    WinScpProfileConfig,
    WinScpProfileSaveRequest,
    WorkPlanEvidenceSummary,
    WorkPlanEvidenceUploadRequest,
    WorkPlanEvidenceUploadResponse,
    WorkPlanExportRequest,
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


@router.post("/cards/{card_id}/jobs", response_model=WorkPlanProgressResponse)
def start_workplan_export_job(
    request: Request,
    card_id: int,
    payload: WorkPlanExportRequest,
) -> WorkPlanProgressResponse:
    _require_user(request)
    try:
        progress = request.app.state.workplan_service.start_export_job(card_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WorkPlanProgressResponse(**progress)


@router.get("/jobs/{job_id}", response_model=WorkPlanProgressResponse)
def get_workplan_export_job(request: Request, job_id: str) -> WorkPlanProgressResponse:
    _require_user(request)
    try:
        progress = request.app.state.workplan_service.get_job_progress(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return WorkPlanProgressResponse(**progress)


@router.get("/jobs/{job_id}/download")
def download_workplan_export_job(request: Request, job_id: str) -> FileResponse:
    _require_user(request)
    try:
        file_path, filename = request.app.state.workplan_service.download_job_workbook(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return FileResponse(
        file_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )


@router.get("/jobs/{job_id}/snapshot-archive")
def download_workplan_snapshot_archive(request: Request, job_id: str) -> FileResponse:
    _require_user(request)
    try:
        file_path, filename = request.app.state.workplan_service.download_job_snapshot_archive(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return FileResponse(
        file_path,
        media_type="application/zip",
        filename=filename,
    )


@router.post("/cards/{card_id}/export")
def export_workplan(request: Request, card_id: int, payload: WorkPlanExportRequest) -> StreamingResponse:
    _require_user(request)
    try:
        stream, filename = request.app.state.workplan_service.export_workbook(card_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    quoted_filename = quote(filename)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quoted_filename}",
    }
    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@router.get("/cards/{card_id}/evidence", response_model=WorkPlanEvidenceSummary)
def get_workplan_evidence(
    request: Request,
    card_id: int,
    project_name: str = Query(default=""),
) -> WorkPlanEvidenceSummary:
    _require_user(request)
    try:
        summary = request.app.state.workplan_service.get_evidence_summary(card_id, project_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WorkPlanEvidenceSummary(**summary)


@router.get("/winscp/profiles", response_model=list[WinScpProfileConfig])
def list_winscp_profiles(request: Request) -> list[WinScpProfileConfig]:
    _require_user(request)
    return [WinScpProfileConfig(**item) for item in request.app.state.winscp_service.list_profiles()]


@router.put("/winscp/profiles", response_model=list[WinScpProfileConfig])
def save_winscp_profiles(request: Request, payload: WinScpProfileSaveRequest) -> list[WinScpProfileConfig]:
    _require_editor(request)
    saved = request.app.state.winscp_service.save_profiles([item.model_dump() for item in payload.profiles])
    return [WinScpProfileConfig(**item) for item in saved]


@router.post("/cards/{card_id}/evidence/upload", response_model=WorkPlanEvidenceUploadResponse)
def upload_workplan_evidence(
    request: Request,
    card_id: int,
    payload: WorkPlanEvidenceUploadRequest,
) -> WorkPlanEvidenceUploadResponse:
    _require_user(request)
    try:
        result = request.app.state.winscp_service.upload_latest_evidence(
            card_id=card_id,
            project_name=payload.project_name,
            profile_id=payload.profile_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return WorkPlanEvidenceUploadResponse(**result)
