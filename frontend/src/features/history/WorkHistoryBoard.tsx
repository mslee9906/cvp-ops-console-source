import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, History, RefreshCcw, RotateCcw } from 'lucide-react'

import { api } from '../../api'
import type { WorkHistoryItem, WorkflowBlock, WorkflowPhase } from '../../types'
import './history.css'

type HistoryViewMode = 'summary' | 'detail' | 'workflow'

export function WorkHistoryBoard() {
  const [items, setItems] = useState<WorkHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedItem, setSelectedItem] = useState<WorkHistoryItem | null>(null)
  const [viewMode, setViewMode] = useState<HistoryViewMode>('summary')
  const [restoring, setRestoring] = useState(false)

  const orderedItems = useMemo(
    () => [...items].sort((left, right) => right.completed_at.localeCompare(left.completed_at)),
    [items],
  )

  useEffect(() => {
    void loadHistory()
  }, [])

  async function loadHistory() {
    try {
      setLoading(true)
      setError('')
      const response = await api.getWorkHistory()
      setItems(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 이력을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function handleOpen(historyId: number) {
    try {
      setError('')
      const entry = await api.getWorkHistoryItem(historyId)
      setSelectedItem(entry)
      setViewMode('summary')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 이력 상세를 불러오지 못했습니다.')
    }
  }

  async function handleRestore() {
    if (!selectedItem) {
      return
    }
    const confirmed = window.confirm('이 작업을 작업 보드의 "작업 예정" 상태로 복원하시겠습니까?')
    if (!confirmed) {
      return
    }

    try {
      setRestoring(true)
      setError('')
      const restored = await api.restoreWorkHistoryItem(selectedItem.id)
      setSelectedItem(restored.history)
      await loadHistory()
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '작업 이력을 복원하지 못했습니다.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <section className="history-shell">
      <div className="history-toolbar">
        <div>
          <p className="history-kicker">Work History</p>
          <h3>작업 이력</h3>
          <p>완료 처리된 작업 카드를 별도 이력 DB에서 읽기 전용으로 보관하고, 필요하면 작업 예정으로 다시 복원합니다.</p>
        </div>
        <button className="history-ghost-button" type="button" onClick={() => void loadHistory()} disabled={loading}>
          <RefreshCcw size={16} />
          <span>다시 불러오기</span>
        </button>
      </div>

      {error ? <div className="history-message error">{error}</div> : null}
      {loading ? <div className="history-loading">작업 이력을 불러오는 중입니다.</div> : null}

      {!loading ? (
        <div className="history-grid">
          {orderedItems.map((item) => (
            <button key={item.id} className="history-card" type="button" onClick={() => void handleOpen(item.id)}>
              <div className="history-card-head">
                <span className={`history-type-chip ${item.card_type}`}>
                  {item.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}
                </span>
                <span className="history-card-code">{item.card_code}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.completed_note || '완료 메모가 없습니다.'}</p>
              <div className="history-card-meta">
                <span>완료자 {item.completed_by_name || '-'}</span>
                <span>{formatDateTime(item.completed_at)}</span>
              </div>
            </button>
          ))}

          {!orderedItems.length ? (
            <div className="history-empty-state">
              <History size={20} />
              <strong>보관된 작업 이력이 없습니다.</strong>
              <p>작업 보드에서 완료 처리된 카드가 이곳으로 이동합니다.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedItem ? (
        <div className="history-overlay" onClick={() => setSelectedItem(null)}>
          <div className="history-overlay-panel" onClick={(event) => event.stopPropagation()}>
            <div className="history-overlay-head">
              <div>
                <p className="history-kicker">Archived Card</p>
                <h3>{selectedItem.title}</h3>
                <small>{selectedItem.card_code}</small>
              </div>
              <button className="history-ghost-button" type="button" onClick={() => setSelectedItem(null)}>
                닫기
              </button>
            </div>

            {viewMode === 'summary' ? <HistorySummaryView item={selectedItem} /> : null}
            {viewMode === 'detail' ? <HistoryDetailView item={selectedItem} onBack={() => setViewMode('summary')} /> : null}
            {viewMode === 'workflow' ? <HistoryWorkflowView item={selectedItem} onBack={() => setViewMode('summary')} /> : null}

            <div className="history-overlay-actions">
              <div className="history-inline-actions">
                {viewMode !== 'summary' ? (
                  <button className="history-ghost-button" type="button" onClick={() => setViewMode('summary')}>
                    <ArrowLeft size={16} />
                    <span>작업 이력 처음 화면으로</span>
                  </button>
                ) : null}
              </div>
              <div className="history-inline-actions">
                <button className="history-ghost-button" type="button" onClick={() => setViewMode('detail')}>
                  자세히 보기
                </button>
                <button className="history-ghost-button" type="button" onClick={() => setViewMode('workflow')}>
                  워크플로우 보기
                </button>
                <button className="history-primary-button" type="button" onClick={() => void handleRestore()} disabled={restoring}>
                  <RotateCcw size={16} />
                  <span>{restoring ? '복원 중...' : '작업 보드로 복원'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function HistorySummaryView({ item }: { item: WorkHistoryItem }) {
  return (
    <div className="history-overlay-body">
      <dl className="history-summary-grid">
        <div>
          <dt>완료자</dt>
          <dd>{item.completed_by_name || '-'}</dd>
        </div>
        <div>
          <dt>완료 시각</dt>
          <dd>{formatDateTime(item.completed_at)}</dd>
        </div>
        <div>
          <dt>카드 유형</dt>
          <dd>{item.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</dd>
        </div>
        <div>
          <dt>복원 상태</dt>
          <dd>{item.restored_at ? `복원됨 (${formatDateTime(item.restored_at)})` : '보관 중'}</dd>
        </div>
      </dl>
      <div className="history-note-card">
        <strong>완료 메모</strong>
        <p>{item.completed_note || '입력된 완료 메모가 없습니다.'}</p>
      </div>
    </div>
  )
}

function HistoryDetailView({ item, onBack }: { item: WorkHistoryItem; onBack: () => void }) {
  const card = item.archived_card

  return (
    <div className="history-detail-shell">
      <div className="history-detail-head">
        <button className="history-ghost-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>작업 이력 처음 화면으로</span>
        </button>
      </div>

      <dl className="history-summary-grid">
        <div>
          <dt>상태</dt>
          <dd>{columnLabel(card.column_key)}</dd>
        </div>
        <div>
          <dt>담당자</dt>
          <dd>{card.assignee || '-'}</dd>
        </div>
        <div>
          <dt>우선순위</dt>
          <dd>{priorityLabel(card.priority)}</dd>
        </div>
        <div>
          <dt>완료 예정</dt>
          <dd>{card.due_at ? formatDateTime(card.due_at) : '-'}</dd>
        </div>
      </dl>

      <div className="history-note-card">
        <strong>작업 설명</strong>
        <p>{card.description || '설명 입력이 없습니다.'}</p>
      </div>

      <div className="history-target-table">
        <div className="history-target-row header">
          <span>장비명</span>
          <span>Mgmt IP</span>
          <span>Model</span>
          <span>연결 상태</span>
        </div>
        {(card.targets ?? []).map((target) => (
          <div key={`${target.id}-${target.display_name}`} className="history-target-row">
            <span>{target.display_name}</span>
            <span>{target.mgmt_ip || '-'}</span>
            <span>{target.model || '-'}</span>
            <span>{target.cvp_device_id ? 'CVP 연결' : '수기 입력'}</span>
          </div>
        ))}
      </div>

      <div className="history-config-list">
        {(card.planned_configs ?? []).map((config) => (
          <article key={`${config.target_id}-${config.id ?? 'cfg'}`} className="history-config-card">
            <strong>대상 #{config.target_id}</strong>
            <pre>{config.config_text || '(예정 Config 없음)'}</pre>
          </article>
        ))}
      </div>
    </div>
  )
}

function HistoryWorkflowView({ item, onBack }: { item: WorkHistoryItem; onBack: () => void }) {
  const workflow = item.archived_workflow
  const phases = (workflow?.phases ?? []) as WorkflowPhase[]

  return (
    <div className="history-detail-shell">
      <div className="history-detail-head">
        <button className="history-ghost-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>작업 이력 처음 화면으로</span>
        </button>
      </div>

      <div className="history-note-card">
        <strong>{workflow?.projectName || item.title}</strong>
        <p>{workflow?.summary || '워크플로우 요약이 없습니다.'}</p>
      </div>

      <div className="history-workflow-list">
        {phases.map((phase) => (
          <article key={phase.id} className="history-phase-card">
            <div className="history-phase-head">
              <div>
                <strong>{phase.title}</strong>
                <p>{phase.subtitle || '설명 없음'}</p>
              </div>
              <span>{phase.assigneeName || '미지정'}</span>
            </div>
            <div className="history-block-list">
              {(phase.blocks ?? []).map((block) => (
                <HistoryBlockView key={block.id} block={block} />
              ))}
            </div>
          </article>
        ))}
        {!phases.length ? <div className="history-empty-inline">보관된 워크플로우 정보가 없습니다.</div> : null}
      </div>
    </div>
  )
}

function HistoryBlockView({ block }: { block: WorkflowBlock }) {
  if (block.type === 'note') {
    return (
      <section className="history-block">
        <strong>{block.title}</strong>
        <p>{block.content || '메모 없음'}</p>
      </section>
    )
  }

  if (block.type === 'checklist') {
    return (
      <section className="history-block">
        <strong>{block.title}</strong>
        <div className="history-checklist">
          {block.items.map((item, index) => (
            <div key={`${block.id}-${index}`} className="history-check-item">
              <span>{item.done ? '완료' : '미완료'}</span>
              <strong>{item.text}</strong>
              <small>{item.assignee || '-'}</small>
            </div>
          ))}
        </div>
      </section>
    )
  }

  if (block.type === 'links') {
    return (
      <section className="history-block">
        <strong>{block.title}</strong>
        <div className="history-link-list">
          {block.items.map((item, index) => (
            <div key={`${block.id}-${index}`} className="history-link-item">
              <strong>{item.label}</strong>
              <p>{item.description || '설명 없음'}</p>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="history-block">
      <strong>{block.title}</strong>
      <div className="history-table-shell">
        <table className="history-table">
          <thead>
            <tr>
              {block.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={`${block.id}-${index}`}>
                {block.columns.map((column) => (
                  <td key={column.key}>{String(row[column.key] ?? '') || '-'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function formatDateTime(value: string) {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function columnLabel(columnKey: string) {
  const labels: Record<string, string> = {
    blocked: '보류',
    planned: '작업 예정',
    ready: '준비 완료',
    in_progress: '작업 중',
    verifying: '검증 중',
    done: '완료',
  }
  return labels[columnKey] ?? columnKey
}

function priorityLabel(priority: string) {
  if (priority === 'high') return '높음'
  if (priority === 'low') return '낮음'
  return '중간'
}
