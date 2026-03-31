from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.schemas.edm_link import EdmLinkCreate, EdmLinkResponse, EdmLinkUpdate


router = APIRouter()


@router.get("", response_model=list[EdmLinkResponse])
def list_edm_links(request: Request) -> list[EdmLinkResponse]:
    return request.app.state.edm_link_service.list_links()


@router.post("", response_model=EdmLinkResponse)
def create_edm_link(request: Request, payload: EdmLinkCreate) -> EdmLinkResponse:
    return request.app.state.edm_link_service.create_link(payload.dict())


@router.patch("/{link_id}", response_model=EdmLinkResponse)
def update_edm_link(request: Request, link_id: int, payload: EdmLinkUpdate) -> EdmLinkResponse:
    link = request.app.state.edm_link_service.update_link(link_id, payload.dict(exclude_unset=True))
    if not link:
        raise HTTPException(status_code=404, detail="EDM link not found")
    return link


@router.delete("/{link_id}")
def delete_edm_link(request: Request, link_id: int) -> dict[str, bool]:
    deleted = request.app.state.edm_link_service.delete_link(link_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="EDM link not found")
    return {"ok": True}
