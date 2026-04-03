from __future__ import annotations

from typing import Any

from app.repositories.notification_repository import NotificationRepository


class NotificationService:
    def __init__(self, repository: NotificationRepository) -> None:
        self.repository = repository

    def initialize(self) -> None:
        self.repository.initialize()

    def list_notifications(self, user_id: int, limit: int = 20) -> dict[str, Any]:
        return {
            "items": self.repository.list_for_user(user_id, limit),
            "unread_count": self.repository.count_unread_for_user(user_id),
        }

    def notify(
        self,
        *,
        user_id: int | None,
        title: str,
        body: str = "",
        kind: str = "info",
        link_view: str = "",
        link_card_id: int | None = None,
        link_phase_id: str = "",
        created_by_user_id: int | None = None,
    ) -> dict[str, Any] | None:
        if not user_id:
            return None
        if not title.strip():
            return None
        return self.repository.create_notification(
            user_id=user_id,
            kind=kind,
            title=title.strip(),
            body=body.strip(),
            link_view=link_view.strip(),
            link_card_id=link_card_id,
            link_phase_id=link_phase_id.strip(),
            created_by_user_id=created_by_user_id,
        )

    def mark_read(self, notification_id: int, user_id: int) -> dict[str, Any] | None:
        return self.repository.mark_read(notification_id, user_id)

    def mark_all_read(self, user_id: int) -> int:
        return self.repository.mark_all_read(user_id)
