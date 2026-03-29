from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from .settings import get_settings


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Expected YAML mapping in {path}")
    return data


@lru_cache(maxsize=1)
def get_telemetry_paths() -> dict[str, Any]:
    return _load_yaml(get_settings().telemetry_paths_path)


@lru_cache(maxsize=1)
def get_field_mapping() -> dict[str, Any]:
    return _load_yaml(get_settings().field_mapping_path)
