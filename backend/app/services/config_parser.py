from __future__ import annotations

import ipaddress
import re
from typing import Any


INTERFACE_RE = re.compile(r"^interface\s+(?P<name>\S+)$")
IP_PREFIX_RE = re.compile(r"^ip address\s+(?P<cidr>\d+\.\d+\.\d+\.\d+/\d+)(?:\s+secondary)?$")
IP_MASK_RE = re.compile(
    r"^ip address\s+(?P<address>\d+\.\d+\.\d+\.\d+)\s+(?P<mask>\d+\.\d+\.\d+\.\d+)(?:\s+secondary)?$",
)
VMAC_RE = re.compile(r"^ip virtual-router mac-address\s+(?P<vmac>[0-9a-fA-F:\.]+)$")
SVI_VLAN_RE = re.compile(r"^vlan(?P<vlan_id>\d+)$", re.IGNORECASE)
VXLAN_VLAN_VNI_RE = re.compile(r"^vxlan vlan\s+(?P<vlan_id>\d+)\s+vni\s+(?P<vni>\d+)$", re.IGNORECASE)


def reconstruct_config_lines(nodes: dict[str, dict[str, Any]]) -> str:
    if not nodes:
        return ""

    head_candidates = [key for key, node in nodes.items() if not node.get("previous")]
    if not head_candidates:
        next_links = {node.get("next") for node in nodes.values() if node.get("next")}
        head_candidates = [key for key in nodes if key not in next_links]
    current = head_candidates[0] if head_candidates else next(iter(nodes))

    ordered_lines: list[str] = []
    visited: set[str] = set()

    while current and current in nodes and current not in visited:
        visited.add(current)
        node = nodes[current]
        ordered_lines.append(str(node.get("text", "")))
        current = str(node.get("next", "")) if node.get("next") else ""

    for orphan_key in nodes:
        if orphan_key in visited:
            continue
        current = orphan_key
        while current and current in nodes and current not in visited:
            visited.add(current)
            node = nodes[current]
            ordered_lines.append(str(node.get("text", "")))
            current = str(node.get("next", "")) if node.get("next") else ""

    return "\n".join(ordered_lines).strip() + "\n"


def classify_ip_kind(interface_name: str) -> str:
    lowered = interface_name.lower()
    if lowered.startswith("loopback"):
        return "loopback"
    if lowered.startswith("management"):
        return "mgmt"
    if lowered.startswith("vlan"):
        return "svi"
    return "interface"


def _to_interface(raw_line: str) -> ipaddress.IPv4Interface | None:
    raw_line = raw_line.strip()

    prefix_match = IP_PREFIX_RE.match(raw_line)
    if prefix_match:
        return ipaddress.ip_interface(prefix_match.group("cidr"))

    mask_match = IP_MASK_RE.match(raw_line)
    if mask_match:
        address = mask_match.group("address")
        mask = mask_match.group("mask")
        return ipaddress.ip_interface(f"{address}/{mask}")

    return None


def extract_ip_records(device_id: str, hostname: str, config_text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current_interface = ""
    current_vrf = "default"

    for raw_line in config_text.splitlines():
        line = raw_line.rstrip()

        match = INTERFACE_RE.match(line)
        if match:
            current_interface = match.group("name")
            current_vrf = "default"
            continue

        if not current_interface:
            continue

        if line and not line.startswith(" "):
            current_interface = ""
            current_vrf = "default"
            continue

        stripped = line.strip()
        if stripped.startswith("vrf forwarding "):
            parts = stripped.split(maxsplit=2)
            current_vrf = parts[2] if len(parts) == 3 else "default"
            continue

        if stripped.startswith("ip address dhcp") or stripped.startswith("ip address negotiated"):
            continue

        ip_interface = _to_interface(stripped)
        if ip_interface is None:
            continue

        records.append(
            {
                "device_id": device_id,
                "hostname": hostname,
                "interface_name": current_interface,
                "ip": str(ip_interface),
                "address": str(ip_interface.ip),
                "prefix_length": ip_interface.network.prefixlen,
                "network": str(ip_interface.network),
                "vrf": current_vrf,
                "ip_kind": classify_ip_kind(current_interface),
                "source": "config",
            },
        )

    return records


def extract_vmac_records(device_id: str, hostname: str, config_text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current_interface = ""
    current_vlan_id = ""
    global_vmac = ""
    vxlan_vlan_ids: set[str] = set()

    for raw_line in config_text.splitlines():
        line = raw_line.rstrip()

        match = INTERFACE_RE.match(line)
        if match:
            current_interface = match.group("name")
            vlan_match = SVI_VLAN_RE.match(current_interface)
            current_vlan_id = vlan_match.group("vlan_id") if vlan_match else ""
            continue

        if not current_interface:
            stripped = line.strip()
            vmac_match = VMAC_RE.match(stripped)
            if vmac_match:
                global_vmac = normalize_vmac(vmac_match.group("vmac"))
            continue

        if line and not line.startswith(" "):
            current_interface = ""
            current_vlan_id = ""
            stripped = line.strip()
            vmac_match = VMAC_RE.match(stripped)
            if vmac_match:
                global_vmac = normalize_vmac(vmac_match.group("vmac"))
            continue

        stripped = line.strip()
        if current_interface.lower().startswith("vxlan"):
            vxlan_match = VXLAN_VLAN_VNI_RE.match(stripped)
            if vxlan_match:
                vxlan_vlan_ids.add(vxlan_match.group("vlan_id"))

        if not current_vlan_id:
            continue

        vmac_match = VMAC_RE.match(stripped)
        if not vmac_match:
            continue

        normalized_vmac = normalize_vmac(vmac_match.group("vmac"))
        if not normalized_vmac:
            continue

        records.append(
            {
                "device_id": device_id,
                "hostname": hostname,
                "interface_name": current_interface,
                "vlan_id": current_vlan_id,
                "vmac": normalized_vmac,
                "source": "config",
            }
        )

    if records:
        return records

    if global_vmac:
        if vxlan_vlan_ids:
            for vlan_id in sorted(vxlan_vlan_ids, key=lambda item: int(item)):
                records.append(
                    {
                        "device_id": device_id,
                        "hostname": hostname,
                        "interface_name": f"Vlan{vlan_id}",
                        "vlan_id": vlan_id,
                        "vmac": global_vmac,
                        "source": "config",
                    }
                )
        else:
            records.append(
                {
                    "device_id": device_id,
                    "hostname": hostname,
                    "interface_name": "global",
                    "vlan_id": "",
                    "vmac": global_vmac,
                    "source": "config",
                }
            )

    return records


def normalize_vmac(raw_value: str) -> str:
    token = str(raw_value or "").strip().lower()
    if not token:
        return ""

    hex_only = "".join(character for character in token if character in "0123456789abcdef")
    if len(hex_only) != 12:
        return ""
    return ":".join(hex_only[index : index + 2] for index in range(0, 12, 2))
