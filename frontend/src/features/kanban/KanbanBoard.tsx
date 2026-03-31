import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { ArrowLeft, GripVertical, Plus, RefreshCcw, Search, Trash2 } from 'lucide-react'

import { api } from '../../api'
import type {
  DeviceSummary,
  KanbanCard,
  KanbanCardInput,
  KanbanColumnKey,
  KanbanPlannedConfigItem,
  KanbanTargetItem,
  KanbanTargetKind,
} from '../../types'
import { AutoGrowTextarea } from './AutoGrowTextarea'
import { KanbanCardModal } from './KanbanCardModal'
import './kanban.css'

type DetailStepKey = 'basic' | 'target' | 'checklist'

const COLUMN_META: Array<{ key: KanbanColumnKey; label: string; tone: string }> = [
  { key: 'blocked', label: '보류', tone: 'rose' },
  { key: 'planned', label: '작업 예정', tone: 'blue' },
  { key: 'ready', label: '준비 완료', tone: 'teal' },
  { key: 'in_progress', label: '작업 중', tone: 'amber' },
  { key: 'verifying', label: '검증 중', tone: 'blue' },
  { key: 'done', label: '완료', tone: 'teal' },
]

const DETAIL_STEP_META: Array<{ key: DetailStepKey; label: string; body: string }> = [
  { key: 'basic', label: '기본 정보', body: '제목, 담당자, 상태와 작업 분류를 정리합니다.' },
  { key: 'target', label: '작업 대상', body: '기존 장비는 인벤토리에서 선택하고, 신규 장비는 수기로 등록합니다.' },
  { key: 'checklist', label: '체크리스트', body: '체크 항목과 진행률을 관리합니다.' },
]

const EMPTY_CARD_INPUT: KanbanCardInput = {
  title: '',
  description: '',
  assignee: '',
  column_key: 'planned',
  card_type: 'existing',
  priority: 'medium',
  checklist_items: [],
  targets: [],
  planned_configs: [],
}

export function KanbanBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null)
  const [editorCard, setEditorCard] = useState<KanbanCard | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [detailDraft, setDetailDraft] = useState<KanbanCardInput | null>(null)
  const [activeDetailStep, setActiveDetailStep] = useState<DetailStepKey>('basic')
  const [dragCardId, setDragCardId] = useState<number | null>(null)
  const [dragChecklistIndex, setDragChecklistIndex] = useState<number | null>(null)
  const [targetSearch, setTargetSearch] = useState('')
  const checklistDraftIdRef = useRef(-1)
  const targetDraftIdRef = useRef(-1)

  const deferredTargetSearch = useDeferredValue(targetSearch)

  const selectedCard = useMemo(
    () => cards.find((item) => item.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )
  const detailProgress = useMemo(
    () => calculateProgress(detailDraft?.checklist_items ?? selectedCard?.checklist_items ?? []),
    [detailDraft?.checklist_items, selectedCard?.checklist_items],
  )
  const activeStepMeta = useMemo(
    () => DETAIL_STEP_META.find((step) => step.key === activeDetailStep) ?? DETAIL_STEP_META[0],
    [activeDetailStep],
  )

  const groupedCards = useMemo(() => {
    return Object.fromEntries(
      COLUMN_META.map((meta) => [meta.key, sortCards(cards.filter((card) => card.column_key === meta.key))]),
    ) as Record<KanbanColumnKey, KanbanCard[]>
  }, [cards])

  const targetRows = detailDraft?.targets ?? []
  const inventoryCandidates = useMemo(() => {
    const token = deferredTargetSearch.trim().toLowerCase()
    const selectedIds = new Set(
      (detailDraft?.targets ?? [])
        .map((item) => item.cvp_device_id)
        .filter(Boolean),
    )
    return devices
      .filter((device) => {
        if (selectedIds.has(device.device_id)) {
          return false
        }
        if (!token) {
          return true
        }
        return [device.hostname, device.mgmt_ip, device.model, device.serial, device.site]
          .join(' ')
          .toLowerCase()
          .includes(token)
      })
      .slice(0, 8)
  }, [deferredTargetSearch, detailDraft?.targets, devices])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    if (selectedCard) {
      setDetailDraft(toCardInput(selectedCard))
    }
  }, [selectedCard])

  async function bootstrap() {
    try {
      setLoading(true)
      setError('')
      const [cardResponse, deviceResponse] = await Promise.all([api.getKanbanCards(), api.getDevices()])
      setCards(sortCards(cardResponse))
      setDevices(deviceResponse)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '칸반 정보를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function loadCards() {
    try {
      setLoading(true)
      setError('')
      const response = await api.getKanbanCards()
      setCards(sortCards(response))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '칸반 카드를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function loadDevices() {
    try {
      setDeviceLoading(true)
      setError('')
      const response = await api.getDevices()
      setDevices(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '장비 인벤토리를 불러오지 못했습니다.')
    } finally {
      setDeviceLoading(false)
    }
  }

  function openCreateModal() {
    setEditorMode('create')
    setEditorCard(null)
  }

  function openEditModal(card: KanbanCard) {
    setEditorMode('edit')
    setEditorCard(card)
  }

  function closeModal() {
    setEditorMode(null)
    setEditorCard(null)
  }

  function openDetail(card: KanbanCard) {
    setSelectedCardId(card.id)
    setDetailDraft(toCardInput(card))
    setActiveDetailStep('basic')
    setDragChecklistIndex(null)
    setTargetSearch('')
  }

  function closeDetail() {
    setSelectedCardId(null)
    setDetailDraft(null)
    setActiveDetailStep('basic')
    setDragChecklistIndex(null)
    setTargetSearch('')
  }

  async function handleCreate(values: KanbanCardInput) {
    try {
      setSubmitting(true)
      setError('')
      const created = await api.createKanbanCard(normalizeCardInput(values))
      setCards((current) => sortCards([...current, created]))
      closeModal()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '카드를 생성하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(cardId: number, values: KanbanCardInput) {
    try {
      setSubmitting(true)
      setError('')
      const updated = await api.updateKanbanCard(cardId, normalizeCardInput(values))
      setCards((current) => sortCards(current.map((card) => (card.id === cardId ? updated : card))))
      if (selectedCardId === cardId) {
        setDetailDraft(toCardInput(updated))
      }
      closeModal()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '카드를 수정하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(cardId: number) {
    if (!window.confirm('이 카드를 삭제할까요?')) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      await api.deleteKanbanCard(cardId)
      setCards((current) => sortCards(current.filter((card) => card.id !== cardId)))
      if (selectedCardId === cardId) {
        closeDetail()
      }
      closeModal()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '카드를 삭제하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDetailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedCard || !detailDraft) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      const updated = await api.updateKanbanCard(selectedCard.id, normalizeCardInput(detailDraft))
      setCards((current) => sortCards(current.map((card) => (card.id === selectedCard.id ? updated : card))))
      setDetailDraft(toCardInput(updated))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '카드 상세를 저장하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReorder(draggedCardId: number, targetColumn: KanbanColumnKey, targetIndex: number) {
    const previousCards = cards
    const nextCards = reorderCards(previousCards, draggedCardId, targetColumn, targetIndex)
    if (!nextCards) {
      return
    }

    setDragCardId(null)
    setCards(nextCards)
    setError('')

    try {
      const response = await api.reorderKanbanCards(
        nextCards.map((card) => ({
          id: card.id,
          column_key: card.column_key,
          sort_order: card.sort_order,
        })),
      )
      setCards(sortCards(response))
    } catch (reorderError) {
      setCards(previousCards)
      setError(reorderError instanceof Error ? reorderError.message : '카드 순서를 저장하지 못했습니다.')
    }
  }

  function updateDetailDraft(changes: Partial<KanbanCardInput>) {
    setDetailDraft((current) => (current ? { ...current, ...changes } : current))
  }

  function addChecklistItem() {
    setDetailDraft((current) =>
      current
        ? {
            ...current,
            checklist_items: [
              ...(current.checklist_items ?? []),
              {
                id: checklistDraftIdRef.current--,
                title: '',
                is_completed: false,
              },
            ],
          }
        : current,
    )
  }

  function updateChecklistItem(index: number, changes: Partial<NonNullable<KanbanCardInput['checklist_items']>[number]>) {
    setDetailDraft((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        checklist_items: (current.checklist_items ?? []).map((item, itemIndex) =>
          itemIndex === index ? { ...item, ...changes } : item,
        ),
      }
    })
  }

  function removeChecklistItem(index: number) {
    setDetailDraft((current) =>
      current
        ? {
            ...current,
            checklist_items: (current.checklist_items ?? []).filter((_, itemIndex) => itemIndex !== index),
          }
        : current,
    )
  }

  function reorderChecklistItems(sourceIndex: number, targetIndex: number) {
    if (sourceIndex === targetIndex) {
      return
    }

    setDetailDraft((current) => {
      if (!current) {
        return current
      }

      const items = [...(current.checklist_items ?? [])]
      if (
        sourceIndex < 0 ||
        sourceIndex >= items.length ||
        targetIndex < 0 ||
        targetIndex >= items.length
      ) {
        return current
      }

      const [moved] = items.splice(sourceIndex, 1)
      items.splice(targetIndex, 0, moved)

      return {
        ...current,
        checklist_items: items.map((item, index) => ({
          ...item,
          sort_order: index + 1,
        })),
      }
    })
  }

  function handleChecklistDragStart(index: number) {
    setDragChecklistIndex(index)
  }

  function handleChecklistDrop(event: DragEvent<HTMLDivElement>, targetIndex: number) {
    event.preventDefault()
    event.stopPropagation()
    if (dragChecklistIndex === null) {
      return
    }

    reorderChecklistItems(dragChecklistIndex, targetIndex)
    setDragChecklistIndex(null)
  }

  function addExistingTarget(device: DeviceSummary) {
    setDetailDraft((current) => {
      if (!current) {
        return current
      }
      if ((current.targets ?? []).some((item) => item.cvp_device_id === device.device_id)) {
        return current
      }

      const nextTargets = [
        ...(current.targets ?? []),
        {
          id: targetDraftIdRef.current--,
          target_kind: 'existing' as const,
          display_name: device.hostname,
          mgmt_ip: device.mgmt_ip,
          model: device.model,
          role_hint: device.site ?? '',
          cvp_device_id: device.device_id,
          match_status: 'linked_to_cvp' as const,
        },
      ]

      return {
        ...current,
        targets: nextTargets,
      }
    })
  }

  function addNewTarget() {
    setDetailDraft((current) =>
      current
        ? {
            ...current,
            targets: [
              ...(current.targets ?? []),
              {
                id: targetDraftIdRef.current--,
                target_kind: 'new',
                display_name: '',
                mgmt_ip: '',
                model: '',
                role_hint: '',
                cvp_device_id: '',
                match_status: 'manual_only',
              },
            ],
          }
        : current,
    )
  }

  function updateTargetItem(index: number, changes: Partial<KanbanTargetItem>) {
    setDetailDraft((current) => {
      if (!current) {
        return current
      }

      const nextTargets = (current.targets ?? []).map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...changes } : item,
      )

      return {
        ...current,
        targets: nextTargets,
      }
    })
  }

  function removeTargetItem(index: number) {
    setDetailDraft((current) => {
      if (!current) {
        return current
      }
      const target = (current.targets ?? [])[index]
      const nextTargets = (current.targets ?? []).filter((_, itemIndex) => itemIndex !== index)
      const nextConfigs = (current.planned_configs ?? []).filter((item) => item.target_id !== Number(target?.id))

      return {
        ...current,
        targets: nextTargets,
        planned_configs: nextConfigs,
      }
    })
  }

  const boardContent = (
    <div className="kanban-board-scroll">
      <div className="kanban-board-grid">
        {COLUMN_META.map((columnMeta) => {
          const cardsInColumn = groupedCards[columnMeta.key]
          return (
            <section key={columnMeta.key} className="kanban-column">
              <div className="kanban-column-head">
                <div className="kanban-column-head-inner">
                  <span className={`kanban-pill ${columnMeta.tone}`}>{columnMeta.label}</span>
                  <small>{cardsInColumn.length}개 카드</small>
                </div>
              </div>

              <div
                className="kanban-card-list"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (dragCardId === null) {
                    return
                  }
                  void handleReorder(dragCardId, columnMeta.key, cardsInColumn.length)
                }}
              >
                {cardsInColumn.length === 0 ? (
                  <div className="kanban-empty-state">
                    <strong>카드가 없습니다.</strong>
                    <p>새 카드를 만들거나 다른 컬럼에서 드래그해 보세요.</p>
                  </div>
                ) : (
                  cardsInColumn.map((card, index) => (
                    <article
                      key={card.id}
                      className={`kanban-card ${dragCardId === card.id ? 'dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragCardId(card.id)}
                      onDragEnd={() => setDragCardId(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (dragCardId === null) {
                          return
                        }
                        void handleReorder(dragCardId, columnMeta.key, index)
                      }}
                      onDoubleClick={() => openEditModal(card)}
                    >
                      <div className="kanban-card-top">
                        <div>
                          <span className="kanban-card-code">{card.card_code}</span>
                          <h4>{card.title}</h4>
                        </div>
                        <div className={`kanban-priority-dot ${card.priority}`} />
                      </div>

                      <div className="kanban-card-badges">
                        <span className={`kanban-type-badge ${card.card_type}`}>
                          {card.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}
                        </span>
                      </div>

                      <p className="kanban-card-description">{card.description || '작업 설명이 아직 없습니다.'}</p>

                      <div className="kanban-card-meta">
                        <span>{priorityLabel(card.priority)}</span>
                        <span>{formatDateTime(card.updated_at)}</span>
                      </div>

                      <div className="kanban-card-progress" aria-hidden="true">
                        <span style={{ width: `${card.progress_percent}%` }} />
                      </div>

                      <div className="kanban-card-foot">
                        <span className="kanban-grip">
                          <GripVertical size={14} />
                          드래그 이동
                        </span>
                        <button className="kanban-link-button" type="button" onClick={() => openDetail(card)}>
                          자세히 보기
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )

  return (
    <section className="kanban-shell">
      <div className="kanban-toolbar">
        <div>
          <p className="kanban-kicker">Kanban Board</p>
          <h3>작업 칸반 보드</h3>
          <p className="kanban-copy">
            보드에서는 카드 요약만 빠르게 보고, 자세히 보기에서는 기본 정보와 작업 대상, 체크리스트만 관리합니다.
            작업 계획 성격의 단계는 별도 작업 계획 화면에서 이어집니다.
          </p>
        </div>
        <div className="kanban-inline-actions">
          <button className="kanban-ghost-button" type="button" onClick={() => void loadCards()} disabled={loading || submitting}>
            <RefreshCcw size={16} />
            <span>다시 불러오기</span>
          </button>
          <button className="kanban-primary-button" type="button" onClick={openCreateModal}>
            <Plus size={16} />
            <span>카드 생성</span>
          </button>
        </div>
      </div>

      {error ? <div className="kanban-message error">{error}</div> : null}
      {loading ? <div className="kanban-loading">칸반 카드 목록을 불러오는 중입니다.</div> : null}

      {!loading && !selectedCard ? boardContent : null}

      {!loading && selectedCard && detailDraft ? (
        <section className="kanban-detail-shell">
          <div className="kanban-detail-layout">
            <aside className="kanban-detail-sidebar">
              <article className="kanban-detail-summary-card">
                <div className="kanban-detail-back-row">
                  <button className="kanban-ghost-button" type="button" onClick={closeDetail}>
                    <ArrowLeft size={16} />
                    <span>보드로 돌아가기</span>
                  </button>
                </div>
                <div className="kanban-summary-head">
                  <div className="kanban-summary-title">
                    <p className="kanban-kicker">Selected Card</p>
                    <h3>{detailDraft.title}</h3>
                    <small className="kanban-summary-ticket">{selectedCard.card_code}</small>
                  </div>
                  <button className="kanban-link-button" type="button" onClick={() => openEditModal(selectedCard)}>
                    빠른 수정
                  </button>
                </div>
                <div className="kanban-summary-row">
                  <span>담당자</span>
                  <strong>{detailDraft.assignee.trim() || '미지정'}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>현재 상태</span>
                  <strong>{columnLabel(detailDraft.column_key)}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>작업 유형</span>
                  <strong>{detailDraft.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>작업 대상</span>
                  <strong>{detailDraft.targets?.length ?? 0}대</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>우선순위</span>
                  <strong>{priorityLabel(detailDraft.priority)}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>수정 시각</span>
                  <strong>{formatDateTime(selectedCard.updated_at)}</strong>
                </div>
                <div className="kanban-progress-card">
                  <div className="kanban-progress-head">
                    <span>진행률</span>
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
                <p className="kanban-kicker">작업 단계</p>
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
                  <form className="kanban-form" onSubmit={handleDetailSubmit}>
                    <label className="kanban-field wide">
                      <span>작업 제목</span>
                      <input
                        value={detailDraft.title}
                        onChange={(event) => updateDetailDraft({ title: event.target.value })}
                        required
                      />
                    </label>

                    <div className="kanban-field-grid">
                      <label className="kanban-field">
                        <span>담당자</span>
                        <input
                          value={detailDraft.assignee}
                          onChange={(event) => updateDetailDraft({ assignee: event.target.value })}
                          placeholder="예: 김철수"
                        />
                      </label>

                      <label className="kanban-field">
                        <span>상태</span>
                        <select
                          value={detailDraft.column_key}
                          onChange={(event) => updateDetailDraft({ column_key: event.target.value as KanbanColumnKey })}
                        >
                          {COLUMN_META.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="kanban-field">
                        <span>작업 유형</span>
                        <select
                          value={detailDraft.card_type}
                          onChange={(event) =>
                            updateDetailDraft({ card_type: event.target.value as KanbanCardInput['card_type'] })
                          }
                        >
                          <option value="existing">기존 장비 작업</option>
                          <option value="new">신규 장비 작업</option>
                        </select>
                      </label>

                      <label className="kanban-field">
                        <span>우선순위</span>
                        <select
                          value={detailDraft.priority}
                          onChange={(event) => updateDetailDraft({ priority: event.target.value as KanbanCardInput['priority'] })}
                        >
                          <option value="high">높음</option>
                          <option value="medium">중간</option>
                          <option value="low">낮음</option>
                        </select>
                      </label>
                    </div>

                    <label className="kanban-field wide">
                      <span>작업 설명</span>
                      <AutoGrowTextarea
                        value={detailDraft.description}
                        rows={8}
                        onChange={(event) => updateDetailDraft({ description: event.target.value })}
                      />
                    </label>

                    <div className="kanban-detail-actions end">
                      <button className="kanban-primary-button" type="submit" disabled={submitting || !detailDraft.title.trim()}>
                        {submitting ? '저장 중...' : '기본 정보 저장'}
                      </button>
                    </div>
                  </form>
                ) : null}

                {activeDetailStep === 'target' ? (
                  <form className="kanban-form" onSubmit={handleDetailSubmit}>
                    <section className="kanban-target-panel">
                      <div className="kanban-target-head">
                        <div>
                          <p className="kanban-kicker">Target Inventory</p>
                          <h4>{detailDraft.card_type === 'new' ? '신규 대상 장비 등록' : '기존 장비 선택'}</h4>
                        </div>
                        <div className="kanban-inline-actions left">
                          {detailDraft.card_type === 'existing' ? (
                            <button className="kanban-ghost-button" type="button" onClick={() => void loadDevices()} disabled={deviceLoading}>
                              <RefreshCcw size={16} />
                              <span>{deviceLoading ? '불러오는 중...' : '인벤토리 갱신'}</span>
                            </button>
                          ) : (
                            <button className="kanban-primary-button" type="button" onClick={addNewTarget}>
                              <Plus size={16} />
                              <span>신규 대상 추가</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {detailDraft.card_type === 'existing' ? (
                        <div className="kanban-target-selector">
                          <label className="kanban-target-search">
                            <Search size={16} />
                            <input
                              value={targetSearch}
                              onChange={(event) => setTargetSearch(event.target.value)}
                              placeholder="Hostname, Mgmt IP, Model, Serial 검색"
                            />
                          </label>
                          <div className="kanban-target-candidate-list">
                            {inventoryCandidates.length > 0 ? (
                              inventoryCandidates.map((device) => (
                                <button
                                  key={device.device_id}
                                  className="kanban-target-candidate"
                                  type="button"
                                  onClick={() => addExistingTarget(device)}
                                >
                                  <div>
                                    <strong>{device.hostname}</strong>
                                    <p>{device.mgmt_ip || 'Mgmt IP 없음'}</p>
                                  </div>
                                  <span>{device.model || 'Model 없음'}</span>
                                </button>
                              ))
                            ) : (
                              <div className="kanban-target-empty">
                                <strong>추가 가능한 장비가 없습니다.</strong>
                                <p>검색 조건을 바꾸거나 이미 선택된 장비를 확인해 주세요.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}

                      {detailDraft.card_type === 'new' ? (
                        targetRows.length > 0 ? (
                          <div className="kanban-target-form-list">
                            {targetRows.map((target, index) => (
                              <div key={target.id ?? `target-${index}`} className="kanban-target-form-card">
                                <div className="kanban-target-form-grid">
                                  <label className="kanban-field">
                                    <span>장비 이름 / Hostname</span>
                                    <input
                                      value={target.display_name}
                                      onChange={(event) => updateTargetItem(index, { display_name: event.target.value, target_kind: 'new' })}
                                      placeholder="예: LEAF-NEW-01"
                                    />
                                  </label>
                                  <label className="kanban-field">
                                    <span>Mgmt IP</span>
                                    <input
                                      value={target.mgmt_ip}
                                      onChange={(event) => updateTargetItem(index, { mgmt_ip: event.target.value, target_kind: 'new' })}
                                      placeholder="예: 10.10.10.11"
                                    />
                                  </label>
                                  <label className="kanban-field">
                                    <span>Model</span>
                                    <input
                                      value={target.model}
                                      onChange={(event) => updateTargetItem(index, { model: event.target.value, target_kind: 'new' })}
                                      placeholder="예: DCS-7280"
                                    />
                                  </label>
                                  <label className="kanban-field">
                                    <span>역할 / 메모</span>
                                    <input
                                      value={target.role_hint}
                                      onChange={(event) => updateTargetItem(index, { role_hint: event.target.value, target_kind: 'new' })}
                                      placeholder="예: Spine uplink"
                                    />
                                  </label>
                                </div>
                                <div className="kanban-target-card-actions">
                                  <button className="kanban-link-button danger" type="button" onClick={() => removeTargetItem(index)}>
                                    <Trash2 size={14} />
                                    <span>대상 삭제</span>
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="kanban-target-empty">
                            <strong>등록된 신규 대상 장비가 없습니다.</strong>
                            <p>신규 대상 추가 버튼으로 작업 계획의 기준 장비를 먼저 등록해 주세요.</p>
                          </div>
                        )
                      ) : null}

                      {targetRows.length > 0 ? (
                        <div className="kanban-target-table-shell">
                          <div className="kanban-target-table-head">
                            <strong>선택된 작업 대상</strong>
                            <span>{targetRows.length}대</span>
                          </div>
                          <div className="kanban-target-table">
                            <div className="kanban-target-table-row header">
                              <span>장비</span>
                              <span>Mgmt IP</span>
                              <span>Model</span>
                              <span>연결 상태</span>
                              <span>동작</span>
                            </div>
                            {targetRows.map((target, index) => (
                              <div key={target.id ?? `${target.display_name}-${index}`} className="kanban-target-table-row">
                                <span>{target.display_name || '-'}</span>
                                <span>{target.mgmt_ip || '-'}</span>
                                <span>{target.model || '-'}</span>
                                <span>{target.cvp_device_id ? 'CVP 연결됨' : '수기 등록'}</span>
                                <span>
                                  <button className="kanban-link-button danger" type="button" onClick={() => removeTargetItem(index)}>
                                    삭제
                                  </button>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </section>

                    <div className="kanban-detail-actions end">
                      <button className="kanban-primary-button" type="submit" disabled={submitting}>
                        {submitting ? '저장 중...' : '작업 대상 저장'}
                      </button>
                    </div>
                  </form>
                ) : null}

                {activeDetailStep === 'checklist' ? (
                  <form className="kanban-form" onSubmit={handleDetailSubmit}>
                    <section className="kanban-checklist-panel">
                      <div className="kanban-checklist-head">
                        <div>
                          <p className="kanban-kicker">Checklist</p>
                          <h4>작업 체크리스트</h4>
                        </div>
                        <button className="kanban-ghost-button" type="button" onClick={addChecklistItem}>
                          <Plus size={16} />
                          <span>항목 추가</span>
                        </button>
                      </div>

                      {detailDraft.checklist_items && detailDraft.checklist_items.length > 0 ? (
                        <div className="kanban-checklist-list">
                          {detailDraft.checklist_items.map((item, index) => (
                            <div
                              key={item.id ?? `draft-${index}`}
                              className={`kanban-checklist-item ${dragChecklistIndex === index ? 'dragging' : ''}`}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => handleChecklistDrop(event, index)}
                            >
                              <button
                                className="kanban-checklist-grip"
                                type="button"
                                draggable
                                onDragStart={() => handleChecklistDragStart(index)}
                                onDragEnd={() => setDragChecklistIndex(null)}
                                aria-label="체크리스트 항목 순서 이동"
                              >
                                <GripVertical size={16} />
                              </button>
                              <label className="kanban-checklist-toggle">
                                <input
                                  type="checkbox"
                                  checked={item.is_completed}
                                  onChange={(event) => updateChecklistItem(index, { is_completed: event.target.checked })}
                                />
                              </label>
                              <AutoGrowTextarea
                                className={`kanban-checklist-input ${item.is_completed ? 'completed' : ''}`}
                                value={item.title}
                                onChange={(event) => updateChecklistItem(index, { title: event.target.value })}
                                placeholder="예: 변경 전 snapshot 확인"
                                rows={1}
                                spellCheck={false}
                                autoCorrect="off"
                                autoCapitalize="off"
                              />
                              <button
                                className="kanban-link-button danger"
                                type="button"
                                onClick={() => removeChecklistItem(index)}
                                aria-label="체크리스트 항목 삭제"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="kanban-checklist-empty">
                          <strong>체크리스트가 아직 없습니다.</strong>
                          <p>항목을 추가하면 진행률이 자동 계산됩니다.</p>
                        </div>
                      )}
                    </section>

                    <div className="kanban-detail-actions end">
                      <button className="kanban-primary-button" type="submit" disabled={submitting}>
                        {submitting ? '저장 중...' : '체크리스트 저장'}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            </section>
          </div>
        </section>
      ) : null}

      {editorMode ? (
        <KanbanCardModal
          mode={editorMode}
          card={editorCard}
          initialValues={editorCard ? toCardInput(editorCard) : EMPTY_CARD_INPUT}
          submitting={submitting}
          onClose={closeModal}
          onSubmit={(values) => {
            if (editorMode === 'create') {
              return handleCreate(values)
            }
            if (editorCard) {
              return handleUpdate(editorCard.id, values)
            }
            return undefined
          }}
          onDelete={editorCard ? () => handleDelete(editorCard.id) : undefined}
        />
      ) : null}
    </section>
  )
}

function sortCards(cards: KanbanCard[]) {
  const orderMap = new Map(COLUMN_META.map((item, index) => [item.key, index]))
  return [...cards].sort((left, right) => {
    const columnDiff = (orderMap.get(left.column_key) ?? 99) - (orderMap.get(right.column_key) ?? 99)
    if (columnDiff !== 0) {
      return columnDiff
    }
    if (left.sort_order !== right.sort_order) {
      return left.sort_order - right.sort_order
    }
    return left.id - right.id
  })
}

function reorderCards(cards: KanbanCard[], draggedCardId: number, targetColumn: KanbanColumnKey, targetIndex: number) {
  const dragged = cards.find((card) => card.id === draggedCardId)
  if (!dragged) {
    return null
  }

  const groups = Object.fromEntries(
    COLUMN_META.map((meta) => [
      meta.key,
      sortCards(cards.filter((card) => card.id !== draggedCardId && card.column_key === meta.key)),
    ]),
  ) as Record<KanbanColumnKey, KanbanCard[]>

  const nextDragged = { ...dragged, column_key: targetColumn }
  const targetCards = [...groups[targetColumn]]
  const safeIndex = Math.max(0, Math.min(targetIndex, targetCards.length))
  targetCards.splice(safeIndex, 0, nextDragged)
  groups[targetColumn] = targetCards

  return COLUMN_META.flatMap((meta) =>
    groups[meta.key].map((card, index) => ({
      ...card,
      column_key: meta.key,
      sort_order: index + 1,
    })),
  )
}

function toCardInput(card: KanbanCard): KanbanCardInput {
  return {
    title: card.title,
    description: card.description,
    assignee: card.assignee,
    column_key: card.column_key,
    card_type: card.card_type,
    priority: card.priority,
    checklist_items: card.checklist_items.map((item, index) => ({
      id: item.id ?? undefined,
      title: item.title,
      is_completed: item.is_completed,
      sort_order: item.sort_order ?? index + 1,
    })),
    targets: (card.targets ?? []).map((target, index) => ({
      ...target,
      id: target.id ?? undefined,
      sort_order: target.sort_order ?? index + 1,
    })),
    planned_configs: (card.planned_configs ?? []).map((item) => ({
      ...item,
      id: item.id ?? undefined,
    })),
  }
}

function priorityLabel(priority: KanbanCard['priority']) {
  if (priority === 'high') return '높음'
  if (priority === 'low') return '낮음'
  return '중간'
}

function columnLabel(columnKey: KanbanColumnKey) {
  return COLUMN_META.find((item) => item.key === columnKey)?.label ?? columnKey
}

function formatDateTime(value: string) {
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

function calculateProgress(items: KanbanCardInput['checklist_items']) {
  const normalizedItems = items ?? []
  const completed = normalizedItems.filter((item) => item.is_completed).length
  const total = normalizedItems.length
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  }
}

function normalizeCardInput(values: KanbanCardInput): KanbanCardInput {
  const normalizedChecklistItems = (values.checklist_items ?? [])
    .map((item) => ({
      ...item,
      title: item.title.trim(),
    }))
    .filter((item) => item.title)
    .map((item, index) => ({
      ...item,
      sort_order: index + 1,
    }))

  const normalizedTargets = (values.targets ?? [])
    .map((item) => normalizeTargetItem(item, values.card_type))
    .filter((item) => item.display_name || item.cvp_device_id)
    .map((item, index) => ({
      ...item,
      sort_order: index + 1,
    }))

  const validTargetIds = new Set(normalizedTargets.map((item) => Number(item.id)).filter((value) => Number.isFinite(value)))
  const normalizedPlannedConfigs = (values.planned_configs ?? [])
    .map((item) => ({
      ...item,
      config_text: item.config_text.replace(/\s+$/, ''),
    }))
    .filter((item) => validTargetIds.has(Number(item.target_id)) && item.config_text.trim().length > 0)

  return {
    ...values,
    title: values.title.trim(),
    description: values.description.trim(),
    assignee: values.assignee.trim(),
    checklist_items: normalizedChecklistItems,
    targets: normalizedTargets,
    planned_configs: normalizedPlannedConfigs as KanbanPlannedConfigItem[],
  }
}

function normalizeTargetItem(target: KanbanTargetItem, cardType: KanbanCardInput['card_type']): KanbanTargetItem {
  const targetKind: KanbanTargetKind = target.target_kind ?? (cardType === 'new' ? 'new' : 'existing')
  return {
    ...target,
    target_kind: targetKind,
    display_name: target.display_name.trim(),
    mgmt_ip: target.mgmt_ip.trim(),
    model: target.model.trim(),
    role_hint: target.role_hint.trim(),
    cvp_device_id: target.cvp_device_id.trim(),
  }
}
