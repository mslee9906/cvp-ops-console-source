from __future__ import annotations

from typing import Any

from app.repositories.kanban_repository import KanbanRepository
from app.repositories.reservation_repository import ReservationRepository
from app.repositories.snapshot_repository import SnapshotRepository


class ReservationService:
    def __init__(
        self,
        repository: ReservationRepository,
        kanban_repository: KanbanRepository,
        snapshot_repository: SnapshotRepository,
    ) -> None:
        self.repository = repository
        self.kanban_repository = kanban_repository
        self.snapshot_repository = snapshot_repository

    def initialize(self) -> None:
        self.repository.initialize()

    def list_card_reservations(self, card_id: int) -> dict[str, Any] | None:
        card = self.kanban_repository.get_card(card_id)
        if not card:
            return None
        return {
            "card_id": card_id,
            "bgp_as": self.repository.list_card_bgp_as_reservations(card_id),
            "vni": self.repository.list_card_vni_reservations(card_id),
        }

    def create_bgp_as_reservation(self, card_id: int, asn: str, current_user: dict[str, Any]) -> dict[str, Any]:
        self._ensure_card_exists(card_id)
        normalized_asn = self._normalize_numeric_value(asn, "BGP AS")
        snapshot_matches = self.snapshot_repository.get_bgp_entries(normalized_asn)
        if snapshot_matches:
            raise ValueError(f"BGP AS {normalized_asn}는 현재 CVP snapshot에서 이미 사용 중입니다.")

        existing = self.repository.get_active_bgp_as_reservation(normalized_asn)
        if existing:
            if int(existing["card_id"]) == card_id:
                return existing
            reserved_card = existing["card_code"] or f"카드 {existing['card_id']}"
            raise ValueError(
                f"BGP AS {normalized_asn}는 이미 {reserved_card}에서 예약 중입니다."
            )

        return self.repository.create_bgp_as_reservation(
            card_id=card_id,
            asn=normalized_asn,
            reserved_by_user_id=int(current_user["id"]),
        )

    def create_vni_reservation(self, card_id: int, vni: str, current_user: dict[str, Any]) -> dict[str, Any]:
        self._ensure_card_exists(card_id)
        normalized_vni = self._normalize_numeric_value(vni, "VNI")
        snapshot_matches = self.snapshot_repository.get_vni_entries(vni=normalized_vni)
        if snapshot_matches:
            raise ValueError(f"VNI {normalized_vni}는 현재 CVP snapshot에서 이미 사용 중입니다.")

        existing = self.repository.get_active_vni_reservation(normalized_vni)
        if existing:
            if int(existing["card_id"]) == card_id:
                return existing
            reserved_card = existing["card_code"] or f"카드 {existing['card_id']}"
            raise ValueError(
                f"VNI {normalized_vni}는 이미 {reserved_card}에서 예약 중입니다."
            )

        return self.repository.create_vni_reservation(
            card_id=card_id,
            vni=normalized_vni,
            reserved_by_user_id=int(current_user["id"]),
        )

    def cancel_bgp_as_reservation(self, card_id: int, reservation_id: int) -> dict[str, Any]:
        reservation = self.repository.get_bgp_as_reservation(reservation_id)
        if not reservation or int(reservation["card_id"]) != card_id:
            raise LookupError("BGP AS reservation not found")
        return self.repository.cancel_bgp_as_reservation(reservation_id) or reservation

    def cancel_vni_reservation(self, card_id: int, reservation_id: int) -> dict[str, Any]:
        reservation = self.repository.get_vni_reservation(reservation_id)
        if not reservation or int(reservation["card_id"]) != card_id:
            raise LookupError("VNI reservation not found")
        return self.repository.cancel_vni_reservation(reservation_id) or reservation

    def reconcile_snapshot(self) -> dict[str, int]:
        bgp_asns = {
            str(item.get("asn") or "").strip()
            for item in self.snapshot_repository.list_bgp_entries(limit=None)
            if str(item.get("asn") or "").strip()
        }
        vnis = {
            str(item.get("vni") or "").strip()
            for item in self.snapshot_repository.get_vni_entries(limit=None)
            if str(item.get("vni") or "").strip()
        }
        return {
            "bgp_as": self.repository.fulfill_bgp_as_reservations(bgp_asns),
            "vni": self.repository.fulfill_vni_reservations(vnis),
        }

    def _ensure_card_exists(self, card_id: int) -> None:
        if not self.kanban_repository.get_card(card_id):
            raise LookupError("Kanban card not found")

    def _normalize_numeric_value(self, value: str, label: str) -> str:
        token = str(value or "").strip()
        if not token:
            raise ValueError(f"{label} 값이 비어 있습니다.")
        if not token.isdigit():
            raise ValueError(f"{label}는 숫자만 입력할 수 있습니다.")
        normalized = str(int(token))
        if int(normalized) <= 0:
            raise ValueError(f"{label}는 1 이상의 숫자여야 합니다.")
        return normalized
