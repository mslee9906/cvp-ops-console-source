from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock, Thread
from typing import Any

from app.collectors.cvp_suite import CVPCollectorSuite
from app.collectors.mock_suite import MockCollectorSuite
from app.core.settings import Settings
from app.repositories.snapshot_repository import SnapshotRepository
from app.storage.config_files import ConfigFileManager


class CollectionService:
    def __init__(
        self,
        repository: SnapshotRepository,
        file_manager: ConfigFileManager,
        settings: Settings,
    ) -> None:
        self.repository = repository
        self.file_manager = file_manager
        self.settings = settings
        self._progress_lock = Lock()
        self._progress: dict[str, Any] = {
            'source_mode': self._source_mode(),
            'status': 'idle',
            'progress_percent': 0,
            'step': 'idle',
            'detail': '',
            'started_at': '',
            'updated_at': '',
            'latest_job': None,
        }
        self._refresh_thread: Thread | None = None

    def ensure_seed_data(self) -> dict[str, str]:
        self.repository.initialize()
        desired_source = self._source_mode()
        if self.repository.is_empty():
            return self.refresh()

        overview = self.repository.get_overview()
        latest_job = overview.get('latest_job')
        if not latest_job:
            return self.refresh()
        if latest_job.get('source') != desired_source or latest_job.get('status') != 'success':
            return self.refresh()
        return latest_job or {
            'job_name': 'unknown',
            'source': desired_source,
            'status': 'success',
            'start_time': '',
            'end_time': '',
            'error_message': '',
        }

    def refresh(self) -> dict[str, str]:
        started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
        source = self._source_mode()
        self._set_progress(
            source_mode=source,
            status='running',
            progress_percent=2,
            step='starting',
            detail='Starting snapshot collection.',
            started_at=started_at,
        )

        try:
            suite = self._get_suite(source)
            snapshot = suite.collect(progress_callback=self._set_progress)
            self._set_progress(
                progress_percent=82,
                step='config_files',
                detail='Persisting config backup files.',
            )
            config_metadata = self.file_manager.persist(snapshot.get('configs', []))
            self._set_progress(
                progress_percent=93,
                step='database',
                detail='Updating the snapshot database.',
            )
            finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')

            latest_job = {
                'job_name': 'refresh_snapshot',
                'source': source,
                'status': 'success',
                'start_time': started_at,
                'end_time': finished_at,
                'error_message': '',
            }
            self.repository.replace_snapshot(snapshot, config_metadata, latest_job)
            self._set_progress(
                source_mode=source,
                status='success',
                progress_percent=100,
                step='completed',
                detail='Snapshot refresh completed.',
                updated_at=finished_at,
                latest_job=latest_job,
            )
            return latest_job
        except Exception as exc:
            finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
            latest_job = {
                'job_name': 'refresh_snapshot',
                'source': source,
                'status': 'failed',
                'start_time': started_at,
                'end_time': finished_at,
                'error_message': str(exc),
            }
            self.repository.record_job(latest_job)
            self._set_progress(
                source_mode=source,
                status='failed',
                progress_percent=100,
                step='failed',
                detail=str(exc),
                updated_at=finished_at,
                latest_job=latest_job,
            )
            return latest_job

    def start_refresh(self) -> dict[str, Any]:
        with self._progress_lock:
            if self._refresh_thread and self._refresh_thread.is_alive():
                return dict(self._progress)

            now = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
            self._progress = {
                'source_mode': self._source_mode(),
                'status': 'running',
                'progress_percent': 1,
                'step': 'queued',
                'detail': 'Refresh request received.',
                'started_at': now,
                'updated_at': now,
                'latest_job': self._progress.get('latest_job'),
            }
            self._refresh_thread = Thread(target=self.refresh, daemon=True)
            self._refresh_thread.start()
            return dict(self._progress)

    def get_progress(self) -> dict[str, Any]:
        with self._progress_lock:
            progress = dict(self._progress)
        if progress.get('latest_job') is None:
            overview = self.repository.get_overview()
            progress['latest_job'] = overview.get('latest_job')
        progress['source_mode'] = self._source_mode()
        return progress

    def _source_mode(self) -> str:
        if self.settings.use_mock_data or not self.settings.has_cvp_credentials:
            return 'demo'
        return 'cvp'

    def _get_suite(self, source: str) -> Any:
        if source == 'cvp':
            return CVPCollectorSuite(self.settings)
        return MockCollectorSuite(self.settings.sample_snapshot_path)

    def _set_progress(self, *args: Any, **changes: Any) -> None:
        if args and isinstance(args[0], dict):
            changes.update(args[0])
        with self._progress_lock:
            current = dict(self._progress)
            current.update({key: value for key, value in changes.items() if value is not None})
            current['updated_at'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
            if current.get('status') == 'running' and not current.get('started_at'):
                current['started_at'] = current['updated_at']
            self._progress = current

