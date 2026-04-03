from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.automation_routes import router as automation_router
from app.api.auth_routes import SESSION_COOKIE_NAME, router as auth_router
from app.api.edm_link_routes import router as edm_link_router
from app.api.kanban_routes import router as kanban_router
from app.api.notification_routes import router as notification_router
from app.api.workflow_routes import router as workflow_router
from app.api.routes import router
from app.core.settings import get_settings
from app.repositories.auth_repository import AuthRepository
from app.repositories.edm_link_repository import EdmLinkRepository
from app.repositories.kanban_repository import KanbanRepository
from app.repositories.notification_repository import NotificationRepository
from app.repositories.snapshot_repository import SnapshotRepository
from app.repositories.workflow_repository import WorkflowRepository
from app.services.auth_service import AuthService
from app.services.automation_service import AutomationService
from app.services.collection_service import CollectionService
from app.services.edm_link_service import EdmLinkService
from app.services.kanban_service import KanbanService
from app.services.notification_service import NotificationService
from app.services.query_service import QueryService
from app.services.workflow_service import WorkflowService
from app.storage.config_files import ConfigFileManager


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)


settings = get_settings()
repository = SnapshotRepository(settings.db_path)
auth_repository = AuthRepository(settings.db_path)
edm_link_repository = EdmLinkRepository(settings.db_path)
kanban_repository = KanbanRepository(settings.db_path)
notification_repository = NotificationRepository(settings.db_path)
workflow_repository = WorkflowRepository(settings.db_path)
file_manager = ConfigFileManager(settings.config_dir)
collection_service = CollectionService(repository, file_manager, settings)
query_service = QueryService(repository)
auth_service = AuthService(auth_repository, settings)
automation_service = AutomationService(repository, settings)
edm_link_service = EdmLinkService(edm_link_repository)
kanban_service = KanbanService(kanban_repository, repository, workflow_repository)
notification_service = NotificationService(notification_repository)
workflow_service = WorkflowService(workflow_repository, kanban_repository, notification_service)

app = FastAPI(
    title="CVP Ops Console API",
    version="0.1.0",
    description="Read-only operational lookup API for CVP-managed devices.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.state.collection_service = collection_service
app.state.query_service = query_service
app.state.auth_service = auth_service
app.state.automation_service = automation_service
app.state.edm_link_service = edm_link_service
app.state.kanban_service = kanban_service
app.state.notification_service = notification_service
app.state.workflow_service = workflow_service
app.state.source_mode = "demo"
app.state.settings = settings
app.include_router(auth_router, prefix="/api/auth")
app.include_router(router, prefix="/api")
app.include_router(automation_router, prefix="/api/automation")
app.include_router(edm_link_router, prefix="/api/edm-links")
app.include_router(kanban_router, prefix="/api/kanban")
app.include_router(notification_router, prefix="/api/notifications")
app.include_router(workflow_router, prefix="/api/workflows")


@app.middleware("http")
async def attach_authenticated_user(request, call_next):
    path = request.url.path
    if path.startswith("/api") and path != "/api/auth/login":
        session_token = request.cookies.get(SESSION_COOKIE_NAME, "")
        user = auth_service.get_user_from_session(session_token)
        if not user:
            return JSONResponse(status_code=401, content={"detail": "로그인이 필요합니다."})
        request.state.current_user = user
    return await call_next(request)


@app.on_event("startup")
def bootstrap_demo_snapshot() -> None:
    auth_service.initialize()
    edm_link_service.initialize()
    kanban_service.initialize()
    notification_service.initialize()
    workflow_service.initialize()
    latest_job = collection_service.ensure_seed_data()
    app.state.source_mode = latest_job["source"]


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


frontend_dist = settings.console_dir / "frontend" / "dist"
frontend_assets = frontend_dist / "assets"

if frontend_assets.exists():
    app.mount("/assets", StaticFiles(directory=frontend_assets), name="frontend-assets")


def _spa_file(path: str) -> FileResponse:
    target = frontend_dist / path
    if target.exists() and target.is_file():
        return FileResponse(target)
    return FileResponse(frontend_dist / "index.html")


if frontend_dist.exists():
    @app.get("/")
    def serve_frontend_root() -> FileResponse:
        return FileResponse(frontend_dist / "index.html")


    @app.get("/{full_path:path}")
    def serve_frontend_app(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "health")):
            raise HTTPException(status_code=404, detail="Not found")
        return _spa_file(full_path)
