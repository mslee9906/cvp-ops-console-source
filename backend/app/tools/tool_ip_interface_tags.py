from __future__ import annotations

import inspect
from typing import Any

from app.tools.common import AutomationTagOperationData, AutomationToolPlanData, CVPAutomationRuntime


TOOL_SLUG = "ip_interface_tags"
TOOL_TITLE = "IP Interface TAG 동기화"
TOOL_SUMMARY = "실제 running-config의 인터페이스 IP와 CVP의 label=IP interface TAG를 비교해 누락/잔존 TAG를 맞춥니다."
WORKSPACE_NAME = "IP_Interface_TAG_Override"


def _collect_interface_ips_from_config(device_id: str, config_text: str) -> list[str]:
    interfaces: dict[str, dict[str, list[str]]] = {}
    current_interface: str | None = None

    for line in config_text.splitlines():
        if line.startswith("interface "):
            current_interface = line.split()[1]
            interfaces[current_interface] = {"ip": []}
        elif current_interface:
            if "ip address" in line and "secondary" not in line:
                ip_match = line.split("ip address ", maxsplit=1)[1]
                if "virtual" in ip_match:
                    ip_match = line.split("virtual ", maxsplit=1)[1]
                if ip_match and ip_match[0].isdigit():
                    interfaces[current_interface]["ip"].append(ip_match.strip())
            elif "secondary" in line and "ip address " in line:
                ip_match = line.split("ip address ", maxsplit=1)[1].split(" secondary", maxsplit=1)[0]
                if ip_match and ip_match[0].isdigit():
                    interfaces[current_interface]["ip"].append(ip_match.strip())
            elif "ip virtual-router address " in line:
                ip_match = line.split("ip virtual-router address ", maxsplit=1)[1]
                if ip_match and ip_match[0].isdigit():
                    interfaces[current_interface]["ip"].append(ip_match.strip())

    enrolled: list[str] = []
    for interface_name, data in interfaces.items():
        for ip_value in data["ip"]:
            enrolled.append(f"{device_id}_{interface_name} : {ip_value}")
    return enrolled


def _current_ip_tags(runtime: CVPAutomationRuntime, target_device_ids: set[str]) -> list[str]:
    notifications = runtime.query_notifications(
        "analytics",
        ["tags", "elements", "interfaces", runtime.wildcard(), "label", "IP"],
    )
    current_tags: list[str] = []
    for notification in notifications:
        path_elements = notification.get("path_elements", [])
        if len(path_elements) < 4:
            continue
        interface_path = str(path_elements[3])
        device_id = interface_path.split("_", maxsplit=1)[0]
        if target_device_ids and device_id not in target_device_ids:
            continue
        for value in notification.get("updates", {}).keys():
            current_tags.append(f"{interface_path} : {value}")
    return current_tags


def _to_interface_tag(token: str) -> dict[str, str]:
    device_interface, _, value = token.partition(" : ")
    device_id, _, interface_id = device_interface.partition("_")
    return {
        "label": "IP",
        "value": value.strip(),
        "device_id": device_id.strip(),
        "interface_id": interface_id.strip(),
    }


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
            inspect.getsource(_collect_interface_ips_from_config).strip(),
            inspect.getsource(_current_ip_tags).strip(),
        ]
    )
    return {
        **summary(),
        "description": (
            "원본 자동화 툴1의 동작을 유지합니다. 대상 장비의 running-config에서 interface IP, secondary IP, "
            "ip virtual-router address를 수집하고, 현재 CVP analytics의 label=IP interface TAG와 비교해 "
            "추가/삭제 대상을 계산한 뒤 workspace build/submit까지 수행합니다."
        ),
        "code_preview": code_preview,
        "api_steps": [
            {
                "title": "인증 토큰 확보",
                "target": "POST /cvpservice/login/authenticate.do",
                "detail": "프로젝트 설정의 CVP 계정 또는 토큰으로 세션을 확보합니다.",
            },
            {
                "title": "현재 IP TAG 조회",
                "target": 'analytics -> ["tags","elements","interfaces",*, "label","IP"]',
                "detail": "현재 등록된 interface TAG를 읽어 원본 스크립트와 같은 문자열 형식으로 정규화합니다.",
            },
            {
                "title": "running-config 조회",
                "target": 'device dataset -> ["Config","running","lines"]',
                "detail": "선택한 장비의 running-config를 읽고 인터페이스 IP 목록을 파싱합니다.",
            },
            {
                "title": "Workspace 반영",
                "target": "workspace/tag gRPC API",
                "detail": "차집합 결과를 기준으로 IP interface TAG create/assign/remove 후 build/submit 합니다.",
            },
        ],
        "notes": [
            "all 모드는 원본 스크립트와 같은 전체 장비 기준 동작입니다.",
            "selected 모드는 삭제 범위를 선택 장비로 제한해 부분 실행이 가능하도록 한 래퍼입니다.",
        ],
        "warnings": [
            "Apply는 실제 CVP workspace submit을 수행합니다.",
            "running-config에서 읽히지 않는 장비나 인터페이스는 삭제 대상으로 계산될 수 있습니다.",
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

    actual_ip_tokens: list[str] = []
    for device_id in resolved_device_ids:
        config_text = runtime.get_running_config(device_id)
        actual_ip_tokens.extend(_collect_interface_ips_from_config(device_id, config_text))

    current_ip_tags = _current_ip_tags(runtime, set(resolved_device_ids))
    current_ip_tag_set = set(current_ip_tags)
    actual_ip_set = set(actual_ip_tokens)

    add_tokens = [token for token in actual_ip_tokens if token not in current_ip_tag_set]
    remove_tokens = [token for token in current_ip_tags if token not in actual_ip_set]

    notes: list[str] = []
    if target_mode == "selected":
        missing = sorted({device_id for device_id in requested_device_ids if device_id} - set(resolved_device_ids))
        if missing:
            notes.append(f"현재 source에서 찾지 못한 장비 ID {len(missing)}건은 제외했습니다.")

    summary_text = (
        f"{len(resolved_device_ids)}대 장비 기준으로 IP interface TAG {len(add_tokens)}건 추가, "
        f"{len(remove_tokens)}건 삭제 예정입니다."
    )

    return AutomationToolPlanData(
        slug=TOOL_SLUG,
        source=runtime.source.name,
        target_mode=target_mode,
        requested_device_ids=list(requested_device_ids),
        resolved_device_ids=resolved_device_ids,
        resolved_devices=resolved_devices,
        summary=summary_text,
        add_operations=[
            AutomationTagOperationData(
                action="add",
                element_type="interface",
                label="IP",
                value=tag["value"],
                device_id=tag["device_id"],
                interface_id=tag["interface_id"],
            )
            for tag in (_to_interface_tag(token) for token in add_tokens)
        ],
        remove_operations=[
            AutomationTagOperationData(
                action="remove",
                element_type="interface",
                label="IP",
                value=tag["value"],
                device_id=tag["device_id"],
                interface_id=tag["interface_id"],
            )
            for tag in (_to_interface_tag(token) for token in remove_tokens)
        ],
        notes=notes,
        warnings=["Apply는 실제 CVP에 workspace를 생성하고 submit 합니다."],
    )


def apply(runtime: CVPAutomationRuntime, plan: AutomationToolPlanData) -> list[dict[str, Any]]:
    workspaces: list[dict[str, Any]] = []
    add_tags = [
        {
            "label": operation.label,
            "value": operation.value,
            "device_id": operation.device_id,
            "interface_id": operation.interface_id or "",
        }
        for operation in plan.add_operations
        if operation.element_type == "interface"
    ]
    remove_tags = [
        {
            "label": operation.label,
            "value": operation.value,
            "device_id": operation.device_id,
            "interface_id": operation.interface_id or "",
        }
        for operation in plan.remove_operations
        if operation.element_type == "interface"
    ]
    if add_tags:
        result = runtime.manage_tags(workspace_name=WORKSPACE_NAME, interface_tags=add_tags, remove=False)
        workspaces.append({"action": "add", **result})
    if remove_tags:
        result = runtime.manage_tags(workspace_name=WORKSPACE_NAME, interface_tags=remove_tags, remove=True)
        workspaces.append({"action": "remove", **result})
    return workspaces
