from __future__ import annotations

from collections.abc import Mapping
from base64 import b64encode
import json
from pathlib import Path
import ssl
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class CVPConnector:
    def __init__(
        self,
        *,
        library_root: Path,
        host: str,
        port: int = 443,
        token: str = "",
        username: str = "",
        password: str = "",
        ca_file: str = "",
        cert_file: str = "",
        key_file: str = "",
        insecure_tls: bool = False,
    ) -> None:
        self.library_root = Path(library_root)
        self.host = host
        self.port = port
        self.token = token
        self.username = username
        self.password = password
        self.ca_file = ca_file
        self.cert_file = cert_file
        self.key_file = key_file
        self.insecure_tls = insecure_tls
        self._client = None
        self.create_query = None
        self._ca_value = ""

    def __enter__(self) -> "CVPConnector":
        if str(self.library_root) not in sys.path:
            sys.path.insert(0, str(self.library_root))

        from cloudvision.Connector.grpc_client import GRPCClient, create_query  # type: ignore

        token_value = self.token or self._authenticate()
        kwargs: dict[str, Any] = {"tokenValue": token_value}
        if self.ca_file:
            kwargs["ca"] = self.ca_file
        elif self._ca_value:
            kwargs["caValue"] = self._ca_value
        if self.cert_file:
            kwargs["certs"] = self.cert_file
        if self.key_file:
            kwargs["key"] = self.key_file

        self.create_query = create_query
        self._client = GRPCClient(f"{self.host}:{self.port}", **kwargs)
        return self

    def __exit__(self, *_args: Any) -> None:
        if self._client is not None:
            self._client.close()

    def get_merged_updates(self, dataset: str, path_elements: list[Any]) -> dict[str, Any]:
        if self._client is None or self.create_query is None:
            raise RuntimeError("CVPConnector must be used as a context manager")

        query = [self.create_query([(path_elements, [])], dataset)]
        merged: dict[str, Any] = {}
        for batch in self._client.get(query):
            for notif in batch["notifications"]:
                for key, value in notif["updates"].items():
                    merged[self.normalize_key(key)] = self.normalize(value)
        return merged

    def normalize(self, value: Any) -> Any:
        if isinstance(value, Mapping):
            return {self.normalize_key(key): self.normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.normalize(item) for item in value]
        return value

    def normalize_key(self, key: Any) -> str:
        if isinstance(key, Mapping):
            return json.dumps(self.normalize(key), ensure_ascii=False, sort_keys=True)
        return str(key)

    def _authenticate(self) -> str:
        if not (self.username and self.password):
            raise RuntimeError("CVP token or username/password credentials are required")

        context = self._build_ssl_context()
        auth_pair = f"{self.username}:{self.password}".encode("utf-8")
        request = Request(
            url=f"https://{self.host}:{self.port}/cvpservice/login/authenticate.do",
            method="POST",
            headers={"Authorization": f"Basic {b64encode(auth_pair).decode('ascii')}"},
        )

        try:
            with urlopen(request, context=context, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"CVP authentication failed with HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Unable to reach CVP authentication endpoint: {exc.reason}") from exc

        token = payload.get("sessionId", "")
        if not token:
            raise RuntimeError("CVP authentication succeeded but no sessionId was returned")
        return str(token)

    def _build_ssl_context(self) -> ssl.SSLContext:
        if self.ca_file:
            return ssl.create_default_context(cafile=self.ca_file)

        if not self._ca_value and not self.insecure_tls:
            self._ca_value = ssl.get_server_certificate((self.host, self.port))

        if self._ca_value:
            return ssl.create_default_context(cadata=self._ca_value)

        if self.insecure_tls:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            return context

        return ssl.create_default_context()
