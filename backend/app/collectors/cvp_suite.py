from __future__ import annotations

from datetime import datetime, timezone
from collections.abc import Callable
import json
import re
from typing import Any

from app.core.cvp_connector import CVPConnector
from app.core.path_config import get_field_mapping, get_telemetry_paths
from app.core.settings import Settings
from app.services.config_parser import extract_ip_records, reconstruct_config_lines


VALUE_RE = re.compile(r'"value"\s*:\s*"?([^"}]+)"?')


class CVPCollectorSuite:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.paths = get_telemetry_paths()
        self.fields = get_field_mapping()

    def collect(self, progress_callback: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        timestamp = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
        if progress_callback:
            progress_callback({'progress_percent': 5, 'step': 'connect', 'detail': 'Opening the CVP session.'})
        connector = CVPConnector(
            library_root=self.settings.cvp_library_root,
            host=self.settings.cvp_hostname,
            port=self.settings.cvp_resolved_port,
            token=self.settings.cvp_token,
            username=self.settings.cvp_username,
            password=self.settings.cvp_password,
            ca_file=self.settings.cvp_ca_file,
            cert_file=self.settings.cvp_cert_file,
            key_file=self.settings.cvp_key_file,
            insecure_tls=self.settings.cvp_insecure_tls,
        )

        with connector:
            if progress_callback:
                progress_callback({'progress_percent': 10, 'step': 'device_inventory', 'detail': 'Loading the analytics device inventory.'})
            devices = self._collect_devices(connector, timestamp)
            target_ids = self.settings.cvp_device_ids or list(devices)
            total_devices = max(len(target_ids), 1)

            snapshot_devices: list[dict[str, Any]] = []
            vrfs: list[dict[str, Any]] = []
            bgp: list[dict[str, Any]] = []
            vlans: list[dict[str, Any]] = []
            configs: list[dict[str, Any]] = []
            ip_records: list[dict[str, Any]] = []

            for index, device_id in enumerate(target_ids, start=1):
                device = devices.get(
                    device_id,
                    {
                        'device_id': device_id,
                        'hostname': device_id,
                        'serial': device_id,
                        'mgmt_ip': '',
                        'model': '',
                        'site': '',
                        'tags': [],
                        'last_collected_at': timestamp,
                    },
                )
                snapshot_devices.append(device)
                if progress_callback:
                    percent = 15 + int((index / total_devices) * 60)
                    progress_callback(
                        {
                            'progress_percent': percent,
                            'step': 'device_details',
                            'detail': f"Collecting data for {device['hostname']} ({index}/{total_devices}).",
                        }
                    )

                device_vrfs = self._collect_vrfs(connector, device_id, device)
                if not device_vrfs:
                    device_vrfs = [
                        {
                            'device_id': device_id,
                            'hostname': device['hostname'],
                            'vrf_name': 'default',
                            'vrf_id': '0',
                        },
                    ]
                vrfs.extend(device_vrfs)

                bgp.extend(self._collect_bgp(connector, device_id, device, device_vrfs))
                vlans.extend(self._collect_vlans(connector, device_id, device))

                config_text = self._collect_config(connector, device_id)
                if config_text:
                    configs.append(
                        {
                            'device_id': device_id,
                            'hostname': device['hostname'],
                            'collected_at': timestamp,
                            'config_text': config_text,
                        }
                    )
                    ip_records.extend(extract_ip_records(device_id, device['hostname'], config_text))

        if progress_callback:
            progress_callback({'progress_percent': 78, 'step': 'snapshot_ready', 'detail': 'Normalizing the collected data.'})
        return {
            'devices': snapshot_devices,
            'bgp': bgp,
            'vrfs': vrfs,
            'vlans': vlans,
            'ip_records': ip_records,
            'configs': configs,
        }

    def _collect_devices(self, connector: CVPConnector, timestamp: str) -> dict[str, dict[str, Any]]:
        device_path = self.paths['devices']['path_elements']
        updates = connector.get_merged_updates(self.paths['devices']['dataset'], device_path)
        devices: dict[str, dict[str, Any]] = {}
        for device_id, raw in updates.items():
            if not isinstance(raw, dict):
                continue
            devices[device_id] = {
                'device_id': device_id,
                'hostname': raw.get('hostname') or device_id,
                'serial': device_id,
                'mgmt_ip': raw.get('primaryManagementIP', ''),
                'model': raw.get('modelName', ''),
                'site': raw.get('containerName', ''),
                'tags': [],
                'last_collected_at': timestamp,
            }
        return devices

    def _collect_vrfs(
        self,
        connector: CVPConnector,
        device_id: str,
        device: dict[str, Any],
    ) -> list[dict[str, Any]]:
        updates = connector.get_merged_updates(device_id, self.paths['vrf']['path_elements'])
        vrfs: list[dict[str, Any]] = []
        for raw_key, raw_value in updates.items():
            value = raw_value if isinstance(raw_value, dict) else {}
            vrf_name = value.get(self.fields['vrf']['name_field'], '')
            if not vrf_name:
                continue
            vrfs.append(
                {
                    'device_id': device_id,
                    'hostname': device['hostname'],
                    'vrf_name': str(vrf_name),
                    'vrf_id': self._extract_scalar_from_key(raw_key),
                }
            )
        return vrfs

    def _collect_bgp(
        self,
        connector: CVPConnector,
        device_id: str,
        device: dict[str, Any],
        device_vrfs: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for vrf in device_vrfs:
            vrf_name = vrf['vrf_name']
            path = [
                self.paths['bgp']['device_root'],
                device_id,
                *self.paths['bgp']['path_suffix'],
                vrf_name,
            ]
            updates = connector.get_merged_updates(self.paths['bgp']['dataset'], path)
            if not updates:
                continue

            as_number = updates.get(self.fields['bgp']['asn_field'], {})
            if isinstance(as_number, dict):
                as_number = as_number.get(self.fields['bgp']['asn_value_field'], '')

            entries.append(
                {
                    'device_id': device_id,
                    'hostname': device['hostname'],
                    'vrf': vrf_name,
                    'asn': str(as_number),
                    'router_id': str(updates.get(self.fields['bgp']['router_id_field'], '')),
                    'shutdown': bool(updates.get(self.fields['bgp']['shutdown_field'], False)),
                    'source_path': '/' + '/'.join(str(item) for item in path),
                }
            )
        return [entry for entry in entries if entry['asn']]

    def _collect_vlans(
        self,
        connector: CVPConnector,
        device_id: str,
        device: dict[str, Any],
    ) -> list[dict[str, Any]]:
        vlan_updates = self._expand_child_map(
            connector,
            device_id,
            self.paths['vlan']['config_path'],
        )
        svi_updates = self._expand_child_map(
            connector,
            device_id,
            self.paths['vlan']['svi_path'],
        )

        svi_descriptions: dict[str, str] = {}
        for interface_key, raw in svi_updates.items():
            if not isinstance(raw, dict):
                continue
            interface_name = self._extract_interface_key(interface_key)
            if not interface_name.startswith('Vlan'):
                continue
            svi_descriptions[interface_name] = str(raw.get('description', '')) or 'X'

        vlans: list[dict[str, Any]] = []
        for raw_key, raw_value in vlan_updates.items():
            if not isinstance(raw_value, dict):
                continue
            if raw_value.get('configSource') != 'cli':
                continue

            vlan_id = self._extract_scalar_from_key(raw_key)
            if not vlan_id:
                continue

            vlan_name = str(raw_value.get('configuredName', '')).strip() or 'X'
            svi_name = f'Vlan{vlan_id}'
            description = svi_descriptions.get(svi_name, 'X')

            vlans.append(
                {
                    'device_id': device_id,
                    'hostname': device['hostname'],
                    'vlan_id': vlan_id,
                    'vlan_name': vlan_name,
                    'svi_name': svi_name if svi_name in svi_descriptions else 'X',
                    'description': description,
                    'source_path': '/' + '/'.join(self.paths['vlan']['config_path']),
                }
            )
        return vlans

    def _collect_config(self, connector: CVPConnector, device_id: str) -> str:
        updates = connector.get_merged_updates(device_id, self.paths['config']['path_elements'])
        nodes = {key: value for key, value in updates.items() if isinstance(value, dict)}
        return reconstruct_config_lines(nodes)

    def _extract_scalar_from_key(self, raw_key: str) -> str:
        if raw_key.startswith('{'):
            try:
                parsed = json.loads(raw_key)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict) and 'value' in parsed:
                return str(parsed['value'])

        match = VALUE_RE.search(raw_key)
        if match:
            return match.group(1)
        return str(raw_key)

    def _extract_interface_key(self, raw_key: str) -> str:
        if raw_key.startswith('{'):
            try:
                parsed = json.loads(raw_key)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict) and 'value' in parsed:
                return str(parsed['value'])
        return str(raw_key)

    def _expand_child_map(
        self,
        connector: CVPConnector,
        device_id: str,
        base_path: list[Any],
    ) -> dict[str, Any]:
        top_level = connector.get_merged_updates(device_id, base_path)
        expanded: dict[str, Any] = {}

        for raw_key in top_level:
            child_key = self._decode_key_object(raw_key)
            child_path = [*base_path, child_key]
            child_value = connector.get_merged_updates(device_id, child_path)
            expanded[raw_key] = child_value if child_value else top_level[raw_key]

        return expanded

    def _decode_key_object(self, raw_key: str) -> Any:
        if raw_key.startswith('{'):
            try:
                return json.loads(raw_key)
            except json.JSONDecodeError:
                return raw_key
        return raw_key

