from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
from typing import Any


class MockCollectorSuite:
    def __init__(self, snapshot_path: Path) -> None:
        self.snapshot_path = Path(snapshot_path)

    def collect(self, progress_callback: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        if progress_callback:
            progress_callback({'progress_percent': 15, 'step': 'load_sample', 'detail': 'Loading the local sample snapshot.'})
        with self.snapshot_path.open('r', encoding='utf-8') as handle:
            payload = json.load(handle)
        if progress_callback:
            progress_callback({'progress_percent': 70, 'step': 'prepare_sample', 'detail': 'Preparing the sample snapshot payload.'})
        return payload

