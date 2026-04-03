from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
import copy
import json
from pathlib import Path
import ssl
import sys
from typing import Any
import uuid

import grpc
import requests

from app.core.settings import CVPSourceEndpoint, Settings
from app.services.config_parser import reconstruct_config_lines


RPC_TIMEOUT = 30
PAYLOAD_TEMPLATE = {
    "value": {
        "key": {
            "workspaceId": "",
            "elementType": 2,
            "label": "",
            "value": "",
        }
    }
}


def normalize_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {normalize_key(key): normalize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    return value


def normalize_key(key: Any) -> str:
    if isinstance(key, Mapping):
        return json.dumps(normalize_value(key), ensure_ascii=False, sort_keys=True)
    return str(key)


def build_tag_payload(
    *,
    workspace_id: str,
    label: str,
    value: str,
    element_type: int,
    device_id: str | None = None,
    interface_id: str | None = None,
    remove: bool = False,
) -> str:
    payload = copy.deepcopy(PAYLOAD_TEMPLATE)
    payload["value"]["key"]["workspaceId"] = workspace_id
    payload["value"]["key"]["label"] = label
    payload["value"]["key"]["value"] = value
    payload["value"]["key"]["elementType"] = element_type
    if device_id:
        payload["value"]["key"]["deviceId"] = device_id
    if interface_id:
        payload["value"]["key"]["interfaceId"] = interface_id
    if remove:
        payload["value"]["remove"] = True
    return json.dumps(payload)


@dataclass(frozen=True)
class AutomationTagOperationData:
    action: str
    element_type: str
    label: str
    value: str
    device_id: str
    interface_id: str | None = None

    @property
    def display_key(self) -> str:
        if self.interface_id:
            return f"{self.device_id}_{self.interface_id} : {self.value}"
        return f"{self.device_id} : {self.value}"


@dataclass
class AutomationToolPlanData:
    slug: str
    source: str
    target_mode: str
    requested_device_ids: list[str]
    resolved_device_ids: list[str]
    resolved_devices: list[dict[str, str]]
    summary: str
    add_operations: list[AutomationTagOperationData] = field(default_factory=list)
    remove_operations: list[AutomationTagOperationData] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class CVPAutomationRuntime:
    def __init__(self, settings: Settings, source_name: str) -> None:
        self.settings = settings
        self.source = self._resolve_source(source_name)
        self._token: str | None = None
        self._ca_value: str | None = None
        self._cloudvision_modules: tuple[Any, Any, Any] | None = None
        self._proto_modules: tuple[Any, Any, Any, Any, Any] | None = None

    def _resolve_source(self, source_name: str) -> CVPSourceEndpoint:
        for source in self.settings.cvp_sources:
            if source.name == source_name:
                return source
        raise ValueError(f"Unknown CVP source: {source_name}")

    def _ensure_cloudvision_modules(self) -> tuple[Any, Any, Any]:
        if self._cloudvision_modules is not None:
            return self._cloudvision_modules

        library_root = str(self.settings.cvp_library_root)
        if library_root not in sys.path:
            sys.path.insert(0, library_root)

        from cloudvision.Connector.codec import Wildcard  # type: ignore
        from cloudvision.Connector.grpc_client import GRPCClient, create_query  # type: ignore

        self._cloudvision_modules = (GRPCClient, create_query, Wildcard)
        return self._cloudvision_modules

    def _ensure_proto_modules(self) -> tuple[Any, Any, Any, Any, Any]:
        if self._proto_modules is not None:
            return self._proto_modules

        from google.protobuf import wrappers_pb2 as wrappers
        from google.protobuf.json_format import Parse
        import arista.tag.v2
        from arista.workspace.v1 import workspace_pb2 as workspace_models
        from arista.workspace.v1 import services as workspace_services

        self._proto_modules = (Parse, arista.tag.v2, workspace_models, workspace_services, wrappers)
        return self._proto_modules

    def wildcard(self) -> Any:
        _grpc_client, _create_query, wildcard_cls = self._ensure_cloudvision_modules()
        return wildcard_cls()

    def get_token(self) -> str:
        if self._token:
            return self._token
        if self.settings.cvp_token:
            self._token = self.settings.cvp_token
            return self._token
        self._token = self._authenticate()
        return self._token

    def _authenticate(self) -> str:
        if not (self.settings.cvp_username and self.settings.cvp_password):
            raise RuntimeError("CVP token or username/password credentials are required.")

        verify: str | bool
        if self.settings.cvp_ca_file:
            verify = self.settings.cvp_ca_file
        else:
            verify = False

        response = requests.post(
            f"https://{self.source.host}:{self.source.port}/cvpservice/login/authenticate.do",
            auth=(self.settings.cvp_username, self.settings.cvp_password),
            verify=verify,
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        token = str(payload.get("sessionId", "")).strip()
        if not token:
            raise RuntimeError("CVP authentication succeeded but no sessionId was returned.")
        return token

    def _get_ca_text(self) -> str:
        if self._ca_value:
            return self._ca_value
        if self.settings.cvp_ca_file:
            self._ca_value = Path(self.settings.cvp_ca_file).read_text(encoding="utf-8")
        else:
            self._ca_value = ssl.get_server_certificate((self.source.host, self.source.port))
        return self._ca_value

    def _get_root_certificates(self) -> bytes:
        return self._get_ca_text().encode("utf-8")

    @contextmanager
    def open_query_client(self) -> Any:
        GRPCClient, _create_query, _wildcard_cls = self._ensure_cloudvision_modules()
        kwargs: dict[str, Any] = {"tokenValue": self.get_token()}
        if self.settings.cvp_ca_file:
            kwargs["ca"] = self.settings.cvp_ca_file
        else:
            kwargs["caValue"] = self._get_ca_text()
        if self.settings.cvp_cert_file:
            kwargs["certs"] = self.settings.cvp_cert_file
        if self.settings.cvp_key_file:
            kwargs["key"] = self.settings.cvp_key_file
        client = GRPCClient(f"{self.source.host}:{self.source.port}", **kwargs)
        try:
            yield client
        finally:
            client.close()

    @contextmanager
    def open_secure_channel(self) -> Any:
        call_credentials = grpc.access_token_call_credentials(self.get_token())
        private_key = Path(self.settings.cvp_key_file).read_bytes() if self.settings.cvp_key_file else None
        certificate_chain = Path(self.settings.cvp_cert_file).read_bytes() if self.settings.cvp_cert_file else None
        channel_credentials = grpc.ssl_channel_credentials(
            root_certificates=self._get_root_certificates(),
            private_key=private_key,
            certificate_chain=certificate_chain,
        )
        connection_credentials = grpc.composite_channel_credentials(channel_credentials, call_credentials)
        channel = grpc.secure_channel(f"{self.source.host}:{self.source.port}", connection_credentials)
        try:
            yield channel
        finally:
            channel.close()

    def query_notifications(self, dataset: str, path_elements: list[Any]) -> list[dict[str, Any]]:
        _grpc_client, create_query, _wildcard_cls = self._ensure_cloudvision_modules()
        query = [create_query([(path_elements, [])], dataset)]
        notifications: list[dict[str, Any]] = []
        with self.open_query_client() as client:
            for batch in client.get(query):
                notifications.extend(batch.get("notifications", []))
        return notifications

    def get_merged_updates(self, dataset: str, path_elements: list[Any]) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        for notification in self.query_notifications(dataset, path_elements):
            for key, value in notification.get("updates", {}).items():
                merged[normalize_key(key)] = normalize_value(value)
        return merged

    def get_analytics_devices(self) -> dict[str, dict[str, Any]]:
        devices: dict[str, dict[str, Any]] = {}
        updates = self.get_merged_updates("analytics", ["DatasetInfo", "Devices"])
        for device_id, raw in updates.items():
            if not isinstance(raw, dict):
                continue
            devices[device_id] = {
                "device_id": device_id,
                "hostname": str(raw.get("hostname") or device_id),
                "serial": str(raw.get("serialNumber") or device_id),
                "mgmt_ip": str(raw.get("primaryManagementIP", "") or ""),
                "model": str(raw.get("modelName", "") or ""),
                "site": str(raw.get("containerName", "") or ""),
            }
        return devices

    def get_running_config(self, device_id: str) -> str:
        updates = self.get_merged_updates(device_id, ["Config", "running", "lines"])
        nodes = {key: value for key, value in updates.items() if isinstance(value, dict)}
        return reconstruct_config_lines(nodes)

    def create_workspace(self, channel: Any, workspace_name: str) -> str:
        _parse, _tag_module, workspace_models, workspace_services, wrappers = self._ensure_proto_modules()
        workspace_id = str(uuid.uuid4())
        request = workspace_services.WorkspaceConfigSetRequest(
            value=workspace_models.WorkspaceConfig(
                key=workspace_models.WorkspaceKey(
                    workspace_id=wrappers.StringValue(value=workspace_id),
                ),
                display_name=wrappers.StringValue(value=workspace_name),
            )
        )
        workspace_services.WorkspaceConfigServiceStub(channel).Set(request, timeout=RPC_TIMEOUT)
        return workspace_id

    def build_workspace(self, channel: Any, workspace_id: str) -> bool:
        _parse, _tag_module, workspace_models, workspace_services, wrappers = self._ensure_proto_modules()
        build_id = str(uuid.uuid4())
        request = workspace_services.WorkspaceConfigSetRequest(
            value=workspace_models.WorkspaceConfig(
                key=workspace_models.WorkspaceKey(
                    workspace_id=wrappers.StringValue(value=workspace_id),
                ),
                request=workspace_models.REQUEST_START_BUILD,
                request_params=workspace_models.RequestParams(
                    request_id=wrappers.StringValue(value=build_id),
                ),
            )
        )
        workspace_services.WorkspaceConfigServiceStub(channel).Set(request, timeout=RPC_TIMEOUT)

        stream_request = workspace_services.WorkspaceStreamRequest(
            partial_eq_filter=[
                workspace_models.Workspace(
                    key=workspace_models.WorkspaceKey(
                        workspace_id=wrappers.StringValue(value=workspace_id),
                    )
                )
            ]
        )
        stream_stub = workspace_services.WorkspaceServiceStub(channel)
        build_result = None
        for response in stream_stub.Subscribe(stream_request, timeout=RPC_TIMEOUT):
            if build_id in response.value.responses.values:
                build_result = response.value.responses.values[build_id]
                break
        if build_result is None:
            raise RuntimeError("Workspace build result was not returned.")
        if build_result.status == workspace_models.RESPONSE_STATUS_FAIL:
            return False
        return build_result.status == workspace_models.RESPONSE_STATUS_SUCCESS

    def submit_workspace(self, channel: Any, workspace_id: str) -> tuple[list[str], bool]:
        _parse, _tag_module, workspace_models, workspace_services, wrappers = self._ensure_proto_modules()
        submit_id = str(uuid.uuid4())
        request = workspace_services.WorkspaceConfigSetRequest(
            value=workspace_models.WorkspaceConfig(
                key=workspace_models.WorkspaceKey(
                    workspace_id=wrappers.StringValue(value=workspace_id),
                ),
                request=workspace_models.REQUEST_SUBMIT,
                request_params=workspace_models.RequestParams(
                    request_id=wrappers.StringValue(value=submit_id),
                ),
            )
        )
        workspace_services.WorkspaceConfigServiceStub(channel).Set(request, timeout=RPC_TIMEOUT)

        stream_request = workspace_services.WorkspaceStreamRequest(
            partial_eq_filter=[
                workspace_models.Workspace(
                    key=workspace_models.WorkspaceKey(
                        workspace_id=wrappers.StringValue(value=workspace_id),
                    )
                )
            ]
        )
        stream_stub = workspace_services.WorkspaceServiceStub(channel)
        for response in stream_stub.Subscribe(stream_request, timeout=RPC_TIMEOUT):
            if submit_id in response.value.responses.values:
                submit_result = response.value.responses.values[submit_id]
                if submit_result.status == workspace_models.RESPONSE_STATUS_FAIL:
                    return [], False
            if response.value.state == workspace_models.WORKSPACE_STATE_SUBMITTED:
                return list(response.value.cc_ids.values), True
        return [], False

    def create_tags(self, channel: Any, json_request: str) -> None:
        Parse, tag_module, _workspace_models, _workspace_services, _wrappers = self._ensure_proto_modules()
        request = Parse(json_request, tag_module.services.TagConfigSetRequest(), False)
        tag_module.services.TagConfigServiceStub(channel).Set(request, timeout=RPC_TIMEOUT)

    def assign_tags(self, channel: Any, json_request: str) -> None:
        Parse, tag_module, _workspace_models, _workspace_services, _wrappers = self._ensure_proto_modules()
        request = Parse(json_request, tag_module.services.TagAssignmentConfigSetRequest(), False)
        tag_module.services.TagAssignmentConfigServiceStub(channel).Set(request, timeout=RPC_TIMEOUT)

    def manage_tags(
        self,
        *,
        workspace_name: str,
        device_tags: list[dict[str, str]] | None = None,
        interface_tags: list[dict[str, str]] | None = None,
        remove: bool = False,
    ) -> dict[str, Any]:
        device_tags = device_tags or []
        interface_tags = interface_tags or []
        if not device_tags and not interface_tags:
            raise RuntimeError("No tag operations were provided.")

        with self.open_secure_channel() as channel:
            workspace_id = self.create_workspace(channel, workspace_name)

            for tag in device_tags:
                create_payload = build_tag_payload(
                    workspace_id=workspace_id,
                    label=tag["label"],
                    value=tag["value"],
                    element_type=1,
                )
                self.create_tags(channel, create_payload)
                assign_payload = build_tag_payload(
                    workspace_id=workspace_id,
                    label=tag["label"],
                    value=tag["value"],
                    element_type=1,
                    device_id=tag["device_id"],
                    remove=remove,
                )
                self.assign_tags(channel, assign_payload)

            for tag in interface_tags:
                create_payload = build_tag_payload(
                    workspace_id=workspace_id,
                    label=tag["label"],
                    value=tag["value"],
                    element_type=2,
                )
                self.create_tags(channel, create_payload)
                assign_payload = build_tag_payload(
                    workspace_id=workspace_id,
                    label=tag["label"],
                    value=tag["value"],
                    element_type=2,
                    device_id=tag["device_id"],
                    interface_id=tag["interface_id"],
                    remove=remove,
                )
                self.assign_tags(channel, assign_payload)

            if not self.build_workspace(channel, workspace_id):
                raise RuntimeError(f"Workspace build failed: {workspace_name}")
            change_control_ids, submitted = self.submit_workspace(channel, workspace_id)
            if not submitted:
                raise RuntimeError(f"Workspace submission failed: {workspace_name}")

        return {
            "workspace_id": workspace_id,
            "workspace_name": workspace_name,
            "change_control_ids": change_control_ids,
        }
