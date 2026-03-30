from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.repositories.snapshot_repository import SnapshotRepository


KANBAN_COLUMNS = [
    'draft',
    'planned',
    'ready',
    'in_progress',
    'verifying',
    'done',
    'blocked',
]


class KanbanService:
    def __init__(self, repository: SnapshotRepository) -> None:
        self.repository = repository

    def list_board(self) -> dict[str, Any]:
        cards = [self._serialize_card(item) for item in self.repository.list_kanban_cards()]
        return {
            'columns': KANBAN_COLUMNS,
            'cards': cards,
        }

    def create_card(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = self._now()
        prepared = self._prepare_payload(payload, now)
        card_id = self.repository.create_kanban_card(prepared)
        return self.get_card(card_id)

    def update_card(self, card_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        prepared = self._prepare_payload(payload, self._now())
        self.repository.update_kanban_card(card_id, prepared)
        return self.get_card(card_id)

    def move_card(self, card_id: int, column_key: str, position: int) -> dict[str, Any]:
        self.repository.move_kanban_card(card_id, column_key, position, self._now())
        return self.get_card(card_id)

    def get_card(self, card_id: int) -> dict[str, Any]:
        for item in self.repository.list_kanban_cards():
            if int(item['id']) == card_id:
                return self._serialize_card(item)
        raise KeyError(card_id)

    def _prepare_payload(self, payload: dict[str, Any], timestamp: str) -> dict[str, Any]:
        work_type = str(payload.get('work_type', 'existing_device'))
        if work_type not in {'existing_device', 'new_device'}:
            raise ValueError('Unsupported work_type.')

        column_key = str(payload.get('column_key', 'draft'))
        if column_key not in KANBAN_COLUMNS:
            raise ValueError('Unsupported column_key.')

        prepared = {
            'title': str(payload.get('title', '')).strip(),
            'description': str(payload.get('description', '')).strip(),
            'work_type': work_type,
            'column_key': column_key,
            'existing_device_id': payload.get('existing_device_id') or None,
            'new_device_hostname': str(payload.get('new_device_hostname', '')).strip(),
            'new_device_mgmt_ip': str(payload.get('new_device_mgmt_ip', '')).strip(),
            'new_device_model': str(payload.get('new_device_model', '')).strip(),
            'new_device_serial': str(payload.get('new_device_serial', '')).strip(),
            'created_at': timestamp,
            'updated_at': timestamp,
        }

        if not prepared['title']:
            raise ValueError('Card title is required.')

        if work_type == 'existing_device':
            if not prepared['existing_device_id']:
                raise ValueError('existing_device_id is required for existing_device cards.')
            prepared['new_device_hostname'] = ''
            prepared['new_device_mgmt_ip'] = ''
            prepared['new_device_model'] = ''
            prepared['new_device_serial'] = ''
        else:
            prepared['existing_device_id'] = None

        return prepared

    def _serialize_card(self, item: dict[str, Any]) -> dict[str, Any]:
        linked_device = None
        if item.get('existing_device_id'):
            linked_device = {
                'device_id': item.get('existing_device_id'),
                'hostname': item.get('existing_device_hostname') or '',
                'mgmt_ip': item.get('existing_device_mgmt_ip') or '',
                'model': item.get('existing_device_model') or '',
                'serial': item.get('existing_device_serial') or '',
            }

        draft_device = None
        if item.get('work_type') == 'new_device':
            draft_device = {
                'hostname': item.get('new_device_hostname') or '',
                'mgmt_ip': item.get('new_device_mgmt_ip') or '',
                'model': item.get('new_device_model') or '',
                'serial': item.get('new_device_serial') or '',
            }

        return {
            'id': int(item['id']),
            'title': item['title'],
            'description': item.get('description', ''),
            'work_type': item['work_type'],
            'column_key': item['column_key'],
            'order_index': int(item.get('order_index', 0) or 0),
            'existing_device_id': item.get('existing_device_id'),
            'linked_device': linked_device,
            'draft_device': draft_device,
            'created_at': item['created_at'],
            'updated_at': item['updated_at'],
        }

    def _now(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
