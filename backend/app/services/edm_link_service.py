from __future__ import annotations

from app.repositories.edm_link_repository import EdmLinkRepository


class EdmLinkService:
    def __init__(self, repository: EdmLinkRepository) -> None:
        self.repository = repository

    def initialize(self) -> None:
        self.repository.initialize()

    def list_links(self) -> list[dict]:
        return self.repository.list_links()

    def create_link(self, payload: dict) -> dict:
        return self.repository.create_link(payload)

    def update_link(self, link_id: int, changes: dict) -> dict | None:
        return self.repository.update_link(link_id, changes)

    def delete_link(self, link_id: int) -> bool:
        return self.repository.delete_link(link_id)
