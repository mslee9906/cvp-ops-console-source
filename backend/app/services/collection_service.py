from __future__ import annotations

from datetime import datetime, timezone
import logging
from threading import Lock, Thread
from typing import Any

from app.collectors.cvp_suite import CVPCollectorSuite
from app.collectors.mock_suite import MockCollectorSuite
from app.core.settings import Settings
from app.repositories.snapshot_repository import SnapshotRepository
from app.storage.config_files import ConfigFileManager


logger = logging.getLogger(__name__)


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
        logger.info("Startup bootstrap started. desired_source=%s", desired_source)
        if self.repository.is_empty():
            logger.info("Snapshot database is empty. Running initial refresh during startup.")
            return self.refresh()

        overview = self.repository.get_overview()
        latest_job = overview.get('latest_job')
        if not latest_job:
            logger.info("No previous collection job found. Running refresh during startup.")
            return self.refresh()
        if latest_job.get('source') != desired_source or latest_job.get('status') != 'success':
            logger.info(
                "Snapshot refresh required during startup. previous_source=%s previous_status=%s desired_source=%s",
                latest_job.get('source'),
                latest_job.get('status'),
                desired_source,
            )
            return self.refresh()
        logger.info("Existing successful snapshot found. Startup bootstrap finished without refresh.")
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
        logger.info("Snapshot refresh started. source=%s started_at=%s", source, started_at)
        self._set_progress(
            source_mode=source,
            status='running',
            progress_percent=2,
            step='starting',
            detail='Starting snapshot collection.',
            started_at=started_at,
        )

        try:
            failure_details: list[str] = []
            if source == 'cvp':
                snapshot, failure_details = self._collect_cvp_snapshot()
            else:
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
                'error_message': '; '.join(failure_details),
            }
            self.repository.replace_snapshot(snapshot, config_metadata, latest_job)
            logger.info(
                "Snapshot refresh completed successfully. source=%s devices=%s bgp=%s vrfs=%s vlans=%s vnis=%s ip_records=%s configs=%s source_failures=%s",
                source,
                len(snapshot.get('devices', [])),
                len(snapshot.get('bgp', [])),
                len(snapshot.get('vrfs', [])),
                len(snapshot.get('vlans', [])),
                len(snapshot.get('vnis', [])),
                len(snapshot.get('ip_records', [])),
                len(snapshot.get('configs', [])),
                len(failure_details),
            )
            self._set_progress(
                source_mode=source,
                status='success',
                progress_percent=100,
                step='completed',
                detail='Snapshot refresh completed.' if not failure_details else f"Snapshot refresh completed with warnings. Failed sources: {len(failure_details)}.",
                updated_at=finished_at,
                latest_job=latest_job,
            )
            return latest_job
        except Exception as exc:
            finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
            logger.exception("Snapshot refresh failed. source=%s error=%s", source, exc)
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
            logger.info("Background snapshot refresh thread started.")
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
            raise RuntimeError('CVP suite selection is handled by _collect_cvp_snapshot')
        return MockCollectorSuite(self.settings.sample_snapshot_path)

    def _collect_cvp_snapshot(self) -> tuple[dict[str, Any], list[str]]:
        sources = self.settings.cvp_sources
        if not sources:
            raise RuntimeError('No CVP hosts are configured.')

        aggregated = self._empty_snapshot()
        failures: list[str] = []
        success_count = 0
        total_sources = len(sources)

        for index, endpoint in enumerate(sources, start=1):
            range_start = 4 + int(((index - 1) / total_sources) * 74)
            range_end = 4 + int((index / total_sources) * 74)
            suite = CVPCollectorSuite(self.settings, endpoint)
            try:
                snapshot = suite.collect(
                    progress_callback=self._build_source_progress_callback(
                        endpoint.name,
                        range_start,
                        range_end,
                    )
                )
                self._extend_snapshot(aggregated, snapshot)
                success_count += 1
            except Exception as exc:
                message = f"{endpoint.name}: {exc}"
                failures.append(message)
                logger.exception("Snapshot source collection failed. source=%s error=%s", endpoint.name, exc)
                self._set_progress(
                    progress_percent=range_end,
                    step='source_failed',
                    detail=f"[{endpoint.name}] Collection failed: {exc}",
                )

        if success_count == 0:
            raise RuntimeError("All CVP sources failed. " + "; ".join(failures))

        return aggregated, failures

    def _build_source_progress_callback(
        self,
        source_name: str,
        range_start: int,
        range_end: int,
    ) -> Any:
        spread = max(range_end - range_start, 1)

        def relay(update: dict[str, Any]) -> None:
            raw_percent = max(0, min(int(update.get('progress_percent', 0)), 100))
            scaled_percent = range_start + int((raw_percent / 100) * spread)
            detail = str(update.get('detail', '') or '')
            if detail:
                detail = f"[{source_name}] {detail}"
            self._set_progress(
                progress_percent=scaled_percent,
                step=update.get('step', 'collect'),
                detail=detail,
            )

        return relay

    def _empty_snapshot(self) -> dict[str, list[dict[str, Any]]]:
        return {
            'devices': [],
            'bgp': [],
            'vrfs': [],
            'vlans': [],
            'vnis': [],
            'ip_records': [],
            'configs': [],
        }

    def _extend_snapshot(self, target: dict[str, Any], snapshot: dict[str, Any]) -> None:
        for key in ('devices', 'bgp', 'vrfs', 'vlans', 'vnis', 'ip_records', 'configs'):
            target.setdefault(key, [])
            target[key].extend(snapshot.get(key, []))

    def _set_progress(self, *args: Any, **changes: Any) -> None:
        if args and isinstance(args[0], dict):
            changes.update(args[0])
        with self._progress_lock:
            current = dict(self._progress)
            previous_status = current.get('status')
            previous_step = current.get('step')
            previous_percent = current.get('progress_percent')
            current.update({key: value for key, value in changes.items() if value is not None})
            current['updated_at'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
            if current.get('status') == 'running' and not current.get('started_at'):
                current['started_at'] = current['updated_at']
            self._progress = current
        if (
            current.get('status') != previous_status
            or current.get('step') != previous_step
            or current.get('progress_percent') != previous_percent
        ):
            logger.info(
                "Collection progress: status=%s step=%s percent=%s detail=%s",
                current.get('status'),
                current.get('step'),
                current.get('progress_percent'),
                current.get('detail', ''),
            )

