from __future__ import annotations

from typing import Any, Protocol


SnapshotPayload = dict[str, Any]


class CollectorSuite(Protocol):
    def collect(self) -> SnapshotPayload:
        """Collect the latest CVP-derived operational snapshot."""
