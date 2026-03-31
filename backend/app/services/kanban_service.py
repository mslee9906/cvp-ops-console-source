from __future__ import annotations

import difflib
import ipaddress
from pathlib import Path
import re
from typing import Any

from app.repositories.kanban_repository import KanbanRepository
from app.repositories.snapshot_repository import SnapshotRepository
from app.services.config_parser import extract_ip_records


ROUTER_BGP_RE = re.compile(r"^\s*router bgp (\S+)", re.MULTILINE)


class KanbanService:
    def __init__(self, repository: KanbanRepository, snapshot_repository: SnapshotRepository) -> None:
        self.repository = repository
        self.snapshot_repository = snapshot_repository

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

    def get_target_snapshot(self, target_id: int) -> dict[str, Any] | None:
        target = self.repository.get_target(target_id)
        if not target:
            return None

        device_id = str(target.get("cvp_device_id", "") or "").strip()
        linked_device = self.snapshot_repository.get_device(device_id) if device_id else None
        config = self.snapshot_repository.get_device_config(device_id) if device_id else None
        if config:
            file_path = Path(config["file_path"])
            config["content"] = file_path.read_text(encoding="utf-8") if file_path.exists() else ""

        return {
            "target": target,
            "linked_device": linked_device or {},
            "config": config or {},
            "bgp_entries": self.snapshot_repository.get_bgp_entries_for_device(device_id) if linked_device else [],
            "vrfs": self.snapshot_repository.get_vrf_entries_for_device(device_id) if linked_device else [],
            "vlans": self.snapshot_repository.get_vlan_entries_for_device(device_id) if linked_device else [],
            "vnis": self.snapshot_repository.get_vni_entries_for_device(device_id) if linked_device else [],
            "ip_records": self.snapshot_repository.get_ip_records_for_device(device_id) if linked_device else [],
        }

    def validate_planned_config(self, target_id: int, config_text: str = "") -> dict[str, Any] | None:
        target = self.repository.get_target(target_id)
        if not target:
            return None

        resolved_config = config_text.rstrip() if config_text.strip() else self._get_saved_config_text(target_id)
        device_scope = str(target.get("cvp_device_id", "") or "").strip()
        synthetic_device_id = device_scope or f"planned-target-{target_id}"
        parsed_ip_records = extract_ip_records(synthetic_device_id, target["display_name"], resolved_config)

        sections = [
            {
                "key": "bgp_asn",
                "title": "BGP ASN 중복",
                "items": self._validate_bgp_asns(target, resolved_config),
            },
            {
                "key": "loopback0",
                "title": "Loopback0 IP 중복",
                "items": self._validate_interface_addresses(target, parsed_ip_records, "Loopback0"),
            },
            {
                "key": "loopback1",
                "title": "Loopback1 IP 중복",
                "items": self._validate_interface_addresses(target, parsed_ip_records, "Loopback1"),
            },
            {
                "key": "ip_overlap",
                "title": "기타 IP / 서브넷 중복",
                "items": self._validate_general_ip_overlap(target, parsed_ip_records),
            },
        ]

        has_conflict = any(section["items"] for section in sections)
        return {
            "target_id": target_id,
            "has_conflict": has_conflict,
            "sections": sections,
        }

    def build_diff(self, target_id: int, config_text: str = "") -> dict[str, Any] | None:
        target = self.repository.get_target(target_id)
        if not target:
            return None

        planned_config = config_text.rstrip() if config_text.strip() else self._get_saved_config_text(target_id)
        device_id = str(target.get("cvp_device_id", "") or "").strip()
        snapshot_metadata = self.snapshot_repository.get_device_config(device_id) if device_id else None

        if target.get("target_kind") == "new" and not snapshot_metadata:
            return {
                "target_id": target_id,
                "snapshot_available": False,
                "snapshot_text": "",
                "planned_text": planned_config,
                "lines": [],
            }

        if not snapshot_metadata:
            return {
                "target_id": target_id,
                "snapshot_available": False,
                "snapshot_text": "",
                "planned_text": planned_config,
                "lines": [],
            }

        file_path = Path(snapshot_metadata["file_path"])
        snapshot_text = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
        return {
            "target_id": target_id,
            "snapshot_available": True,
            "snapshot_text": snapshot_text,
            "planned_text": planned_config,
            "lines": self._build_diff_lines(snapshot_text, planned_config),
        }

    def _validate_bgp_asns(self, target: dict[str, Any], config_text: str) -> list[dict[str, Any]]:
        linked_device_id = str(target.get("cvp_device_id", "") or "").strip()
        seen_asns: set[str] = set()
        items: list[dict[str, Any]] = []

        for match in ROUTER_BGP_RE.findall(config_text):
            asn = str(match).strip()
            if not asn or asn in seen_asns:
                continue
            seen_asns.add(asn)

            matches = [
                row
                for row in self.snapshot_repository.get_bgp_entries(asn)
                if str(row["device_id"]) != linked_device_id
            ]
            if not matches:
                continue

            items.append(
                {
                    "title": f"AS {asn} 이미 사용 중",
                    "body": f"현재 스냅샷에서 {len(matches)}개 BGP 컨텍스트가 같은 ASN을 사용하고 있습니다.",
                    "severity": "error",
                    "details": {
                        "asn": asn,
                        "matches": matches,
                    },
                }
            )

        return items

    def _validate_interface_addresses(
        self,
        target: dict[str, Any],
        parsed_ip_records: list[dict[str, Any]],
        interface_name: str,
    ) -> list[dict[str, Any]]:
        linked_device_id = str(target.get("cvp_device_id", "") or "").strip()
        items: list[dict[str, Any]] = []
        snapshot_rows = self.snapshot_repository.get_ip_records()

        for record in parsed_ip_records:
            if str(record.get("interface_name")) != interface_name:
                continue

            exact_matches = [
                row
                for row in snapshot_rows
                if str(row["address"]) == str(record.get("address"))
                and str(row["device_id"]) != linked_device_id
            ]
            if not exact_matches:
                continue

            items.append(
                {
                    "title": f"{interface_name} {record['address']} 중복",
                    "body": f"{interface_name} 주소가 현재 스냅샷의 다른 장비에 이미 존재합니다.",
                    "severity": "error",
                    "details": {
                        "address": record["address"],
                        "matches": exact_matches,
                    },
                }
            )

        return items

    def _validate_general_ip_overlap(
        self,
        target: dict[str, Any],
        parsed_ip_records: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        linked_device_id = str(target.get("cvp_device_id", "") or "").strip()
        snapshot_rows = [
            row
            for row in self.snapshot_repository.get_ip_records()
            if str(row["device_id"]) != linked_device_id
        ]
        items: list[dict[str, Any]] = []
        seen_titles: set[str] = set()

        for record in parsed_ip_records:
            interface_name = str(record.get("interface_name") or "")
            if interface_name in {"Loopback0", "Loopback1"}:
                continue

            exact_matches = [
                row
                for row in snapshot_rows
                if str(row["address"]) == str(record.get("address"))
            ]
            if exact_matches:
                title = f"{record['address']} 주소 중복"
                if title not in seen_titles:
                    items.append(
                        {
                            "title": title,
                            "body": "예정 Config의 IP 주소가 현재 스냅샷의 다른 장비에 이미 존재합니다.",
                            "severity": "error",
                            "details": {
                                "address": record["address"],
                                "matches": exact_matches,
                            },
                        }
                    )
                    seen_titles.add(title)
                continue

            planned_network = ipaddress.ip_network(str(record["network"]), strict=False)
            overlap_matches = [
                row
                for row in snapshot_rows
                if ipaddress.ip_network(str(row["network"]), strict=False).overlaps(planned_network)
            ]
            if overlap_matches:
                title = f"{record['network']} 서브넷 겹침"
                if title not in seen_titles:
                    items.append(
                        {
                            "title": title,
                            "body": "예정 Config의 서브넷이 현재 스냅샷의 기존 서브넷과 겹칩니다.",
                            "severity": "warning",
                            "details": {
                                "network": record["network"],
                                "matches": overlap_matches,
                            },
                        }
                    )
                    seen_titles.add(title)

        return items

    def _get_saved_config_text(self, target_id: int) -> str:
        saved = self.repository.get_planned_config(target_id)
        return str(saved.get("config_text", "") if saved else "")

    def _build_diff_lines(self, snapshot_text: str, planned_text: str) -> list[dict[str, Any]]:
        left_lines = snapshot_text.splitlines()
        right_lines = planned_text.splitlines()
        matcher = difflib.SequenceMatcher(a=left_lines, b=right_lines)
        diff_lines: list[dict[str, Any]] = []
        left_number = 1
        right_number = 1

        for opcode, left_start, left_end, right_start, right_end in matcher.get_opcodes():
            left_chunk = left_lines[left_start:left_end]
            right_chunk = right_lines[right_start:right_end]

            if opcode == "equal":
                for left_text, right_text in zip(left_chunk, right_chunk):
                    diff_lines.append(
                        {
                            "left_line_number": left_number,
                            "right_line_number": right_number,
                            "left_text": left_text,
                            "right_text": right_text,
                            "kind": "equal",
                        }
                    )
                    left_number += 1
                    right_number += 1
                continue

            if opcode == "delete":
                for left_text in left_chunk:
                    diff_lines.append(
                        {
                            "left_line_number": left_number,
                            "right_line_number": None,
                            "left_text": left_text,
                            "right_text": "",
                            "kind": "delete",
                        }
                    )
                    left_number += 1
                continue

            if opcode == "insert":
                for right_text in right_chunk:
                    diff_lines.append(
                        {
                            "left_line_number": None,
                            "right_line_number": right_number,
                            "left_text": "",
                            "right_text": right_text,
                            "kind": "insert",
                        }
                    )
                    right_number += 1
                continue

            max_length = max(len(left_chunk), len(right_chunk))
            for index in range(max_length):
                left_text = left_chunk[index] if index < len(left_chunk) else ""
                right_text = right_chunk[index] if index < len(right_chunk) else ""
                diff_lines.append(
                    {
                        "left_line_number": left_number if index < len(left_chunk) else None,
                        "right_line_number": right_number if index < len(right_chunk) else None,
                        "left_text": left_text,
                        "right_text": right_text,
                        "kind": "replace",
                    }
                )
                if index < len(left_chunk):
                    left_number += 1
                if index < len(right_chunk):
                    right_number += 1

        return diff_lines
