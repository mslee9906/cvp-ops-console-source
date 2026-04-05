import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ClipboardList, History, RefreshCcw, RotateCcw, Search } from 'lucide-react'

import { api } from '../../api'
import type { UserSummary, WorkHistoryItem } from '../../types'
import { WorkflowBoard } from '../workflow/WorkflowBoard'
import './history.css'

type Props = {
  currentUser: UserSummary | null
  users: UserSummary[]
}

type HistoryViewMode = 'list' | 'detail' | 'workflow'
type DetailStepKey = 'basic' | 'target' | 'complete'

const DETAIL_STEP_META: Array<{ key: DetailStepKey; label: string; body: string }> = [
  { key: 'basic', label: '기본 정보', body: '작업 카드의 기본 정보와 상태를 읽기 전용으로 확인합니다.' },
  { key: 'target', label: '작업 대상', body: '완료 시점에 저장된 작업 대상과 연결 상태를 확인합니다.' },
  { key: 'complete', label: '작업 완료', body: '완료 메모와 완료자, 완료 시각을 확인합니다.' },
]

const columnLabels: Record<string, string> = {
  blocked: '보류',
  planned: '작업 예정',
  ready: '준비 완료',
  in_progress: '작업 중',
  verifying: '검증 중',
  done: '완료',
}

const priorityLabels: Record<string, string> = {
  high: '높음',
  medium: '중간',
  low: '낮음',
}

export function WorkHistoryBoard({ currentUser, users }: Props) {
  const [items, setItems] = useState<WorkHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [viewMode, setViewMode] = useState<HistoryViewMode>('list')
  const [activeDetailStep, setActiveDetailStep] = useState<DetailStepKey>('basic')
  const [restoring, setRestoring] = useState(false)
  const [message, setMessage] = useState('')

  const deferredSearch = useDeferredValue(search)
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId],
  )

  const filteredItems = useMemo(() => {
    const token = deferredSearch.trim().toLowerCase()
    const sorted = [...items].sort((left, right) => String(right.completed_at).localeCompare(String(left.completed_at)))
    if (!token) {
      return sorted
    }
    return sorted.filter((item) => {
      const card = item.archived_card
      return [
        item.card_code,
        item.title,
        item.completed_note,
        item.completed_by_name,
        card.description,
        card.assignee,
        card.created_by_name,
      ]
        .join(' ')
        .toLowerCase()
        .includes(token)
    })
  }, [deferredSearch, items])

  const activeStepMeta = useMemo(
    () => DETAIL_STEP_META.find((step) => step.key === activeDetailStep) ?? DETAIL_STEP_META[0],
    [activeDetailStep],
  )

  useEffect(() => {
    void loadHistory()
  }, [])

  useEffect(() => {
    if (!message) {
      return
    }
    const timer = window.setTimeout(() => setMessage(''), 1400)
    return () => window.clearTimeout(timer)
  }, [message])

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

  function openSummary(item: WorkHistoryItem) {
    setSelectedItemId(item.id)
    setOverlayOpen(true)
  }

  function closeSummary() {
    setOverlayOpen(false)
  }

  function openDetailView() {
    if (!selectedItem) {
      return
    }
    setActiveDetailStep('basic')
    setOverlayOpen(false)
    setViewMode('detail')
  }

  function openWorkflowView() {
    if (!selectedItem) {
      return
    }
    setOverlayOpen(false)
    setViewMode('workflow')
  }

  function returnToList() {
    setViewMode('list')
    setOverlayOpen(false)
    setActiveDetailStep('basic')
  }

  async function handleRestore(item: WorkHistoryItem) {
    try {
      setRestoring(true)
      setError('')
      const response = await api.restoreWorkHistoryItem(item.id)
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? response.history : entry)),
      )
      setOverlayOpen(false)
      setViewMode('list')
      setMessage('작업 보드로 복원했습니다.')
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '작업 복원에 실패했습니다.')
    } finally {
      setRestoring(false)
    }
  }

  if (viewMode === 'workflow' && selectedItem) {
    return (
      <WorkflowBoard
        currentUser={currentUser}
        users={users}
        readOnlyCard={selectedItem.archived_card}
        readOnlyWorkflow={selectedItem.archived_workflow}
        onBack={returnToList}
        backLabel="작업 이력으로 돌아가기"
      />
    )
  }

  if (viewMode === 'detail' && selectedItem) {
    const card = selectedItem.archived_card
    const detailProgress = {
      percent: card.progress_percent ?? 0,
      completed: card.checklist_completed ?? 0,
      total: card.checklist_total ?? 0,
    }

    return (
      <section className="kanban-detail-shell history-shell">
        <div className="kanban-detail-layout">
          <aside className="kanban-detail-sidebar">
            <article className="kanban-detail-summary-card">
              <div className="kanban-detail-back-row">
                <button className="kanban-ghost-button" type="button" onClick={returnToList}>
                  <ArrowLeft size={16} />
                  <span>작업 이력으로 돌아가기</span>
                </button>
              </div>
              <div className="kanban-summary-head">
                <div className="kanban-summary-title">
                  <p className="kanban-kicker">Archived Card</p>
                  <h3>{card.title}</h3>
                  <small className="kanban-summary-ticket">{card.card_code}</small>
                </div>
              </div>
              <div className="kanban-summary-row">
                <span>담당자</span>
                <strong>{card.assignee?.trim() || '미지정'}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>생성자</span>
                <strong>{card.created_by_name || '미지정'}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>현재 상태</span>
                <strong>{columnLabel(card.column_key)}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>작업 유형</span>
                <strong>{card.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>작업 대상</span>
                <strong>{card.targets?.length ?? 0}대</strong>
              </div>
              <div className="kanban-summary-row">
                <span>우선순위</span>
                <strong>{priorityLabel(card.priority)}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>완료 예정</span>
                <strong>{card.due_at ? formatDueDateTime(card.due_at) : '미지정'}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>마지막 갱신</span>
                <strong>{formatDateTime(card.updated_at)}</strong>
              </div>
              <div className="kanban-summary-row">
                <span>최종 수정자</span>
                <strong>{card.updated_by_name || '미지정'}</strong>
              </div>
              <div className="kanban-progress-card">
                <div className="kanban-progress-head">
                  <span>현재 진행률</span>
                  <strong>{detailProgress.percent}%</strong>
                </div>
                <div className="kanban-progress-bar" aria-hidden="true">
                  <span style={{ width: `${detailProgress.percent}%` }} />
                </div>
                <p className="kanban-progress-copy">
                  완료 {detailProgress.completed} / 전체 {detailProgress.total}
                </p>
              </div>
            </article>

            <section className="kanban-step-panel">
              <p className="kanban-kicker">세부 항목</p>
              {DETAIL_STEP_META.map((step) => (
                <button
                  key={step.key}
                  className={`kanban-step-link ${activeDetailStep === step.key ? 'active' : ''}`}
                  type="button"
                  onClick={() => setActiveDetailStep(step.key)}
                >
                  <div className="kanban-step-text">
                    <strong>{step.label}</strong>
                    <p>{step.body}</p>
                  </div>
                </button>
              ))}
            </section>
          </aside>

          <section className="kanban-detail-main">
            <div className="kanban-section-head">
              <div>
                <p className="kanban-kicker">Stage Workspace</p>
                <h3>{activeStepMeta.label}</h3>
                <p className="kanban-stage-copy">{activeStepMeta.body}</p>
              </div>
            </div>
            <div className="kanban-stage-body">
              {activeDetailStep === 'basic' ? (
                <section className="kanban-form history-readonly-form">
                  <label className="kanban-field wide">
                    <span>작업 제목</span>
                    <input value={card.title} readOnly disabled />
                  </label>

                  <div className="kanban-field-grid">
                    <label className="kanban-field">
                      <span>담당자</span>
                      <input value={card.assignee || ''} readOnly disabled />
                    </label>
                    <label className="kanban-field">
                      <span>현재 상태</span>
                      <input value={columnLabel(card.column_key)} readOnly disabled />
                    </label>
                    <label className="kanban-field">
                      <span>작업 유형</span>
                      <input value={card.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'} readOnly disabled />
                    </label>
                    <label className="kanban-field">
                      <span>우선순위</span>
                      <input value={priorityLabel(card.priority)} readOnly disabled />
                    </label>
                    <label className="kanban-field">
                      <span>완료 예정 일시</span>
                      <input value={card.due_at ? formatDueDateTime(card.due_at) : ''} readOnly disabled />
                    </label>
                  </div>

                  <label className="kanban-field wide">
                    <span>작업 설명</span>
                    <textarea value={card.description || ''} rows={8} readOnly disabled />
                  </label>
                </section>
              ) : null}

              {activeDetailStep === 'target' ? (
                <section className="kanban-form history-readonly-form">
                  <section className="kanban-target-panel">
                    <div className="kanban-target-head">
                      <div>
                        <p className="kanban-kicker">Target Inventory</p>
                        <h4>{card.card_type === 'new' ? '신규 장비 작업 대상' : '기존 장비 작업 대상'}</h4>
                      </div>
                    </div>
                    {(card.targets ?? []).length > 0 ? (
                      <div className="kanban-target-table-shell">
                        <div className="kanban-target-table-head">
                          <strong>현재 등록된 작업 대상</strong>
                          <span>{card.targets.length}대</span>
                        </div>
                        <div className="kanban-target-table">
                          <div className="kanban-target-table-row header">
                            <span>장비명</span>
                            <span>Mgmt IP</span>
                            <span>Model</span>
                            <span>연결 상태</span>
                            <span>역할</span>
                          </div>
                          {card.targets.map((target, index) => (
                            <div key={target.id ?? `${target.display_name}-${index}`} className="kanban-target-table-row">
                              <span>{target.display_name || '-'}</span>
                              <span>{target.mgmt_ip || '-'}</span>
                              <span>{target.model || '-'}</span>
                              <span>{target.cvp_device_id ? 'CVP 연결됨' : '수기 등록 대상'}</span>
                              <span>{target.role_hint || '-'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="kanban-target-empty">
                        <strong>등록된 작업 대상이 없습니다.</strong>
                        <p>이 카드에는 저장된 대상 장비가 없습니다.</p>
                      </div>
                    )}
                  </section>
                </section>
              ) : null}

              {activeDetailStep === 'complete' ? (
                <section className="kanban-form history-readonly-form">
                  <div className="kanban-note-card">
                    <strong>완료 처리 정보</strong>
                    <p>완료 당시 저장된 메모와 완료 정보를 읽기 전용으로 확인합니다.</p>
                  </div>

                  <div className="history-detail-grid">
                    <div className="kanban-summary-row">
                      <span>완료자</span>
                      <strong>{selectedItem.completed_by_name || '미지정'}</strong>
                    </div>
                    <div className="kanban-summary-row">
                      <span>완료 시각</span>
                      <strong>{formatDateTime(selectedItem.completed_at)}</strong>
                    </div>
                  </div>

                  <label className="kanban-field wide">
                    <span>완료 메모</span>
                    <textarea value={selectedItem.completed_note || ''} rows={8} readOnly disabled />
                  </label>
                </section>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    )
  }

  return (
    <section className="kanban-shell history-shell">
      <div className="kanban-toolbar">
        <div>
          <p className="kanban-kicker">Archived Tasks</p>
          <h3>작업 이력</h3>
          <p className="kanban-copy">완료된 작업 카드를 작업 보드 카드 형식 그대로 모아 보고, 요약 오버레이에서 상세 정보와 워크플로우를 읽기 전용으로 확인합니다.</p>
        </div>
        <div className="history-toolbar-actions">
          <label className="history-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="카드 코드, 제목, 완료 메모, 완료자를 검색하세요."
            />
          </label>
          <button className="kanban-ghost-button" type="button" onClick={() => void loadHistory()} disabled={loading || restoring}>
            <RefreshCcw size={16} />
            <span>이력 새로고침</span>
          </button>
        </div>
      </div>

      {message ? <div className="kanban-message">{message}</div> : null}
      {error ? <div className="kanban-message error">{error}</div> : null}
      {loading ? <div className="kanban-loading">작업 이력을 불러오는 중입니다.</div> : null}

      {!loading ? (
        <div className="history-kanban-grid">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const card = item.archived_card
              return (
                <article
                  key={item.id}
                  className={`kanban-card priority-${card.priority} history-card ${item.restored_card_id ? 'is-restored' : ''}`}
                  onClick={() => openSummary(item)}
                >
                  <div className="kanban-card-top">
                    <div className="kanban-card-title-block">
                      <span className="kanban-card-code">{item.card_code}</span>
                      <h4>{item.title}</h4>
                    </div>
                    <span className={`kanban-type-badge ${card.card_type}`}>
                      {card.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}
                    </span>
                  </div>

                  <p className="kanban-card-description">{card.description || item.completed_note || '완료 메모가 없습니다.'}</p>
                  <div className="kanban-card-ownership">
                    <span>완료자 {item.completed_by_name || '미지정'}</span>
                    <span>담당자 {card.assignee || '미지정'}</span>
                  </div>
                  <div className="kanban-card-meta">
                    <span>{`완료 ${formatDateTime(item.completed_at)}`}</span>
                  </div>
                  <div className="kanban-card-progress" aria-hidden="true">
                    <span style={{ width: `${card.progress_percent}%` }} />
                  </div>
                  <div className="kanban-card-foot">
                    <span className="kanban-grip">
                      <History size={14} />
                      {item.restored_card_id ? '복원 이력 있음' : '이력 보기'}
                    </span>
                    <button className="kanban-link-button" type="button" onClick={(event) => {
                      event.stopPropagation()
                      openSummary(item)
                    }}>
                      이력 보기
                    </button>
                  </div>
                </article>
              )
            })
          ) : (
            <div className="kanban-empty-state history-empty-state">
              <strong>검색 결과가 없습니다.</strong>
              <p>다른 검색어로 다시 확인해 보세요.</p>
            </div>
          )}
        </div>
      ) : null}

      {overlayOpen && selectedItem ? (
        <div className="history-overlay" onClick={closeSummary}>
          <div className="history-overlay-backdrop" />
          <div className="history-overlay-panel" onClick={(event) => event.stopPropagation()}>
            <div className="history-overlay-head">
              <div>
                <p className="kanban-kicker">History Summary</p>
                <h3>{selectedItem.title}</h3>
                <p className="history-overlay-copy">완료 메모와 완료 정보를 확인한 뒤, 자세히 보기 또는 워크플로우 보기로 이동할 수 있습니다.</p>
              </div>
              <button className="kanban-ghost-button" type="button" onClick={closeSummary}>
                닫기
              </button>
            </div>

            <div className="history-summary-grid">
              <div>
                <span>작업 코드</span>
                <strong>{selectedItem.card_code}</strong>
              </div>
              <div>
                <span>완료자</span>
                <strong>{selectedItem.completed_by_name || '미지정'}</strong>
              </div>
              <div>
                <span>완료 시각</span>
                <strong>{formatDateTime(selectedItem.completed_at)}</strong>
              </div>
              <div>
                <span>복원 상태</span>
                <strong>{selectedItem.restored_card_id ? `작업 예정으로 복원됨 (#${selectedItem.restored_card_id})` : '보관 중'}</strong>
              </div>
            </div>

            <label className="kanban-field wide">
              <span>완료 메모</span>
              <textarea value={selectedItem.completed_note || ''} rows={6} readOnly disabled />
            </label>

            <div className="history-overlay-actions">
              <button className="kanban-ghost-button" type="button" onClick={openDetailView}>
                <ClipboardList size={16} />
                <span>자세히 보기</span>
              </button>
              <button className="kanban-ghost-button" type="button" onClick={openWorkflowView}>
                <History size={16} />
                <span>워크플로우 보기</span>
              </button>
              <button className="kanban-primary-button" type="button" onClick={() => void handleRestore(selectedItem)} disabled={restoring}>
                <RotateCcw size={16} />
                <span>{restoring ? '복원 중...' : '작업 보드로 복원'}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function columnLabel(value: string) {
  return columnLabels[value] ?? (value || '미지정')
}

function priorityLabel(value: string) {
  return priorityLabels[value] ?? (value || '미지정')
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return '미지정'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  const year = parsed.getFullYear()
  const month = `${parsed.getMonth() + 1}`.padStart(2, '0')
  const day = `${parsed.getDate()}`.padStart(2, '0')
  const hours = `${parsed.getHours()}`.padStart(2, '0')
  const minutes = `${parsed.getMinutes()}`.padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function formatDueDateTime(value?: string | null) {
  if (!value) {
    return '미지정'
  }
  return value.replace('T', ' ')
}
