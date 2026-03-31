from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.kanban import (
    KanbanCardCreate,
    KanbanCardResponse,
    KanbanDiffRequest,
    KanbanDiffResponse,
    KanbanCardUpdate,
    KanbanReorderRequest,
    KanbanTargetSnapshotResponse,
    KanbanValidationRequest,
    KanbanValidationResponse,
)


router = APIRouter()


@router.get("/cards", response_model=list[KanbanCardResponse])
def list_kanban_cards(request: Request) -> list[KanbanCardResponse]:
    return request.app.state.kanban_service.list_cards()


@router.post("/cards", response_model=KanbanCardResponse)
def create_kanban_card(request: Request, payload: KanbanCardCreate) -> KanbanCardResponse:
    return request.app.state.kanban_service.create_card(payload.dict())


@router.post("/cards/reorder", response_model=list[KanbanCardResponse])
def reorder_kanban_cards(request: Request, payload: KanbanReorderRequest) -> list[KanbanCardResponse]:
    try:
        return request.app.state.kanban_service.reorder_cards([item.dict() for item in payload.items])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/cards/{card_id}", response_model=KanbanCardResponse)
def update_kanban_card(request: Request, card_id: int, payload: KanbanCardUpdate) -> KanbanCardResponse:
    card = request.app.state.kanban_service.update_card(card_id, payload.dict(exclude_unset=True))
    if not card:
        raise HTTPException(status_code=404, detail="Kanban card not found")
    return card


@router.delete("/cards/{card_id}")
def delete_kanban_card(request: Request, card_id: int) -> dict[str, bool]:
    deleted = request.app.state.kanban_service.delete_card(card_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Kanban card not found")
    return {"ok": True}


@router.get("/targets/{target_id}/snapshot", response_model=KanbanTargetSnapshotResponse)
def get_kanban_target_snapshot(request: Request, target_id: int) -> KanbanTargetSnapshotResponse:
    snapshot = request.app.state.kanban_service.get_target_snapshot(target_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Kanban target not found")
    return snapshot


@router.post("/validate", response_model=KanbanValidationResponse)
def validate_kanban_config(request: Request, payload: KanbanValidationRequest) -> KanbanValidationResponse:
    result = request.app.state.kanban_service.validate_planned_config(payload.target_id, payload.config_text)
    if not result:
        raise HTTPException(status_code=404, detail="Kanban target not found")
    return result


@router.post("/diff", response_model=KanbanDiffResponse)
def diff_kanban_config(request: Request, payload: KanbanDiffRequest) -> KanbanDiffResponse:
    result = request.app.state.kanban_service.build_diff(payload.target_id, payload.config_text)
    if not result:
        raise HTTPException(status_code=404, detail="Kanban target not found")
    return result
