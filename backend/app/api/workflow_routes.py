from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.workflow import (
    WorkflowDocumentResponse,
    WorkflowDocumentUpdateRequest,
    WorkflowPhaseCompleteResponse,
    WorkflowTemplateCreateRequest,
    WorkflowTemplateResponse,
    WorkflowTemplateUpdateRequest,
)


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


@router.get("/cards/{card_id}", response_model=WorkflowDocumentResponse)
def get_card_workflow(request: Request, card_id: int) -> WorkflowDocumentResponse:
    document = request.app.state.workflow_service.get_card_workflow(card_id)
    if not document:
        raise HTTPException(status_code=404, detail="Workflow card not found")
    return document


@router.put("/cards/{card_id}", response_model=WorkflowDocumentResponse)
def save_card_workflow(
    request: Request,
    card_id: int,
    payload: WorkflowDocumentUpdateRequest,
) -> WorkflowDocumentResponse:
    document = request.app.state.workflow_service.save_card_workflow(
        card_id,
        payload.workflow,
        _require_editor(request),
    )
    if not document:
        raise HTTPException(status_code=404, detail="Workflow card not found")
    return document


@router.post("/cards/{card_id}/phases/{phase_id}/complete", response_model=WorkflowPhaseCompleteResponse)
def complete_card_phase(request: Request, card_id: int, phase_id: str) -> WorkflowPhaseCompleteResponse:
    try:
        document = request.app.state.workflow_service.complete_phase(
            card_id,
            phase_id,
            _require_user(request),
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not document:
        raise HTTPException(status_code=404, detail="Workflow card not found")
    return document


@router.post("/cards/{card_id}/phases/{phase_id}/uncomplete", response_model=WorkflowDocumentResponse)
def uncomplete_card_phase(request: Request, card_id: int, phase_id: str) -> WorkflowDocumentResponse:
    try:
        document = request.app.state.workflow_service.uncomplete_phase(
            card_id,
            phase_id,
            _require_user(request),
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not document:
        raise HTTPException(status_code=404, detail="Workflow card not found")
    return document


@router.get("/templates", response_model=list[WorkflowTemplateResponse])
def list_workflow_templates(
    request: Request,
    card_type: str | None = Query(default=None),
) -> list[WorkflowTemplateResponse]:
    return request.app.state.workflow_service.list_templates(card_type)


@router.post("/templates", response_model=WorkflowTemplateResponse)
def create_workflow_template(
    request: Request,
    payload: WorkflowTemplateCreateRequest,
) -> WorkflowTemplateResponse:
    return request.app.state.workflow_service.create_template(payload.dict(), _require_editor(request))


@router.patch("/templates/{template_id}", response_model=WorkflowTemplateResponse)
def update_workflow_template(
    request: Request,
    template_id: int,
    payload: WorkflowTemplateUpdateRequest,
) -> WorkflowTemplateResponse:
    template = request.app.state.workflow_service.update_template(
        template_id,
        payload.dict(exclude_unset=True),
        _require_editor(request),
    )
    if not template:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    return template


@router.delete("/templates/{template_id}")
def delete_workflow_template(request: Request, template_id: int) -> dict[str, bool]:
    _require_editor(request)
    deleted = request.app.state.workflow_service.delete_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Workflow template not found or protected")
    return {"ok": True}
