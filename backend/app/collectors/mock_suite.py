from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
from typing import Any

from app.services.config_parser import extract_vmac_records


class MockCollectorSuite:
    def __init__(self, snapshot_path: Path) -> None:
        self.snapshot_path = Path(snapshot_path)

    def collect(self, progress_callback: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        if progress_callback:
            progress_callback({'progress_percent': 15, 'step': 'load_sample', 'detail': 'Loading the local sample snapshot.'})
        with self.snapshot_path.open('r', encoding='utf-8') as handle:
            payload = json.load(handle)
        for key in ('devices', 'bgp', 'vrfs', 'vlans', 'vnis', 'ip_records', 'vmacs', 'configs'):
            for item in payload.get(key, []):
                item.setdefault('cvp_source', 'demo')
        if not payload.get('vmacs') and payload.get('configs'):
            generated_vmacs: list[dict[str, Any]] = []
            for item in payload.get('configs', []):
                config_text = str(item.get('config_text') or '')
                if not config_text.strip():
                    continue
                generated_vmacs.extend(
                    extract_vmac_records(
                        str(item.get('device_id') or ''),
                        str(item.get('hostname') or item.get('device_id') or ''),
                        config_text,
                    )
                )
            for item in generated_vmacs:
                item.setdefault('cvp_source', 'demo')
            payload['vmacs'] = generated_vmacs
        if progress_callback:
            progress_callback({'progress_percent': 70, 'step': 'prepare_sample', 'detail': 'Preparing the sample snapshot payload.'})
        return payload

