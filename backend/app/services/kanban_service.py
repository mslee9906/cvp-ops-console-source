from __future__ import annotations

import difflib
import ipaddress
from pathlib import Path
import re
from typing import Any

from app.repositories.kanban_repository import KanbanRepository
from app.repositories.reservation_repository import ReservationRepository
from app.repositories.snapshot_repository import SnapshotRepository
from app.repositories.workflow_repository import WorkflowRepository
from app.services.config_parser import extract_ip_records, extract_vmac_records


ROUTER_BGP_RE = re.compile(r"^\s*router bgp (\S+)", re.MULTILINE)
VALID_KANBAN_COLUMN_KEYS = {"blocked", "planned", "ready", "in_progress", "verifying", "incident", "done"}


class KanbanService:
    def __init__(
        self,
        repository: KanbanRepository,
        snapshot_repository: SnapshotRepository,
        workflow_repository: WorkflowRepository,
        reservation_repository: ReservationRepository | None = None,
    ) -> None:
        self.repository = repository
        self.snapshot_repository = snapshot_repository
        self.workflow_repository = workflow_repository
        self.reservation_repository = reservation_repository

    def initialize(self) -> None:
        self.repository.initialize()

    def list_cards(self) -> list[dict]:
        return [self._apply_workflow_progress(card) for card in self.repository.list_cards()]

    def create_card(self, payload: dict, current_user: dict[str, Any] | None = None) -> dict:
        if current_user:
            payload["created_by_user_id"] = int(current_user["id"])
            payload["updated_by_user_id"] = int(current_user["id"])
        return self._apply_workflow_progress(self.repository.create_card(payload))

    def create_monitoring_alert_card(self, event: dict[str, Any]) -> dict:
        payload = {
            "title": str(event.get("title") or event.get("event_type") or "Monitoring Alert").strip(),
            "description": (
                str(event.get("description") or "").strip()
                or str(event.get("message") or "").strip()
                or str(event.get("event_type") or "").strip()
            ),
            "due_at": "",
            "assignee": "",
            "assignee_user_id": None,
            "created_by_label": "경고 발신",
            "column_key": "incident",
            "card_type": "existing",
            "priority": "high" if str(event.get("severity") or "").lower() == "critical" else "medium",
            "targets": self._build_monitoring_targets(event),
            "planned_configs": [],
            "checklist_items": [],
        }
        return self.create_card(payload, current_user=None)

    def update_card(self, card_id: int, changes: dict, current_user: dict[str, Any] | None = None) -> dict | None:
        if current_user:
            changes["updated_by_user_id"] = int(current_user["id"])
        card = self.repository.update_card(card_id, changes)
        return self._apply_workflow_progress(card) if card else None

    def get_card(self, card_id: int) -> dict | None:
        card = self.repository.get_card(card_id)
        return self._apply_workflow_progress(card) if card else None

    def delete_card(self, card_id: int) -> bool:
        return self.repository.delete_card(card_id)

    def clear_column_cards(self, column_key: str) -> int:
        normalized_column_key = str(column_key or "").strip()
        if normalized_column_key not in VALID_KANBAN_COLUMN_KEYS:
            raise ValueError("Unknown kanban column")
        return self.repository.delete_cards_by_column(normalized_column_key)

    def reorder_cards(self, items: list[dict]) -> list[dict]:
        return [self._apply_workflow_progress(card) for card in self.repository.reorder_cards(items)]

    def _apply_workflow_progress(self, card: dict[str, Any]) -> dict[str, Any]:
        card_id = int(card.get("id") or 0)
        if not card_id:
            return card

        document = self.workflow_repository.get_document(card_id)
        if not document:
            card["checklist_total"] = 0
            card["checklist_completed"] = 0
            card["progress_percent"] = 0
            return card

        completed, total = self._calculate_workflow_progress(document.get("workflow") or {})
        card["checklist_total"] = total
        card["checklist_completed"] = completed
        card["progress_percent"] = int(round((completed / total) * 100)) if total else 0
        return card

    def _calculate_workflow_progress(self, workflow: dict[str, Any]) -> tuple[int, int]:
        completed = 0
        total = 0

        for phase in workflow.get("phases") or []:
            for block in phase.get("blocks") or []:
                block_type = str(block.get("type") or "")
                if block_type == "table":
                    columns = block.get("columns") or []
                    status_key = next(
                        (str(column.get("key") or "status") for column in columns if str(column.get("type") or "") == "status"),
                        "status",
                    )
                    rows = block.get("rows") or []
                    total += len(rows)
                    completed += sum(
                        1
                        for row in rows
                        if str((row or {}).get(status_key) or "not_started") in {"done", "n_a"}
                    )
                    continue

                if block_type == "checklist":
                    items = block.get("items") or []
                    total += len(items)
                    completed += sum(1 for item in items if bool((item or {}).get("done", False)))

        return completed, total

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
            "vmac_entries": self.snapshot_repository.get_vmac_entries_for_device(device_id) if linked_device else [],
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
        parsed_vmac_records = extract_vmac_records(synthetic_device_id, target["display_name"], resolved_config)
        vmac_source = "planned_config"
        if not parsed_vmac_records and device_scope:
            snapshot_vmac_records = self.snapshot_repository.get_vmac_entries_for_device(device_scope)
            if snapshot_vmac_records:
                parsed_vmac_records = [
                    {
                        "device_id": str(item.get("device_id") or device_scope),
                        "hostname": str(item.get("hostname") or target["display_name"]),
                        "interface_name": str(item.get("interface_name") or ""),
                        "vlan_id": str(item.get("vlan_id") or ""),
                        "vmac": str(item.get("vmac") or ""),
                        "source": "snapshot",
                    }
                    for item in snapshot_vmac_records
                ]
                vmac_source = "snapshot"
        vmac_items, vmac_details = self._validate_vmac_consistency(target, parsed_vmac_records, vmac_source)

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
            {
                "key": "vmac_consistency",
                "title": "vMAC 일치성 검증",
                "items": vmac_items,
                "details": vmac_details,
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
            if matches:
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
                continue

            if self.reservation_repository:
                reservation = self.reservation_repository.get_active_bgp_as_reservation(asn)
                if reservation and int(reservation["card_id"]) != int(target.get("card_id") or 0):
                    reserved_card = reservation["card_code"] or f"카드 {reservation['card_id']}"
                    items.append(
                        {
                            "title": f"AS {asn} 예약 중",
                            "body": (
                                f"현재 작업 카드가 아닌 {reserved_card}에서 "
                                "이 ASN을 먼저 예약해 두었습니다."
                            ),
                            "severity": "warning",
                            "details": {
                                "asn": asn,
                                "reservation": reservation,
                                "matches": [
                                    {
                                        "device_id": f"reservation:{reservation['id']}",
                                        "hostname": reservation["card_code"] or "예약 항목",
                                        "vrf": "",
                                        "asn": reservation["value"],
                                    }
                                ],
                            },
                        }
                    )

        return items

    def _validate_vmac_consistency(
        self,
        target: dict[str, Any],
        parsed_vmac_records: list[dict[str, Any]],
        comparison_source: str = "planned_config",
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        linked_device_id = str(target.get("cvp_device_id", "") or "").strip()
        if not parsed_vmac_records:
            return [], {
                "source": comparison_source,
                "comparisons": [
                    {
                        "vlan_id": "",
                        "vni": "",
                        "planned_vmac": "",
                        "status": "info",
                        "reason": "no_vmac_source",
                        "candidate_vnis": [],
                        "peers": [],
                    }
                ],
            }

        vni_rows = self.snapshot_repository.get_vni_entries(limit=None)
        vmac_rows = self.snapshot_repository.get_vmac_entries(limit=None)
        vni_by_device_vlan = {
            (str(item.get("device_id") or ""), str(item.get("vlan_id") or "")): str(item.get("vni") or "")
            for item in vni_rows
            if str(item.get("device_id") or "").strip() and str(item.get("vlan_id") or "").strip()
        }
        vni_candidates_by_vlan: dict[str, set[str]] = {}
        for item in vni_rows:
            vlan_id = str(item.get("vlan_id") or "").strip()
            vni = str(item.get("vni") or "").strip()
            if vlan_id and vni:
                vni_candidates_by_vlan.setdefault(vlan_id, set()).add(vni)

        vmac_by_device_vlan = {
            (str(item.get("device_id") or ""), str(item.get("vlan_id") or "")): str(item.get("vmac") or "")
            for item in vmac_rows
            if str(item.get("device_id") or "").strip() and str(item.get("vlan_id") or "").strip()
        }

        items: list[dict[str, Any]] = []
        comparisons: list[dict[str, Any]] = []
        seen_vlans: set[str] = set()

        for record in parsed_vmac_records:
            vlan_id = str(record.get("vlan_id") or "").strip()
            planned_vmac = str(record.get("vmac") or "").strip().lower()
            if not vlan_id or not planned_vmac or vlan_id in seen_vlans:
                continue
            seen_vlans.add(vlan_id)

            resolved_vni = ""
            if linked_device_id:
                resolved_vni = vni_by_device_vlan.get((linked_device_id, vlan_id), "")

            if not resolved_vni:
                candidate_vnis = sorted(vni_candidates_by_vlan.get(vlan_id, set()), key=self._numeric_sort_key)
                if len(candidate_vnis) > 1:
                    items.append(
                        {
                            "title": f"VLAN {vlan_id} vMAC 비교 대상 확인 필요",
                            "body": "같은 VLAN ID가 여러 VNI에 연결되어 있어 어떤 확장 그룹과 비교해야 하는지 자동으로 확정할 수 없습니다.",
                            "severity": "warning",
                            "details": {
                                "vlan_id": vlan_id,
                                "planned_vmac": planned_vmac,
                                "candidate_vnis": candidate_vnis,
                            },
                        }
                    )
                    comparisons.append(
                        {
                            "vlan_id": vlan_id,
                            "vni": "",
                            "planned_vmac": planned_vmac,
                            "status": "review",
                            "reason": "multiple_candidate_vni",
                            "candidate_vnis": candidate_vnis,
                            "peers": [],
                        }
                    )
                    continue
                resolved_vni = candidate_vnis[0] if candidate_vnis else ""

            if not resolved_vni:
                comparisons.append(
                    {
                        "vlan_id": vlan_id,
                        "vni": "",
                        "planned_vmac": planned_vmac,
                        "status": "info",
                        "reason": "no_vni_context",
                        "candidate_vnis": [],
                        "peers": [],
                    }
                )
                continue

            peer_rows = []
            seen_peers: set[tuple[str, str]] = set()
            for item in vni_rows:
                candidate_vni = str(item.get("vni") or "").strip()
                candidate_vlan = str(item.get("vlan_id") or "").strip()
                candidate_device_id = str(item.get("device_id") or "").strip()
                if candidate_vni != resolved_vni or candidate_vlan != vlan_id:
                    continue
                if linked_device_id and candidate_device_id == linked_device_id:
                    continue
                dedupe_key = (candidate_device_id, candidate_vlan)
                if dedupe_key in seen_peers:
                    continue
                seen_peers.add(dedupe_key)
                peer_rows.append(item)

            if not peer_rows:
                comparisons.append(
                    {
                        "vlan_id": vlan_id,
                        "vni": resolved_vni,
                        "planned_vmac": planned_vmac,
                        "status": "info",
                        "reason": "no_peer_devices",
                        "candidate_vnis": [],
                        "peers": [],
                    }
                )
                continue

            mismatched_peers: list[dict[str, Any]] = []
            missing_peers: list[dict[str, Any]] = []
            matched_peers: list[dict[str, Any]] = []
            for peer in peer_rows:
                peer_device_id = str(peer.get("device_id") or "").strip()
                peer_vmac = str(vmac_by_device_vlan.get((peer_device_id, vlan_id), "") or "").strip().lower()
                peer_context = {
                    "device_id": peer_device_id,
                    "hostname": str(peer.get("hostname") or ""),
                    "vni": resolved_vni,
                    "vlan_id": vlan_id,
                    "interface_name": f"Vlan{vlan_id}",
                    "vmac": peer_vmac,
                }
                if not peer_vmac:
                    missing_peers.append(peer_context)
                    continue
                if peer_vmac != planned_vmac:
                    mismatched_peers.append(peer_context)
                    continue
                matched_peers.append(peer_context)

            if mismatched_peers:
                comparisons.append(
                    {
                        "vlan_id": vlan_id,
                        "vni": resolved_vni,
                        "planned_vmac": planned_vmac,
                        "status": "error",
                        "reason": "peer_mismatch",
                        "candidate_vnis": [],
                        "peers": matched_peers + mismatched_peers,
                    }
                )
                items.append(
                    {
                        "title": f"VLAN {vlan_id} vMAC 불일치",
                        "body": f"같은 VNI {resolved_vni}로 확장된 상대 장비와 vMAC 값이 다릅니다. 동일 L2 확장 장비는 같은 vMAC을 사용해야 합니다.",
                        "severity": "error",
                        "details": {
                            "vlan_id": vlan_id,
                            "vni": resolved_vni,
                            "planned_vmac": planned_vmac,
                            "matches": mismatched_peers,
                        },
                    }
                )
                continue

            if missing_peers:
                comparisons.append(
                    {
                        "vlan_id": vlan_id,
                        "vni": resolved_vni,
                        "planned_vmac": planned_vmac,
                        "status": "warning",
                        "reason": "peer_missing_vmac",
                        "candidate_vnis": [],
                        "peers": matched_peers + missing_peers,
                    }
                )
                items.append(
                    {
                        "title": f"VLAN {vlan_id} 상대 장비 vMAC 확인 필요",
                        "body": f"같은 VNI {resolved_vni}에 연결된 일부 상대 장비에 vMAC 설정이 없어 일치성 검증을 완전히 끝낼 수 없습니다.",
                        "severity": "warning",
                        "details": {
                            "vlan_id": vlan_id,
                            "vni": resolved_vni,
                            "planned_vmac": planned_vmac,
                            "matches": missing_peers,
                        },
                    }
                )
                continue

            comparisons.append(
                {
                    "vlan_id": vlan_id,
                    "vni": resolved_vni,
                    "planned_vmac": planned_vmac,
                    "status": "ok",
                    "reason": "all_peers_match",
                    "candidate_vnis": [],
                    "peers": matched_peers,
                }
            )
        return items, {"source": comparison_source, "comparisons": comparisons}

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

    def _build_monitoring_targets(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        targets: list[dict[str, Any]] = []
        seen_device_ids: set[str] = set()
        seen_names: set[str] = set()

        for device_id in [event.get("device_id"), event.get("device_id2")]:
            normalized_device_id = str(device_id or "").strip()
            if not normalized_device_id or normalized_device_id in seen_device_ids:
                continue
            device = self.snapshot_repository.get_device(normalized_device_id)
            if not device:
                continue
            seen_device_ids.add(normalized_device_id)
            seen_names.add(str(device.get("hostname") or "").strip().lower())
            targets.append(
                {
                    "target_kind": "existing",
                    "display_name": str(device.get("hostname") or normalized_device_id),
                    "mgmt_ip": str(device.get("mgmt_ip") or ""),
                    "model": str(device.get("model") or ""),
                    "role_hint": str(device.get("site") or ""),
                    "cvp_device_id": normalized_device_id,
                    "match_status": "linked_to_cvp",
                }
            )

        host_candidates = [
            event.get("hostname"),
            event.get("hostname1"),
            event.get("hostname2"),
            event.get("comp_name"),
        ]
        for host in host_candidates:
            normalized_host = str(host or "").strip()
            host_key = normalized_host.lower()
            if not normalized_host or host_key in seen_names:
                continue
            seen_names.add(host_key)
            device = self.snapshot_repository.find_device_by_hostname(normalized_host)
            if device:
                normalized_device_id = str(device.get("device_id") or "").strip()
                if normalized_device_id and normalized_device_id not in seen_device_ids:
                    seen_device_ids.add(normalized_device_id)
                    targets.append(
                        {
                            "target_kind": "existing",
                            "display_name": str(device.get("hostname") or normalized_host),
                            "mgmt_ip": str(device.get("mgmt_ip") or ""),
                            "model": str(device.get("model") or ""),
                            "role_hint": str(device.get("site") or ""),
                            "cvp_device_id": normalized_device_id,
                            "match_status": "linked_to_cvp",
                        }
                    )
                    continue
            targets.append(
                {
                    "target_kind": "existing",
                    "display_name": normalized_host,
                    "mgmt_ip": "",
                    "model": "",
                    "role_hint": "",
                    "cvp_device_id": "",
                    "match_status": "manual_only",
                }
            )

        return targets

    def _build_diff_lines(self, snapshot_text: str, planned_text: str) -> list[dict[str, Any]]:
        left_lines = self._prepare_diff_lines(snapshot_text)
        right_lines = self._prepare_diff_lines(planned_text)
        matcher = difflib.SequenceMatcher(
            a=self._build_diff_keys(left_lines),
            b=self._build_diff_keys(right_lines),
            autojunk=False,
        )
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
                            "kind": "equal" if left_text == right_text else "replace",
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

            for line_kind, left_text, right_text in self._align_replace_chunk(left_chunk, right_chunk):
                diff_lines.append(
                    {
                        "left_line_number": left_number if left_text is not None else None,
                        "right_line_number": right_number if right_text is not None else None,
                        "left_text": left_text or "",
                        "right_text": right_text or "",
                        "kind": line_kind,
                    }
                )
                if left_text is not None:
                    left_number += 1
                if right_text is not None:
                    right_number += 1

        return diff_lines

    def _split_config_lines(self, text: str) -> list[str]:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        if not normalized:
            return []

        lines = normalized.split("\n")
        if normalized.endswith("\n"):
            lines = lines[:-1]
        return lines

    def _prepare_diff_lines(self, text: str) -> list[str]:
        return [self._strip_leading_diff_indent(line) for line in self._split_config_lines(text)]

    def _strip_leading_diff_indent(self, line: str) -> str:
        return line.lstrip(" \t")

    def _build_diff_keys(self, lines: list[str]) -> list[str]:
        return [self._normalize_diff_line(line) for line in lines]

    def _normalize_diff_line(self, line: str) -> str:
        expanded = line.expandtabs(4).strip()
        if not expanded:
            return ""
        return " ".join(expanded.split())

    def _align_replace_chunk(self, left_chunk: list[str], right_chunk: list[str]) -> list[tuple[str, str | None, str | None]]:
        if not left_chunk:
            return [("insert", None, right_text) for right_text in right_chunk]
        if not right_chunk:
            return [("delete", left_text, None) for left_text in left_chunk]

        matcher = difflib.SequenceMatcher(
            a=self._build_diff_keys(left_chunk),
            b=self._build_diff_keys(right_chunk),
            autojunk=False,
        )
        aligned_rows: list[tuple[str, str | None, str | None]] = []

        for opcode, left_start, left_end, right_start, right_end in matcher.get_opcodes():
            left_slice = left_chunk[left_start:left_end]
            right_slice = right_chunk[right_start:right_end]

            if opcode == "equal":
                for left_text, right_text in zip(left_slice, right_slice):
                    aligned_rows.append(("equal" if left_text == right_text else "replace", left_text, right_text))
                continue

            if opcode == "delete":
                aligned_rows.extend(("delete", left_text, None) for left_text in left_slice)
                continue

            if opcode == "insert":
                aligned_rows.extend(("insert", None, right_text) for right_text in right_slice)
                continue

            aligned_rows.extend(self._pair_replace_slice(left_slice, right_slice))

        return aligned_rows

    def _pair_replace_slice(self, left_chunk: list[str], right_chunk: list[str]) -> list[tuple[str, str | None, str | None]]:
        if not left_chunk:
            return [("insert", None, right_text) for right_text in right_chunk]
        if not right_chunk:
            return [("delete", left_text, None) for left_text in left_chunk]

        max_matrix_cells = 160_000
        if len(left_chunk) * len(right_chunk) > max_matrix_cells:
            return self._pair_replace_slice_greedy(left_chunk, right_chunk)

        gap_cost = 1.0
        rows = len(left_chunk)
        cols = len(right_chunk)
        costs = [[0.0] * (cols + 1) for _ in range(rows + 1)]
        choices = [[""] * (cols + 1) for _ in range(rows + 1)]

        for left_index in range(1, rows + 1):
            costs[left_index][0] = left_index * gap_cost
            choices[left_index][0] = "delete"
        for right_index in range(1, cols + 1):
            costs[0][right_index] = right_index * gap_cost
            choices[0][right_index] = "insert"

        for left_index in range(1, rows + 1):
            for right_index in range(1, cols + 1):
                delete_cost = costs[left_index - 1][right_index] + gap_cost
                insert_cost = costs[left_index][right_index - 1] + gap_cost
                pair_cost = costs[left_index - 1][right_index - 1] + self._line_pair_cost(
                    left_chunk[left_index - 1],
                    right_chunk[right_index - 1],
                )

                if pair_cost < delete_cost and pair_cost < insert_cost:
                    costs[left_index][right_index] = pair_cost
                    choices[left_index][right_index] = "pair"
                elif delete_cost <= insert_cost:
                    costs[left_index][right_index] = delete_cost
                    choices[left_index][right_index] = "delete"
                else:
                    costs[left_index][right_index] = insert_cost
                    choices[left_index][right_index] = "insert"

        aligned_rows: list[tuple[str, str | None, str | None]] = []
        left_index = rows
        right_index = cols

        while left_index > 0 or right_index > 0:
            choice = choices[left_index][right_index]
            if choice == "pair":
                left_text = left_chunk[left_index - 1]
                right_text = right_chunk[right_index - 1]
                aligned_rows.append(("equal" if left_text == right_text else "replace", left_text, right_text))
                left_index -= 1
                right_index -= 1
                continue

            if choice == "delete":
                aligned_rows.append(("delete", left_chunk[left_index - 1], None))
                left_index -= 1
                continue

            aligned_rows.append(("insert", None, right_chunk[right_index - 1]))
            right_index -= 1

        aligned_rows.reverse()
        return aligned_rows

    def _pair_replace_slice_greedy(
        self,
        left_chunk: list[str],
        right_chunk: list[str],
    ) -> list[tuple[str, str | None, str | None]]:
        aligned_rows: list[tuple[str, str | None, str | None]] = []
        left_index = 0
        right_index = 0

        while left_index < len(left_chunk) or right_index < len(right_chunk):
            if left_index >= len(left_chunk):
                aligned_rows.extend(("insert", None, right_text) for right_text in right_chunk[right_index:])
                break
            if right_index >= len(right_chunk):
                aligned_rows.extend(("delete", left_text, None) for left_text in left_chunk[left_index:])
                break

            current_cost = self._line_pair_cost(left_chunk[left_index], right_chunk[right_index])
            next_insert_cost = (
                self._line_pair_cost(left_chunk[left_index], right_chunk[right_index + 1])
                if right_index + 1 < len(right_chunk)
                else float("inf")
            )
            next_delete_cost = (
                self._line_pair_cost(left_chunk[left_index + 1], right_chunk[right_index])
                if left_index + 1 < len(left_chunk)
                else float("inf")
            )

            if current_cost < 1.0:
                left_text = left_chunk[left_index]
                right_text = right_chunk[right_index]
                aligned_rows.append(("equal" if left_text == right_text else "replace", left_text, right_text))
                left_index += 1
                right_index += 1
            elif next_insert_cost < next_delete_cost:
                aligned_rows.append(("insert", None, right_chunk[right_index]))
                right_index += 1
            else:
                aligned_rows.append(("delete", left_chunk[left_index], None))
                left_index += 1

        return aligned_rows

    def _line_pair_cost(self, left_text: str, right_text: str) -> float:
        if left_text == right_text:
            return 0.0
        if not left_text or not right_text:
            return 2.2

        left_normalized = self._normalize_diff_line(left_text)
        right_normalized = self._normalize_diff_line(right_text)
        if left_normalized == right_normalized:
            return 0.18

        similarity = difflib.SequenceMatcher(a=left_normalized, b=right_normalized, autojunk=False).ratio()
        if similarity >= 0.9:
            return 0.35
        if similarity >= 0.78:
            return 0.7
        if similarity >= 0.65:
            return 0.95
        return 2.2

    def _numeric_sort_key(self, value: Any) -> tuple[int, str]:
        token = str(value or "").strip()
        return (0, f"{int(token):010d}") if token.isdigit() else (1, token.lower())
