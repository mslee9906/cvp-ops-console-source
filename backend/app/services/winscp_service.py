from __future__ import annotations

from base64 import b64decode, b64encode
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from subprocess import run
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import quote
import ctypes
import json
import os
import posixpath
import re

from app.repositories.winscp_profile_repository import WinScpProfileRepository


@dataclass(frozen=True)
class _ProtectedBlob:
    size: int
    data: ctypes.POINTER(ctypes.c_byte)


class WinScpService:
    ALLOWED_PROTOCOLS = {"sftp", "scp", "ftp"}

    def __init__(self, repository: WinScpProfileRepository, workplan_service: Any) -> None:
        self.repository = repository
        self.workplan_service = workplan_service

    def initialize(self) -> None:
        self.repository.initialize()

    def list_profiles(self) -> list[dict[str, Any]]:
        profiles = []
        for row in self.repository.list_profiles():
            item = dict(row)
            item["password"] = self._decrypt(item.pop("password_encrypted", ""))
            profiles.append(item)
        return profiles

    def save_profiles(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for item in items:
            profile = {
                "name": str(item.get("name") or "").strip(),
                "winscp_path": self._normalize_winscp_path(item.get("winscp_path")),
                "protocol": self._normalize_protocol(item.get("protocol")),
                "host": str(item.get("host") or "").strip(),
                "port": max(1, int(item.get("port") or self._default_port_for_protocol(item.get("protocol")))),
                "username": str(item.get("username") or "").strip(),
                "password_encrypted": self._encrypt(str(item.get("password") or "")),
                "remote_path": self._normalize_remote_path(item.get("remote_path")),
                "host_key": str(item.get("host_key") or "").strip(),
                "enabled": bool(item.get("enabled", True)),
                "is_default": bool(item.get("is_default", False)),
            }
            if profile["name"] and profile["host"]:
                normalized.append(profile)
        self.repository.replace_profiles(normalized)
        return self.list_profiles()

    def upload_latest_evidence(self, card_id: int, project_name: str, profile_id: int | None = None) -> dict[str, Any]:
        profiles = self.list_profiles()
        profile = self._select_profile(profiles, profile_id)
        if not profile:
            raise RuntimeError("사용 가능한 WinSCP 프로파일이 없습니다.")
        if not profile.get("enabled", True):
            raise RuntimeError("선택한 WinSCP 프로파일이 비활성화 상태입니다.")

        evidence = self.workplan_service.get_evidence_summary(card_id, project_name)
        latest_path = Path(str(evidence.get("latest_path") or "").strip())
        if not latest_path.exists() or not latest_path.is_dir():
            raise RuntimeError("업로드할 최신 작업계획서 증적 폴더가 없습니다.")
        if not any(path.is_file() for path in latest_path.rglob("*")):
            raise RuntimeError("업로드할 최신 작업계획서 증적 파일이 없습니다.")

        upload_dir = latest_path / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)

        timestamp = self._now_stamp()
        profile_name = str(profile.get("name") or "winscp").strip()
        bundle_name = str(evidence.get("evidence_key") or latest_path.parent.name or f"card-{card_id}").strip()
        remote_target = self._join_remote_path(str(profile.get("remote_path") or ""), bundle_name)
        log_path = upload_dir / f"winscp-{timestamp}.log"
        meta_path = upload_dir / f"winscp-{timestamp}.json"
        script_path: Path | None = None

        try:
            script_path = self._create_script(
                profile=profile,
                local_path=latest_path,
                remote_path=remote_target,
            )
            result = run(
                [
                    str(profile["winscp_path"]),
                    "/ini=nul",
                    f"/log={log_path}",
                    f"/script={script_path}",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=900,
                check=False,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("설정된 WinSCP 실행 파일 경로를 찾을 수 없습니다.") from exc
        finally:
            if script_path and script_path.exists():
                script_path.unlink(missing_ok=True)

        payload = {
            "card_id": card_id,
            "project_name": project_name,
            "profile_id": int(profile["id"]),
            "profile_name": profile_name,
            "uploaded_at": self._now_iso(),
            "local_path": str(latest_path),
            "remote_path": remote_target,
            "log_path": str(log_path),
            "stdout": result.stdout[-4000:] if "result" in locals() else "",
            "stderr": result.stderr[-4000:] if "result" in locals() else "",
            "return_code": int(result.returncode) if "result" in locals() else -1,
        }
        meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            if not detail and log_path.exists():
                detail = log_path.read_text(encoding="utf-8", errors="ignore")[-4000:].strip()
            raise RuntimeError(f"WinSCP 업로드에 실패했습니다: {detail or '원인을 확인할 수 없습니다.'}")

        return {
            "profile_id": int(profile["id"]),
            "profile_name": profile_name,
            "card_id": card_id,
            "project_name": project_name,
            "uploaded_at": payload["uploaded_at"],
            "remote_path": remote_target,
            "local_path": str(latest_path),
            "log_path": str(log_path),
        }

    def _select_profile(self, profiles: list[dict[str, Any]], profile_id: int | None) -> dict[str, Any] | None:
        if profile_id:
            for item in profiles:
                if int(item.get("id") or 0) == int(profile_id):
                    return item
        for item in profiles:
            if item.get("is_default"):
                return item
        return profiles[0] if profiles else None

    def _normalize_protocol(self, value: Any) -> str:
        protocol = str(value or "sftp").strip().lower() or "sftp"
        return protocol if protocol in self.ALLOWED_PROTOCOLS else "sftp"

    def _normalize_winscp_path(self, value: Any) -> str:
        raw = str(value or "").strip()
        if not raw:
            return raw
        path = Path(raw)
        if path.suffix.lower() == ".exe":
            com_path = path.with_suffix(".com")
            if com_path.exists():
                return str(com_path)
        return raw

    def _normalize_remote_path(self, value: Any) -> str:
        raw = str(value or "").strip().replace("\\", "/")
        if not raw:
            return "/"
        if not raw.startswith("/"):
            raw = f"/{raw}"
        return re.sub(r"/{2,}", "/", raw)

    def _default_port_for_protocol(self, protocol: Any) -> int:
        normalized = self._normalize_protocol(protocol)
        if normalized == "ftp":
            return 21
        return 22

    def _join_remote_path(self, base: str, leaf: str) -> str:
        normalized_base = self._normalize_remote_path(base)
        normalized_leaf = str(leaf or "").strip().replace("\\", "/").strip("/")
        return posixpath.join(normalized_base, normalized_leaf) if normalized_leaf else normalized_base

    def _create_script(self, profile: dict[str, Any], local_path: Path, remote_path: str) -> Path:
        session_url = self._build_session_url(profile)
        lines = [
            "option batch abort",
            "option confirm off",
            f"open {session_url}{self._host_key_option(profile)}",
            f'mkdir "{remote_path}"',
            f'put -r -transfer=binary -preservetime "{local_path}\\*" "{remote_path}/"',
            "exit",
        ]
        with NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
            return Path(handle.name)

    def _build_session_url(self, profile: dict[str, Any]) -> str:
        protocol = self._normalize_protocol(profile.get("protocol"))
        username = quote(str(profile.get("username") or ""), safe="")
        password = quote(str(profile.get("password") or ""), safe="")
        host = str(profile.get("host") or "").strip()
        port = int(profile.get("port") or self._default_port_for_protocol(protocol))
        return f"{protocol}://{username}:{password}@{host}:{port}/"

    def _host_key_option(self, profile: dict[str, Any]) -> str:
        host_key = str(profile.get("host_key") or "").strip()
        if not host_key:
            return ""
        escaped = host_key.replace('"', '""')
        return f' -hostkey="{escaped}"'

    def _encrypt(self, value: str) -> str:
        raw = value.encode("utf-8")
        if not raw:
            return ""
        protected = self._crypt_protect(raw)
        return b64encode(protected).decode("ascii")

    def _decrypt(self, value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        try:
            decoded = b64decode(raw)
        except Exception:
            return ""
        try:
            plain = self._crypt_unprotect(decoded)
        except Exception:
            return ""
        return plain.decode("utf-8", errors="ignore")

    def _crypt_protect(self, data: bytes) -> bytes:
        if os.name != "nt":
            return data
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_byte))]

        in_blob = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte)))
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(in_blob),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(out_blob),
        ):
            raise RuntimeError("DPAPI encryption failed")
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out_blob.pbData)

    def _crypt_unprotect(self, data: bytes) -> bytes:
        if os.name != "nt":
            return data
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_byte))]

        in_blob = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte)))
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(in_blob),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(out_blob),
        ):
            raise RuntimeError("DPAPI decryption failed")
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out_blob.pbData)

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    def _now_stamp(self) -> str:
        return datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
