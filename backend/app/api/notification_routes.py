from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas.notification import NotificationListResponse, NotificationResponse


router = APIRouter()


def _require_user(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    request: Request,
    limit: int = Query(default=20, ge=1, le=50),
) -> NotificationListResponse:
    user = _require_user(request)
    return request.app.state.notification_service.list_notifications(int(user["id"]), limit)


@router.post("/{notification_id}/read", response_model=NotificationResponse)
def mark_notification_read(request: Request, notification_id: int) -> NotificationResponse:
    user = _require_user(request)
    notification = request.app.state.notification_service.mark_read(notification_id, int(user["id"]))
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    return notification


@router.post("/read-all")
def mark_all_notifications_read(request: Request) -> dict[str, int | bool]:
    user = _require_user(request)
    updated = request.app.state.notification_service.mark_all_read(int(user["id"]))
    return {"ok": True, "updated": updated}
