from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from app.schemas.responses import WorkPlanProgressResponse
from app.schemas.workplan import WorkPlanExportRequest


router = APIRouter()


@router.post("/cards/{card_id}/jobs", response_model=WorkPlanProgressResponse)
def start_workplan_export_job(
    request: Request,
    card_id: int,
    payload: WorkPlanExportRequest,
) -> WorkPlanProgressResponse:
    try:
        progress = request.app.state.workplan_service.start_export_job(card_id, payload.dict())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WorkPlanProgressResponse(**progress)


@router.get("/jobs/{job_id}", response_model=WorkPlanProgressResponse)
def get_workplan_export_job(request: Request, job_id: str) -> WorkPlanProgressResponse:
    try:
        progress = request.app.state.workplan_service.get_job_progress(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return WorkPlanProgressResponse(**progress)


@router.get("/jobs/{job_id}/download")
def download_workplan_export_job(request: Request, job_id: str) -> FileResponse:
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
    try:
        stream, filename = request.app.state.workplan_service.export_workbook(card_id, payload.dict())
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
