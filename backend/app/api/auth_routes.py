from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from app.schemas.auth import ChangePasswordRequest, LoginRequest, LoginResponse, UserCreateRequest, UserResponse


SESSION_COOKIE_NAME = "ops_console_session"

router = APIRouter()


def _current_user(request: Request) -> dict:
    user = getattr(request.state, "current_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def _require_admin(request: Request) -> dict:
    user = _current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user


@router.post("/login", response_model=LoginResponse)
def login(request: Request, response: Response, payload: LoginRequest) -> LoginResponse:
    result = request.app.state.auth_service.authenticate(payload.username, payload.password)
    if not result:
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=result["token"],
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=request.app.state.settings.auth_session_hours * 3600,
    )
    return LoginResponse(user=result["user"])


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    raw_token = request.cookies.get(SESSION_COOKIE_NAME, "")
    request.app.state.auth_service.logout(raw_token)
    response.delete_cookie(SESSION_COOKIE_NAME, httponly=True, samesite="lax")
    return {"ok": True}


@router.get("/me", response_model=UserResponse)
def me(request: Request) -> UserResponse:
    return _current_user(request)


@router.get("/users", response_model=list[UserResponse])
def list_users(request: Request) -> list[UserResponse]:
    _current_user(request)
    return request.app.state.auth_service.list_users()


@router.post("/users", response_model=UserResponse)
def create_user(request: Request, payload: UserCreateRequest) -> UserResponse:
    _require_admin(request)
    try:
        return request.app.state.auth_service.create_user(
            username=payload.username,
            display_name=payload.display_name,
            password=payload.password,
            role=payload.role.value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/users/{user_id}")
def delete_user(request: Request, user_id: int) -> dict[str, bool]:
    actor = _require_admin(request)
    try:
        request.app.state.auth_service.delete_user(int(actor["id"]), user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/change-password", response_model=UserResponse)
def change_password(request: Request, payload: ChangePasswordRequest) -> UserResponse:
    user = _current_user(request)
    try:
        return request.app.state.auth_service.change_password(
            user_id=int(user["id"]),
            current_password=payload.current_password,
            new_password=payload.new_password,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
