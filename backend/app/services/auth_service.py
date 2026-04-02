from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
from typing import Any

from app.core.settings import Settings
from app.repositories.auth_repository import AuthRepository


class AuthService:
    def __init__(self, repository: AuthRepository, settings: Settings) -> None:
        self.repository = repository
        self.settings = settings

    def initialize(self) -> None:
        self.repository.initialize()
        self.repository.delete_expired_sessions()
        if self.repository.count_users() == 0:
            self.repository.create_user(
                username=self.settings.default_admin_username,
                display_name=self.settings.default_admin_display_name,
                password_hash=self._hash_password(self.settings.default_admin_password),
                role="admin",
            )

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        user = self.repository.get_user_by_username(username.strip())
        if not user or not bool(user.get("is_active")):
            return None
        if not self._verify_password(password, str(user.get("password_hash", ""))):
            return None

        raw_token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=self.settings.auth_session_hours)).astimezone()
        self.repository.create_session(int(user["id"]), self._hash_session_token(raw_token), expires_at.isoformat(timespec="seconds"))
        self.repository.update_last_login(int(user["id"]))
        user = self.repository.get_user_by_id(int(user["id"]))
        return {
            "token": raw_token,
            "expires_at": expires_at.isoformat(timespec="seconds"),
            "user": self._serialize_user(user),
        }

    def get_user_from_session(self, raw_token: str | None) -> dict[str, Any] | None:
        token = str(raw_token or "").strip()
        if not token:
            return None

        self.repository.delete_expired_sessions()
        session_user = self.repository.get_user_by_session_hash(self._hash_session_token(token))
        if not session_user:
            return None

        expires_at = str(session_user.get("expires_at", "") or "")
        if expires_at and datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc).astimezone():
            self.repository.delete_session(self._hash_session_token(token))
            return None

        self.repository.touch_session(int(session_user["session_id"]))
        return self._serialize_user(session_user)

    def list_users(self) -> list[dict[str, Any]]:
        return [self._serialize_user(user) for user in self.repository.list_users()]

    def create_user(self, username: str, display_name: str, password: str, role: str) -> dict[str, Any]:
        existing = self.repository.get_user_by_username(username)
        if existing:
            raise ValueError("이미 사용 중인 아이디입니다.")
        return self.repository.create_user(
            username=username.strip(),
            display_name=display_name.strip(),
            password_hash=self._hash_password(password),
            role=role,
        )

    def change_password(self, user_id: int, current_password: str, new_password: str) -> dict[str, Any]:
        user = self.repository.get_user_by_id(user_id)
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")
        if not self._verify_password(current_password, str(user.get("password_hash", ""))):
            raise ValueError("현재 비밀번호가 일치하지 않습니다.")
        updated = self.repository.update_password(user_id, self._hash_password(new_password))
        if not updated:
            raise ValueError("비밀번호를 변경하지 못했습니다.")
        return updated

    def delete_user(self, actor_user_id: int, target_user_id: int) -> None:
        if actor_user_id == target_user_id:
            raise ValueError("현재 로그인한 계정은 삭제할 수 없습니다.")

        target = self.repository.get_user_by_id(target_user_id)
        if not target:
            raise ValueError("사용자를 찾을 수 없습니다.")

        if str(target.get("role")) == "admin" and self.repository.count_active_admins() <= 1:
            raise ValueError("마지막 관리자 계정은 삭제할 수 없습니다.")

        deleted = self.repository.delete_user(target_user_id)
        if not deleted:
            raise ValueError("사용자를 삭제하지 못했습니다.")

    def logout(self, raw_token: str | None) -> None:
        token = str(raw_token or "").strip()
        if not token:
            return
        self.repository.delete_session(self._hash_session_token(token))

    def _serialize_user(self, user: dict[str, Any] | None) -> dict[str, Any] | None:
        if not user:
            return None
        data = dict(user)
        data["is_active"] = bool(data.get("is_active"))
        data.pop("password_hash", None)
        data.pop("session_id", None)
        data.pop("expires_at", None)
        return data

    def _hash_session_token(self, raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    def _hash_password(self, password: str) -> str:
        iterations = 310_000
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"

    def _verify_password(self, password: str, encoded: str) -> bool:
        try:
            algorithm, raw_iterations, salt_hex, digest_hex = encoded.split("$", 3)
        except ValueError:
            return False
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(raw_iterations)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), iterations)
        return hmac.compare_digest(actual, expected)
