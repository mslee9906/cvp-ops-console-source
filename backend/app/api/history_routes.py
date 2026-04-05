from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.history import (
    WorkHistoryCompleteRequest,
    WorkHistoryDetailResponse,
    WorkHistoryItemResponse,
    WorkHistoryRestoreRequest,
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
def restore_history(request: Request, history_id: int, payload: WorkHistoryRestoreRequest) -> WorkHistoryRestoreResponse:
    current_user = _require_editor(request)
    result = request.app.state.history_service.restore_card(
        history_id,
        current_user,
        delete_history=payload.delete_history,
    )
    if not result:
        raise HTTPException(status_code=404, detail="History entry not found")

    restored_card = result.get("restored_card")
    restored_card_id = restored_card.get("id") if restored_card else None
    restored_workflow_payload = None
    if restored_card_id:
        workflow_document = request.app.state.workflow_service.get_card_workflow(int(restored_card_id))
        if workflow_document:
            restored_workflow_payload = WorkflowDocumentResponse(**workflow_document)
    if not restored_card:
        raise HTTPException(status_code=500, detail="Restored card could not be reloaded")
    return {
        "history_id": history_id,
        "history_deleted": bool(result.get("history_deleted")),
        "history": result.get("history"),
        "restored_card": restored_card,
        "restored_workflow": restored_workflow_payload,
    }


@router.delete("/{history_id}")
def delete_history(request: Request, history_id: int) -> dict[str, bool]:
    _require_editor(request)
    deleted = request.app.state.history_service.delete_history(history_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="History entry not found")
    return {"ok": True}
