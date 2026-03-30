from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.kanban import (
    KanbanCardCreate,
    KanbanCardResponse,
    KanbanCardUpdate,
    KanbanReorderRequest,
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
