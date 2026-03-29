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
        rows = self.repository.list_bgp_entries(limit=limit)
        return {
            'scope': 'bgp',
            'total_count': len(rows),
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

    def list_vlan(self, limit: int = 200) -> dict[str, Any]:
        rows = self.repository.get_vlan_entries()[:limit]
        return {
            'scope': 'vlan',
            'total_count': len(rows),
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
                    },
                }
                for item in rows
            ],
        }

    def list_ip(self, limit: int = 200, vrf: str | None = None) -> dict[str, Any]:
        rows = self.repository.get_ip_records(vrf)[:limit]
        return {
            'scope': 'ip',
            'total_count': len(rows),
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

        seen_networks: set[tuple[str, str]] = set()
        for row in rows:
            row_network = ipaddress.ip_network(row['network'], strict=False)
            dedupe_key = (row['device_id'], row['network'])
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

