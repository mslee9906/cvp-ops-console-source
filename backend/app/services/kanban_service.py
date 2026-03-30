from __future__ import annotations

from app.repositories.kanban_repository import KanbanRepository


class KanbanService:
    def __init__(self, repository: KanbanRepository) -> None:
        self.repository = repository

    def initialize(self) -> None:
        self.repository.initialize()

    def list_cards(self) -> list[dict]:
        return self.repository.list_cards()

    def create_card(self, payload: dict) -> dict:
        return self.repository.create_card(payload)

    def update_card(self, card_id: int, changes: dict) -> dict | None:
        return self.repository.update_card(card_id, changes)

    def delete_card(self, card_id: int) -> bool:
        return self.repository.delete_card(card_id)

    def reorder_cards(self, items: list[dict]) -> list[dict]:
        return self.repository.reorder_cards(items)
