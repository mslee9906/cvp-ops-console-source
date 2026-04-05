from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.backup import BackupCreateResponse, BackupItemResponse, BackupRestoreRequest, BackupRestoreResponse


router = APIRouter()


def _require_editor(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    if user.get("role") not in {"admin", "editor"}:
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    return user


@router.get("", response_model=list[BackupItemResponse])
def list_backups(request: Request) -> list[BackupItemResponse]:
    _require_editor(request)
    return request.app.state.backup_service.list_backups()


@router.post("", response_model=BackupCreateResponse)
def create_backup(request: Request) -> BackupCreateResponse:
    _require_editor(request)
    return request.app.state.backup_service.create_backup()


@router.post("/restore", response_model=BackupRestoreResponse)
def restore_backup(request: Request, payload: BackupRestoreRequest) -> BackupRestoreResponse:
    _require_editor(request)
    try:
        return request.app.state.backup_service.restore_backup(payload.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
