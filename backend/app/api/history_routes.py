from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.history import (
    WorkHistoryCompleteRequest,
    WorkHistoryDetailResponse,
    WorkHistoryItemResponse,
    WorkHistoryRestoreResponse,
)
from app.schemas.workflow import WorkflowDocumentResponse


router = APIRouter()


def _require_editor(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    if user.get("role") not in {"admin", "editor"}:
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    return user


def _require_user(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


@router.get("", response_model=list[WorkHistoryItemResponse])
def list_history(request: Request) -> list[WorkHistoryItemResponse]:
    _require_user(request)
    return request.app.state.history_service.list_history()


@router.get("/{history_id}", response_model=WorkHistoryDetailResponse)
def get_history(request: Request, history_id: int) -> WorkHistoryDetailResponse:
    _require_user(request)
    entry = request.app.state.history_service.get_history(history_id)
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")
    return entry


@router.post("/cards/{card_id}/complete", response_model=WorkHistoryItemResponse)
def complete_card(request: Request, card_id: int, payload: WorkHistoryCompleteRequest) -> WorkHistoryItemResponse:
    entry = request.app.state.history_service.complete_card(
        card_id,
        completed_note=payload.completed_note,
        current_user=_require_editor(request),
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Kanban card not found")
    return entry


@router.post("/{history_id}/restore", response_model=WorkHistoryRestoreResponse)
def restore_history(request: Request, history_id: int) -> WorkHistoryRestoreResponse:
    current_user = _require_editor(request)
    history = request.app.state.history_service.restore_card(history_id, current_user)
    if not history:
        raise HTTPException(status_code=404, detail="History entry not found")

    restored_card_id = history.get("restored_card_id")
    restored_card = request.app.state.kanban_service.update_card(int(restored_card_id), {}) if restored_card_id else None
    restored_workflow_payload = None
    if restored_card_id:
        workflow_document = request.app.state.workflow_service.get_card_workflow(int(restored_card_id))
        if workflow_document:
            restored_workflow_payload = WorkflowDocumentResponse(**workflow_document)
    if not restored_card:
        raise HTTPException(status_code=500, detail="Restored card could not be reloaded")
    return {
        "history": history,
        "restored_card": restored_card,
        "restored_workflow": restored_workflow_payload,
    }
