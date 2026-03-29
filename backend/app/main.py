from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.core.settings import get_settings
from app.repositories.snapshot_repository import SnapshotRepository
from app.services.collection_service import CollectionService
from app.services.query_service import QueryService
from app.storage.config_files import ConfigFileManager


settings = get_settings()
repository = SnapshotRepository(settings.db_path)
file_manager = ConfigFileManager(settings.config_dir)
collection_service = CollectionService(repository, file_manager, settings)
query_service = QueryService(repository)

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
app.state.source_mode = "demo"
app.include_router(router, prefix="/api")


@app.on_event("startup")
def bootstrap_demo_snapshot() -> None:
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
