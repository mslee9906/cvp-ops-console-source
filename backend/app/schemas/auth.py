from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class UserRole(str, Enum):
    admin = "admin"
    editor = "editor"
    viewer = "viewer"


class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    created_at: str
    updated_at: str
    last_login_at: str = ""


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=1, max_length=200)


class LoginResponse(BaseModel):
    user: UserResponse


class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    display_name: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=4, max_length=200)
    role: UserRole = UserRole.editor


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=4, max_length=200)

