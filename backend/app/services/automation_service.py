from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.settings import Settings
from app.repositories.snapshot_repository import SnapshotRepository
from app.tools import tool_ip_interface_tags, tool_lldp_tags
from app.tools.common import AutomationTagOperationData, AutomationToolPlanData, CVPAutomationRuntime


TOOL_REGISTRY = {
    tool_ip_interface_tags.TOOL_SLUG: tool_ip_interface_tags,
    tool_lldp_tags.TOOL_SLUG: tool_lldp_tags,
}


class AutomationService:
    def __init__(self, repository: SnapshotRepository, settings: Settings) -> None:
        self.repository = repository
        self.settings = settings

    def list_sources(self) -> list[dict[str, Any]]:
        raw_source_map = {row["cvp_source"]: row for row in self.repository.list_raw_sources()}
        items: list[dict[str, Any]] = []
        for source in self.settings.cvp_sources:
            raw_snapshot = raw_source_map.get(source.name, {})
            items.append(
                {
                    "name": source.name,
                    "host": source.host,
                    "port": source.port,
                    "raw_device_count": int(raw_snapshot.get("raw_device_count", 0) or 0),
                    "latest_collected_at": raw_snapshot.get("latest_collected_at"),
                }
            )
        return items

    def list_source_devices(self, source_name: str) -> list[dict[str, Any]]:
        self._resolve_source(source_name)
        return self.repository.list_raw_devices(source_name)

    def get_source_device_config(self, source_name: str, device_id: str) -> dict[str, Any] | None:
        self._resolve_source(source_name)
        metadata = self.repository.get_raw_device_config(source_name, device_id)
        if not metadata:
            return None
        file_path = Path(metadata["file_path"])
        metadata["content"] = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
        return metadata

    def list_tools(self) -> list[dict[str, Any]]:
        return [TOOL_REGISTRY[slug].summary() for slug in TOOL_REGISTRY]

    def get_tool_detail(self, slug: str) -> dict[str, Any]:
        tool_module = self._resolve_tool(slug)
        return tool_module.detail()

    def preview_tool(
        self,
        slug: str,
        *,
        source_name: str,
        target_mode: str,
        device_ids: list[str],
    ) -> dict[str, Any]:
        runtime = self._build_runtime(source_name)
        tool_module = self._resolve_tool(slug)
        plan = tool_module.preview(
            runtime,
            target_mode=target_mode,
            requested_device_ids=device_ids,
        )
        return self._serialize_plan(plan)

    def apply_tool(
        self,
        slug: str,
        *,
        source_name: str,
        target_mode: str,
        device_ids: list[str],
    ) -> dict[str, Any]:
        runtime = self._build_runtime(source_name)
        tool_module = self._resolve_tool(slug)
        plan = tool_module.preview(
            runtime,
            target_mode=target_mode,
            requested_device_ids=device_ids,
        )
        workspaces = tool_module.apply(runtime, plan)
        return {
            "slug": plan.slug,
            "source": plan.source,
            "target_mode": plan.target_mode,
            "requested_device_ids": plan.requested_device_ids,
            "resolved_device_ids": plan.resolved_device_ids,
            "summary": plan.summary,
            "add_count": len(plan.add_operations),
            "remove_count": len(plan.remove_operations),
            "workspaces": [
                {
                    "action": str(item["action"]),
                    "workspace_name": str(item["workspace_name"]),
                    "workspace_id": str(item["workspace_id"]),
                    "change_control_ids": [str(cc_id) for cc_id in item.get("change_control_ids", [])],
                }
                for item in workspaces
            ],
            "notes": plan.notes,
            "warnings": plan.warnings,
        }

    def _serialize_plan(self, plan: AutomationToolPlanData) -> dict[str, Any]:
        operations = [self._serialize_operation(item) for item in plan.add_operations]
        operations.extend(self._serialize_operation(item) for item in plan.remove_operations)
        return {
            "slug": plan.slug,
            "source": plan.source,
            "target_mode": plan.target_mode,
            "requested_device_ids": plan.requested_device_ids,
            "resolved_device_ids": plan.resolved_device_ids,
            "resolved_devices": plan.resolved_devices,
            "summary": plan.summary,
            "add_count": len(plan.add_operations),
            "remove_count": len(plan.remove_operations),
            "operations": operations,
            "notes": plan.notes,
            "warnings": plan.warnings,
        }

    def _serialize_operation(self, operation: AutomationTagOperationData) -> dict[str, Any]:
        return {
            "action": operation.action,
            "element_type": operation.element_type,
            "label": operation.label,
            "value": operation.value,
            "device_id": operation.device_id,
            "interface_id": operation.interface_id,
            "display_key": operation.display_key,
        }

    def _build_runtime(self, source_name: str) -> CVPAutomationRuntime:
        self._require_live_configuration()
        return CVPAutomationRuntime(self.settings, source_name)

    def _require_live_configuration(self) -> None:
        if not self.settings.cvp_sources:
            raise RuntimeError("자동화 실행용 CVP source가 설정되어 있지 않습니다.")
        if not (self.settings.cvp_token or (self.settings.cvp_username and self.settings.cvp_password)):
            raise RuntimeError("자동화 실행용 CVP 인증 정보가 설정되어 있지 않습니다.")

    def _resolve_source(self, source_name: str) -> Any:
        for source in self.settings.cvp_sources:
            if source.name == source_name:
                return source
        raise ValueError(f"Unknown CVP source: {source_name}")

    def _resolve_tool(self, slug: str) -> Any:
        tool_module = TOOL_REGISTRY.get(slug)
        if tool_module is None:
            raise ValueError(f"Unknown automation tool: {slug}")
        return tool_module
