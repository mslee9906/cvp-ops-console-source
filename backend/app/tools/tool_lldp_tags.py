from __future__ import annotations

import inspect
from typing import Any

from app.tools.common import AutomationTagOperationData, AutomationToolPlanData, CVPAutomationRuntime


TOOL_SLUG = "lldp_tags"
TOOL_TITLE = "LLDP TAG 동기화"
TOOL_SUMMARY = "실제 LLDP neighbor 정보와 CVP의 label=LLDP device/interface TAG를 비교해 불일치를 정리합니다."
WORKSPACE_NAME = "Adjust mismatched LLDP tags"
UNSUPPORTED_DEVICE_IDS = {"JPE21210272", "JPE21213973"}


def _collect_actual_lldp_interface_tokens(
    runtime: CVPAutomationRuntime,
    device_ids: list[str],
    known_hostnames: set[str],
) -> list[str]:
    actual_tokens: list[str] = []
    for device_id in device_ids:
        if device_id in UNSUPPORTED_DEVICE_IDS:
            continue
        notifications = runtime.query_notifications(
            device_id,
            [
                "Sysdb",
                "l2discovery",
                "lldp",
                "status",
                "local",
                runtime.wildcard(),
                "portStatus",
                runtime.wildcard(),
                "remoteSystem",
                runtime.wildcard(),
            ],
        )
        result: dict[str, dict[str, Any]] = {}
        for notification in notifications:
            updates = notification.get("updates", {})
            if not updates:
                continue
            path_elements = notification.get("path_elements", [])
            if len(path_elements) < 8:
                continue
            lldp_key = str(path_elements[7])
            neighbors = result.get(lldp_key, {})
            neighbors.update(updates)
            result[lldp_key] = neighbors

        for port, payload in result.items():
            try:
                neighbor_hostname = str(payload["sysName"]["value"]["value"])
            except (KeyError, TypeError):
                continue
            if neighbor_hostname in known_hostnames:
                actual_tokens.append(f"{device_id}_{port} : {neighbor_hostname}")
    return actual_tokens


def _current_lldp_tags(runtime: CVPAutomationRuntime, target_device_ids: set[str]) -> tuple[list[str], list[str]]:
    interface_notifications = runtime.query_notifications(
        "analytics",
        ["tags", "elements", "interfaces", runtime.wildcard(), "label", "LLDP"],
    )
    device_notifications = runtime.query_notifications(
        "analytics",
        ["tags", "elements", "devices", runtime.wildcard(), "label", "LLDP"],
    )

    interface_tags: list[str] = []
    for notification in interface_notifications:
        path_elements = notification.get("path_elements", [])
        if len(path_elements) < 4:
            continue
        interface_path = str(path_elements[3])
        device_id = interface_path.split("_", maxsplit=1)[0]
        if target_device_ids and device_id not in target_device_ids:
            continue
        for value in notification.get("updates", {}).keys():
            interface_tags.append(f"{interface_path} : {value}")

    device_tags: list[str] = []
    for notification in device_notifications:
        path_elements = notification.get("path_elements", [])
        if len(path_elements) < 4:
            continue
        device_id = str(path_elements[3])
        if target_device_ids and device_id not in target_device_ids:
            continue
        for value in notification.get("updates", {}).keys():
            device_tags.append(f"{device_id} : {value}")

    return interface_tags, device_tags


def _to_tag(token: str, *, action: str) -> AutomationTagOperationData:
    left, _, value = token.partition(" : ")
    if "_" in left:
        device_id, _, interface_id = left.partition("_")
        return AutomationTagOperationData(
            action=action,
            element_type="interface",
            label="LLDP",
            value=value.strip(),
            device_id=device_id.strip(),
            interface_id=interface_id.strip(),
        )
    return AutomationTagOperationData(
        action=action,
        element_type="device",
        label="LLDP",
        value=value.strip(),
        device_id=left.strip(),
        interface_id=None,
    )


def summary() -> dict[str, str]:
    return {
        "slug": TOOL_SLUG,
        "title": TOOL_TITLE,
        "summary": TOOL_SUMMARY,
        "workspace_name": WORKSPACE_NAME,
    }


def detail() -> dict[str, Any]:
    code_preview = "\n\n".join(
        [
            inspect.getsource(_collect_actual_lldp_interface_tokens).strip(),
            inspect.getsource(_current_lldp_tags).strip(),
        ]
    )
    return {
        **summary(),
        "description": (
            "원본 자동화 툴2의 동작을 유지합니다. 실제 LLDP telemetry로 neighbor를 읽고, "
            "현재 CVP의 label=LLDP interface/device TAG와 비교해 누락 또는 잔존 TAG를 정리합니다. "
            "device TAG는 원본과 같이 'self hostname'과 'neighbor hostname' 둘 다 유지합니다."
        ),
        "code_preview": code_preview,
        "api_steps": [
            {
                "title": "인증 토큰 확보",
                "target": "POST /cvpservice/login/authenticate.do",
                "detail": "프로젝트 설정의 공용 CVP 인증값으로 세션을 확보합니다.",
            },
            {
                "title": "현재 LLDP TAG 조회",
                "target": 'analytics -> ["tags","elements","interfaces|devices",*, "label","LLDP"]',
                "detail": "현재 등록된 device/interface LLDP TAG를 원본 문자열 포맷으로 정규화합니다.",
            },
            {
                "title": "실제 LLDP neighbor 조회",
                "target": 'device dataset -> ["Sysdb","l2discovery","lldp","status",...]',
                "detail": "장비별 LLDP telemetry를 읽고 CVP에 등록된 hostname인 경우만 유효 neighbor로 인정합니다.",
            },
            {
                "title": "Workspace 반영",
                "target": "workspace/tag gRPC API",
                "detail": "차집합 결과를 기준으로 LLDP device/interface TAG create/assign/remove 후 build/submit 합니다.",
            },
        ],
        "notes": [
            "all 모드는 원본 스크립트의 전체 장비 동작을 그대로 재현합니다.",
            "selected 모드는 선택 장비의 TAG만 계산하고 수정합니다. neighbor hostname 값은 선택 장비 바깥 장비도 그대로 반영됩니다.",
        ],
        "warnings": [
            "Apply는 실제 CVP workspace submit을 수행합니다.",
            "원본 스크립트와 동일하게 JPE21210272, JPE21213973는 LLDP telemetry 조회를 건너뜁니다.",
        ],
    }


def preview(
    runtime: CVPAutomationRuntime,
    *,
    target_mode: str,
    requested_device_ids: list[str],
) -> AutomationToolPlanData:
    analytics_devices = runtime.get_analytics_devices()
    if target_mode == "all":
        resolved_device_ids = list(analytics_devices.keys())
    else:
        requested_set = {device_id for device_id in requested_device_ids if device_id}
        resolved_device_ids = [device_id for device_id in requested_device_ids if device_id in analytics_devices]
        missing = sorted(requested_set - set(resolved_device_ids))

    resolved_devices = [
        {
            "device_id": device_id,
            "hostname": analytics_devices.get(device_id, {}).get("hostname", device_id),
        }
        for device_id in resolved_device_ids
    ]
    hostname_lookup = {
        device_id: str(device.get("hostname", device_id))
        for device_id, device in analytics_devices.items()
    }
    known_hostnames = set(hostname_lookup.values())

    current_interface_tags, current_device_tags = _current_lldp_tags(runtime, set(resolved_device_ids))
    actual_interface_tokens = _collect_actual_lldp_interface_tokens(runtime, resolved_device_ids, known_hostnames)

    actual_device_tokens: list[str] = []
    for token in actual_interface_tokens:
        device_id, _, remainder = token.partition("_")
        neighbor_hostname = remainder.split(" : ", maxsplit=1)[1]
        self_hostname = hostname_lookup.get(device_id, device_id)
        self_token = f"{device_id} : {self_hostname}"
        neighbor_token = f"{device_id} : {neighbor_hostname}"
        if self_token not in actual_device_tokens:
            actual_device_tokens.append(self_token)
        if neighbor_token not in actual_device_tokens:
            actual_device_tokens.append(neighbor_token)

    add_device_tokens = [token for token in actual_device_tokens if token not in set(current_device_tags)]
    remove_device_tokens = [token for token in current_device_tags if token not in set(actual_device_tokens)]
    add_interface_tokens = [token for token in actual_interface_tokens if token not in set(current_interface_tags)]
    remove_interface_tokens = [token for token in current_interface_tags if token not in set(actual_interface_tokens)]

    notes: list[str] = []
    if target_mode == "selected":
        missing = sorted({device_id for device_id in requested_device_ids if device_id} - set(resolved_device_ids))
        if missing:
            notes.append(f"현재 source에서 찾지 못한 장비 ID {len(missing)}건은 제외했습니다.")
    skipped = sorted(set(resolved_device_ids) & UNSUPPORTED_DEVICE_IDS)
    if skipped:
        notes.append(f"원본 스크립트 규칙에 따라 LLDP telemetry 조회를 건너뛴 장비 {len(skipped)}대가 포함되어 있습니다.")

    add_operations = [_to_tag(token, action="add") for token in add_device_tokens + add_interface_tokens]
    remove_operations = [_to_tag(token, action="remove") for token in remove_device_tokens + remove_interface_tokens]
    summary_text = (
        f"{len(resolved_device_ids)}대 장비 기준으로 LLDP TAG {len(add_operations)}건 추가, "
        f"{len(remove_operations)}건 삭제 예정입니다."
    )

    return AutomationToolPlanData(
        slug=TOOL_SLUG,
        source=runtime.source.name,
        target_mode=target_mode,
        requested_device_ids=list(requested_device_ids),
        resolved_device_ids=resolved_device_ids,
        resolved_devices=resolved_devices,
        summary=summary_text,
        add_operations=add_operations,
        remove_operations=remove_operations,
        notes=notes,
        warnings=["Apply는 실제 CVP에 workspace를 생성하고 submit 합니다."],
    )


def apply(runtime: CVPAutomationRuntime, plan: AutomationToolPlanData) -> list[dict[str, Any]]:
    workspaces: list[dict[str, Any]] = []

    add_device_tags = [
        {"label": op.label, "value": op.value, "device_id": op.device_id}
        for op in plan.add_operations
        if op.element_type == "device"
    ]
    add_interface_tags = [
        {
            "label": op.label,
            "value": op.value,
            "device_id": op.device_id,
            "interface_id": op.interface_id or "",
        }
        for op in plan.add_operations
        if op.element_type == "interface"
    ]
    remove_device_tags = [
        {"label": op.label, "value": op.value, "device_id": op.device_id}
        for op in plan.remove_operations
        if op.element_type == "device"
    ]
    remove_interface_tags = [
        {
            "label": op.label,
            "value": op.value,
            "device_id": op.device_id,
            "interface_id": op.interface_id or "",
        }
        for op in plan.remove_operations
        if op.element_type == "interface"
    ]

    if add_device_tags or add_interface_tags:
        result = runtime.manage_tags(
            workspace_name=WORKSPACE_NAME,
            device_tags=add_device_tags,
            interface_tags=add_interface_tags,
            remove=False,
        )
        workspaces.append({"action": "add", **result})
    if remove_device_tags or remove_interface_tags:
        result = runtime.manage_tags(
            workspace_name=WORKSPACE_NAME,
            device_tags=remove_device_tags,
            interface_tags=remove_interface_tags,
            remove=True,
        )
        workspaces.append({"action": "remove", **result})
    return workspaces
