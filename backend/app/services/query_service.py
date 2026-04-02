from __future__ import annotations

import ipaddress
from pathlib import Path
from typing import Any

from app.repositories.snapshot_repository import SnapshotRepository
from app.schemas.responses import LookupResponse, LookupStatus


class QueryService:
    def __init__(self, repository: SnapshotRepository) -> None:
        self.repository = repository

    def get_overview(self, source_mode: str) -> dict[str, Any]:
        overview = self.repository.get_overview()
        overview['source_mode'] = source_mode
        return overview

    def list_devices(self) -> list[dict[str, Any]]:
        return self.repository.list_devices()

    def get_device_config(self, device_id: str) -> dict[str, Any] | None:
        metadata = self.repository.get_device_config(device_id)
        if not metadata:
            return None

        file_path = Path(metadata['file_path'])
        metadata['content'] = file_path.read_text(encoding='utf-8') if file_path.exists() else ''
        return metadata

    def list_bgp(self, limit: int = 200) -> dict[str, Any]:
        all_rows = self.repository.list_bgp_entries(limit=None)
        rows = all_rows[:limit]
        return {
            'scope': 'bgp',
            'total_count': len(all_rows),
            'items': [
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'vrf': item['vrf'],
                    'label': f"Router ID {item['router_id']}",
                    'details': {
                        'asn': item['asn'],
                        'router_id': item['router_id'],
                        'shutdown': bool(item['shutdown']),
                    },
                }
                for item in rows
            ],
        }

    def list_vrf(self, limit: int = 200) -> dict[str, Any]:
        rows = self.repository.list_vrf_entries(limit=limit)
        return {
            'scope': 'vrf',
            'total_count': len(rows),
            'items': [
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'label': f"VRF ID {item['vrf_id']}",
                    'details': {'vrf_name': item['vrf_name'], 'vrf_id': item['vrf_id']},
                }
                for item in rows
            ],
        }

    def list_vrf_groups(
        self,
        limit: int = 200,
        exclude_default: bool = False,
        name: str | None = None,
    ) -> dict[str, Any]:
        rows = self.repository.list_vrf_entries(limit=None)
        devices = {item['device_id']: item for item in self.repository.list_devices()}
        token = (name or '').strip().lower()
        grouped: dict[str, list[dict[str, str]]] = {}

        for row in rows:
            vrf_name = str(row['vrf_name'])
            if exclude_default and vrf_name.lower() == 'default':
                continue
            if token and token not in vrf_name.lower():
                continue

            device = devices.get(row['device_id'], {})
            grouped.setdefault(vrf_name, []).append(
                {
                    'device_id': row['device_id'],
                    'hostname': row['hostname'],
                    'mgmt_ip': str(device.get('mgmt_ip', '') or ''),
                }
            )

        items = [
            {
                'vrf_name': vrf_name,
                'device_count': len(sorted_devices),
                'devices': sorted_devices,
            }
            for vrf_name, sorted_devices in sorted(
                (
                    vrf_name,
                    sorted(device_rows, key=lambda item: item['hostname'].lower()),
                )
                for vrf_name, device_rows in grouped.items()
            )
        ]

        return {
            'scope': 'vrf',
            'total_count': len(items),
            'items': items[:limit],
        }

    def list_vni_groups(
        self,
        limit: int = 200,
        vni: str | None = None,
    ) -> dict[str, Any]:
        rows = self.repository.get_vni_entries()
        devices = {item['device_id']: item for item in self.repository.list_devices()}
        vlan_details = {
            (item['device_id'], str(item['vlan_id'])): item
            for item in self.repository.get_vlan_entries()
        }
        token = (vni or '').strip().lower()
        grouped: dict[str, list[dict[str, str]]] = {}

        for row in rows:
            vni_value = str(row['vni'])
            if token and token not in vni_value.lower():
                continue

            device = devices.get(row['device_id'], {})
            vlan_detail = vlan_details.get((row['device_id'], str(row['vlan_id'])), {})
            grouped.setdefault(vni_value, []).append(
                {
                    'device_id': row['device_id'],
                    'hostname': row['hostname'],
                    'mgmt_ip': str(device.get('mgmt_ip', '') or ''),
                    'vlan_id': str(row['vlan_id']),
                    'vlan_name': str(vlan_detail.get('vlan_name', '') or ''),
                }
            )

        items = []
        for vni_value, device_rows in grouped.items():
            sorted_devices = sorted(
                device_rows,
                key=lambda item: (self._numeric_sort_key(item['vlan_id']), item['hostname'].lower()),
            )
            vlan_ids = sorted({item['vlan_id'] for item in sorted_devices}, key=self._numeric_sort_key)
            items.append(
                {
                    'vni': vni_value,
                    'device_count': len({item['device_id'] for item in sorted_devices}),
                    'vlan_ids': vlan_ids,
                    'devices': sorted_devices,
                }
            )

        items.sort(key=lambda item: self._numeric_sort_key(item['vni']))
        return {
            'scope': 'vni',
            'total_count': len(items),
            'items': items[:limit],
        }

    def list_vlan(self, limit: int = 200) -> dict[str, Any]:
        all_rows = self.repository.get_vlan_entries()
        vni_context = self._build_vlan_vni_context()
        rows = all_rows[:limit]
        return {
            'scope': 'vlan',
            'total_count': len(all_rows),
            'items': [
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'interface_name': item['svi_name'],
                    'label': item['description'] or 'No description',
                    'details': {
                        'vlan_id': item['vlan_id'],
                        'vlan_name': item['vlan_name'],
                        'svi_name': item['svi_name'],
                        'description': item['description'],
                        **self._build_vlan_vni_details(item, vni_context),
                    },
                }
                for item in rows
            ],
        }

    def list_ip(self, limit: int = 200, vrf: str | None = None) -> dict[str, Any]:
        all_rows = self.repository.get_ip_records(vrf)
        rows = all_rows[:limit]
        return {
            'scope': 'ip',
            'total_count': len(all_rows),
            'items': [
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'interface_name': item['interface_name'],
                    'vrf': item['vrf'],
                    'label': item['ip_kind'],
                    'details': {
                        'ip': item['ip'],
                        'network': item['network'],
                        'vrf': item['vrf'],
                        'ip_kind': item['ip_kind'],
                    },
                }
                for item in rows
            ],
        }

    def search_configs(self, query: str, limit: int = 200) -> dict[str, Any]:
        token = query.strip()
        lowered = token.lower()
        matches: list[dict[str, Any]] = []
        total_line_matches = 0

        for item in self.repository.list_config_snapshots():
            file_path = Path(item['file_path'])
            if not file_path.exists():
                continue

            lines = file_path.read_text(encoding='utf-8').splitlines()
            matched_lines = [
                {'line_number': index, 'text': line.strip()}
                for index, line in enumerate(lines, start=1)
                if lowered in line.lower()
            ]
            if not matched_lines:
                continue

            total_line_matches += len(matched_lines)
            matches.append(
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'mgmt_ip': str(item.get('mgmt_ip', '') or ''),
                    'collected_at': item['collected_at'],
                    'match_count': len(matched_lines),
                    'matched_lines': matched_lines[:3],
                }
            )

        matches.sort(key=lambda item: (item['hostname'].lower(), item['device_id']))
        return {
            'query': token,
            'total_count': len(matches),
            'total_line_matches': total_line_matches,
            'items': matches[:limit],
        }

    def lookup_bgp(self, asn: str) -> LookupResponse:
        matches = self.repository.get_bgp_entries(asn)
        if matches:
            summary = f'AS {asn} is already used on {len(matches)} BGP context(s).'
            status = LookupStatus.in_use
        else:
            summary = f'AS {asn} is not present in the current CVP snapshot.'
            status = LookupStatus.available

        return LookupResponse(
            query=asn,
            scope='bgp',
            status=status,
            summary=summary,
            exact_match_count=len(matches),
            related_match_count=0,
            matches=[
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'vrf': item['vrf'],
                    'label': f"Router ID {item['router_id']}",
                    'details': {
                        'asn': item['asn'],
                        'router_id': item['router_id'],
                        'shutdown': bool(item['shutdown']),
                    },
                }
                for item in matches
            ],
        )

    def lookup_vrf(self, name: str) -> LookupResponse:
        matches = self.repository.get_vrf_entries(name)
        if matches:
            summary = f'VRF {name} is already defined on {len(matches)} device(s).'
            status = LookupStatus.in_use
        else:
            summary = f'VRF {name} is not present in the current CVP snapshot.'
            status = LookupStatus.available

        return LookupResponse(
            query=name,
            scope='vrf',
            status=status,
            summary=summary,
            exact_match_count=len(matches),
            related_match_count=0,
            matches=[
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'label': f"VRF ID {item['vrf_id']}",
                    'details': {'vrf_name': item['vrf_name'], 'vrf_id': item['vrf_id']},
                }
                for item in matches
            ],
        )

    def lookup_vlan(self, vlan_id: str | None = None, vlan_name: str | None = None) -> LookupResponse:
        normalized_id = vlan_id.strip() if vlan_id else ''
        normalized_name = vlan_name.strip() if vlan_name else ''
        matches = self.repository.get_vlan_entries(normalized_id or None, normalized_name or None)
        vni_context = self._build_vlan_vni_context()

        if normalized_id and normalized_name:
            id_matches = self.repository.get_vlan_entries(normalized_id, None)
            name_matches = self.repository.get_vlan_entries(None, normalized_name)
            if matches:
                status = LookupStatus.in_use
                summary = f'VLAN ID {normalized_id} with name {normalized_name} is already in use.'
            elif id_matches or name_matches:
                status = LookupStatus.review
                summary = (
                    f'VLAN ID {normalized_id} or name {normalized_name} already exists, '
                    'but not as the same combination.'
                )
                matches = id_matches + [item for item in name_matches if item not in id_matches]
            else:
                status = LookupStatus.available
                summary = f'VLAN ID {normalized_id} and name {normalized_name} are available in the current snapshot.'
        elif matches:
            if normalized_id:
                summary = f'VLAN ID {normalized_id} is already used on {len(matches)} device(s).'
            else:
                summary = f'VLAN name {normalized_name} is already used on {len(matches)} device(s).'
            status = LookupStatus.in_use
        else:
            token = normalized_id or normalized_name
            summary = f'VLAN lookup value {token} is not present in the current snapshot.'
            status = LookupStatus.available

        query = ' / '.join(part for part in [normalized_id, normalized_name] if part)
        return LookupResponse(
            query=query,
            scope='vlan',
            status=status,
            summary=summary,
            exact_match_count=len(matches) if status != LookupStatus.review else 0,
            related_match_count=len(matches) if status == LookupStatus.review else 0,
            matches=[
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'interface_name': item['svi_name'],
                    'label': item['description'] or 'No SVI description',
                    'details': {
                        'vlan_id': item['vlan_id'],
                        'vlan_name': item['vlan_name'],
                        'svi_name': item['svi_name'],
                        'description': item['description'],
                        **self._build_vlan_vni_details(item, vni_context),
                    },
                }
                for item in matches
            ],
        )

    def lookup_ip(self, query: str, vrf: str | None = None) -> LookupResponse:
        token = query.strip()
        rows = self.repository.get_ip_records(vrf)

        try:
            if '/' in token:
                search_network = ipaddress.ip_network(token, strict=False)
                return self._lookup_subnet(token, search_network, rows)
            search_ip = ipaddress.ip_address(token)
            return self._lookup_address(token, search_ip, rows)
        except ValueError:
            return LookupResponse(
                query=token,
                scope='ip',
                status=LookupStatus.error,
                summary='The entered IP value is not a valid address or prefix.',
            )

    def _lookup_address(
        self,
        query: str,
        search_ip: ipaddress._BaseAddress,
        rows: list[dict[str, Any]],
    ) -> LookupResponse:
        exact_matches: list[dict[str, Any]] = []
        overlap_matches: list[dict[str, Any]] = []

        for row in rows:
            row_interface = ipaddress.ip_interface(row['ip'])
            row_network = ipaddress.ip_network(row['network'], strict=False)
            if row_interface.ip == search_ip:
                exact_matches.append({**row, 'match_type': 'exact'})
            elif search_ip in row_network:
                overlap_matches.append({**row, 'match_type': 'subnet_context'})

        if exact_matches:
            if any(item['ip_kind'] in {'loopback', 'mgmt'} for item in exact_matches):
                status = LookupStatus.not_available
                summary = (
                    f'IP {query} is already assigned to a loopback or management interface, '
                    'so it should be treated as unavailable.'
                )
            else:
                status = LookupStatus.in_use
                summary = f'IP {query} is already assigned in the current snapshot.'
        elif overlap_matches:
            status = LookupStatus.review
            summary = (
                f'IP {query} is not assigned exactly, but it falls inside an existing subnet. '
                'Use it only after operational review.'
            )
        else:
            status = LookupStatus.available
            summary = f'IP {query} is not visible in the current snapshot.'

        matches = exact_matches + overlap_matches
        return LookupResponse(
            query=query,
            scope='ip',
            status=status,
            summary=summary,
            exact_match_count=len(exact_matches),
            related_match_count=len(overlap_matches),
            matches=[
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'interface_name': item['interface_name'],
                    'vrf': item['vrf'],
                    'match_type': item['match_type'],
                    'label': item['ip_kind'],
                    'details': {
                        'ip': item['ip'],
                        'network': item['network'],
                        'vrf': item['vrf'],
                        'ip_kind': item['ip_kind'],
                    },
                }
                for item in matches
            ],
        )

    def _lookup_subnet(
        self,
        query: str,
        search_network: ipaddress._BaseNetwork,
        rows: list[dict[str, Any]],
    ) -> LookupResponse:
        exact_matches: list[dict[str, Any]] = []
        overlap_matches: list[dict[str, Any]] = []

        seen_networks: set[tuple[str, str, str, str]] = set()
        for row in rows:
            row_network = ipaddress.ip_network(row['network'], strict=False)
            dedupe_key = (
                str(row['device_id']),
                str(row.get('interface_name', '') or ''),
                str(row.get('ip', '') or ''),
                str(row['network']),
            )
            if dedupe_key in seen_networks:
                continue
            seen_networks.add(dedupe_key)

            if row_network == search_network:
                exact_matches.append({**row, 'match_type': 'exact'})
            elif row_network.overlaps(search_network):
                overlap_matches.append({**row, 'match_type': 'overlap'})

        if exact_matches:
            status = LookupStatus.in_use
            summary = f'Subnet {query} already exists in the current snapshot.'
        elif overlap_matches:
            status = LookupStatus.review
            summary = f'Subnet {query} overlaps with an existing subnet and needs review.'
        else:
            status = LookupStatus.available
            summary = f'Subnet {query} is not visible in the current snapshot.'

        matches = exact_matches + overlap_matches
        return LookupResponse(
            query=query,
            scope='ip',
            status=status,
            summary=summary,
            exact_match_count=len(exact_matches),
            related_match_count=len(overlap_matches),
            matches=[
                {
                    'device_id': item['device_id'],
                    'hostname': item['hostname'],
                    'interface_name': item['interface_name'],
                    'vrf': item['vrf'],
                    'match_type': item['match_type'],
                    'label': item['ip_kind'],
                    'details': {
                        'network': item['network'],
                        'ip': item['ip'],
                        'vrf': item['vrf'],
                        'ip_kind': item['ip_kind'],
                    },
                }
                for item in matches
            ],
        )

    def _build_vlan_vni_context(self) -> dict[str, Any]:
        vni_entries = self.repository.get_vni_entries()
        vni_by_vlan: dict[tuple[str, str], str] = {}
        vlan_ids_by_vni: dict[str, set[str]] = {}
        hostnames_by_vni: dict[str, set[str]] = {}
        device_ids_by_vni: dict[str, set[str]] = {}

        for item in vni_entries:
            vlan_key = (item['device_id'], str(item['vlan_id']))
            vni_value = str(item['vni'])
            vni_by_vlan[vlan_key] = vni_value
            vlan_ids_by_vni.setdefault(vni_value, set()).add(str(item['vlan_id']))
            hostnames_by_vni.setdefault(vni_value, set()).add(item['hostname'])
            device_ids_by_vni.setdefault(vni_value, set()).add(item['device_id'])

        return {
            'vni_by_vlan': vni_by_vlan,
            'vlan_ids_by_vni': vlan_ids_by_vni,
            'hostnames_by_vni': hostnames_by_vni,
            'device_ids_by_vni': device_ids_by_vni,
        }

    def _build_vlan_vni_details(
        self,
        vlan_item: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        vlan_key = (vlan_item['device_id'], str(vlan_item['vlan_id']))
        vni_value = context['vni_by_vlan'].get(vlan_key, '')
        shared_vlan_ids = sorted(context['vlan_ids_by_vni'].get(vni_value, set()), key=self._numeric_sort_key)
        shared_hostnames = sorted(context['hostnames_by_vni'].get(vni_value, set()))
        shared_device_ids = context['device_ids_by_vni'].get(vni_value, set())

        extension_summary = '-'
        if vni_value:
            if len(shared_vlan_ids) > 1:
                extension_summary = ', '.join(shared_vlan_ids)
            else:
                extension_summary = f'동일 VLAN {shared_vlan_ids[0]}' if shared_vlan_ids else '-'

        return {
            'vni': vni_value,
            'shared_vlan_ids': shared_vlan_ids,
            'shared_hostnames': shared_hostnames,
            'shared_device_count': len(shared_device_ids),
            'l2_extension_summary': extension_summary,
        }

    def _numeric_sort_key(self, value: Any) -> tuple[int, str]:
        token = str(value)
        return (0, f"{int(token):010d}") if token.isdigit() else (1, token.lower())
