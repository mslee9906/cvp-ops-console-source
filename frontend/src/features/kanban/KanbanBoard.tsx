import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, GripVertical, Plus, RefreshCcw, Search, Trash2 } from 'lucide-react'

import { api } from '../../api'
import type {
  DeviceSummary,
  KanbanCard,
  KanbanCardInput,
  KanbanColumnKey,
  KanbanPlannedConfigItem,
  KanbanTargetItem,
  KanbanTargetKind,
  UserSummary,
} from '../../types'
import { AutoGrowTextarea } from './AutoGrowTextarea'
import { KanbanCardModal } from './KanbanCardModal'
import './kanban.css'

type DetailStepKey = 'basic' | 'target' | 'manage'

const COLUMN_META: Array<{ key: KanbanColumnKey; label: string; tone: string }> = [
  { key: 'blocked', label: '보류', tone: 'rose' },
  { key: 'planned', label: '작업 예정', tone: 'blue' },
  { key: 'ready', label: '준비 완료', tone: 'teal' },
  { key: 'in_progress', label: '작업 중', tone: 'amber' },
  { key: 'verifying', label: '검증 중', tone: 'blue' },
  { key: 'incident', label: '장애', tone: 'rose' },
]

const DETAIL_STEP_META: Array<{ key: DetailStepKey; label: string; body: string }> = [
  { key: 'basic', label: '기본 정보', body: '카드 제목, 설명, 상태, 작업 유형 같은 기본 정보를 관리합니다.' },
  { key: 'target', label: '작업 대상', body: '기존 장비 연결이나 신규 장비 등록 등 실제 작업 대상을 관리합니다.' },
  { key: 'manage', label: '작업 카드 관리', body: '완료 처리와 카드 삭제를 각각 확인하고 관리합니다. 완료 메모는 완료 확인 오버레이에서 입력합니다.' },
]

const EMPTY_CARD_INPUT: KanbanCardInput = {
  title: '',
  description: '',
  due_at: '',
  assignee: '',
  assignee_user_id: null,
  column_key: 'planned',
  card_type: 'existing',
  priority: 'medium',
  checklist_items: [],
  targets: [],
  planned_configs: [],
}

type Props = {
  users: UserSummary[]
}

export function KanbanBoard({ users }: Props) {
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
  const [targetSearch, setTargetSearch] = useState('')
  const [existingBulkDraft, setExistingBulkDraft] = useState('')
  const [newTargetBulkDraft, setNewTargetBulkDraft] = useState('')
  const [existingBulkOpen, setExistingBulkOpen] = useState(false)
  const [newBulkOpen, setNewBulkOpen] = useState(false)
  const [editingNewTargetIndex, setEditingNewTargetIndex] = useState<number | null>(null)
  const [newTargetDraft, setNewTargetDraft] = useState<KanbanTargetItem>(() => createEmptyTarget('new'))
  const [actionOverlayMessage, setActionOverlayMessage] = useState('')
  const [completeDialogCard, setCompleteDialogCard] = useState<KanbanCard | null>(null)
  const [deleteDialogCard, setDeleteDialogCard] = useState<KanbanCard | null>(null)
  const [completeNote, setCompleteNote] = useState('')
  const targetDraftIdRef = useRef(-1)

  const deferredTargetSearch = useDeferredValue(targetSearch)

  const selectedCard = useMemo(
    () => cards.find((item) => item.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )
  const detailProgress = useMemo(
    () => ({
      percent: selectedCard?.progress_percent ?? 0,
      completed: selectedCard?.checklist_completed ?? 0,
      total: selectedCard?.checklist_total ?? 0,
    }),
    [selectedCard?.checklist_completed, selectedCard?.checklist_total, selectedCard?.progress_percent],
  )
  const activeStepMeta = useMemo(
    () => DETAIL_STEP_META.find((step) => step.key === activeDetailStep) ?? DETAIL_STEP_META[0],
    [activeDetailStep],
  )

  const groupedCards = useMemo(() => {
    return Object.fromEntries(
      COLUMN_META.map((meta) => [meta.key, sortCards(cards.filter((card) => card.column_key === meta.key))]),
    ) as Record<string, KanbanCard[]>
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
      setCompleteNote('')
      setEditingNewTargetIndex(null)
      setNewTargetDraft(createEmptyTarget(selectedCard.card_type === 'new' ? 'new' : 'existing'))
      setExistingBulkDraft('')
      setNewTargetBulkDraft('')
      setExistingBulkOpen(false)
      setNewBulkOpen(false)
    }
  }, [selectedCard])

  useEffect(() => {
    if (detailDraft?.card_type !== 'new') {
      setEditingNewTargetIndex(null)
      setNewTargetDraft(createEmptyTarget('new'))
    }
  }, [detailDraft?.card_type])

  useEffect(() => {
    if (!actionOverlayMessage) {
      return
    }
    const timer = window.setTimeout(() => setActionOverlayMessage(''), 1100)
    return () => window.clearTimeout(timer)
  }, [actionOverlayMessage])

  async function bootstrap() {
    try {
      setLoading(true)
      setError('')
      const [cardResponse, deviceResponse] = await Promise.all([api.getKanbanCards(), api.getDevices()])
      setCards(sortCards(cardResponse))
      setDevices(deviceResponse)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 보드 데이터를 불러오지 못했습니다.')
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
      setError(loadError instanceof Error ? loadError.message : '작업 카드 목록을 불러오지 못했습니다.')
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
      setError(loadError instanceof Error ? loadError.message : '장비 목록을 불러오지 못했습니다.')
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

  function openCompleteDialog(card: KanbanCard) {
    setCompleteDialogCard(card)
    setCompleteNote('')
  }

  function closeCompleteDialog() {
    setCompleteDialogCard(null)
    setCompleteNote('')
  }

  function openDeleteDialog(card: KanbanCard) {
    setDeleteDialogCard(card)
  }

  function closeDeleteDialog() {
    setDeleteDialogCard(null)
  }

  function openDetail(card: KanbanCard) {
    setSelectedCardId(card.id)
    setDetailDraft(toCardInput(card))
    setActiveDetailStep('basic')
    setCompleteNote('')
    setTargetSearch('')
    setExistingBulkDraft('')
    setNewTargetBulkDraft('')
    setExistingBulkOpen(false)
    setNewBulkOpen(false)
    setEditingNewTargetIndex(null)
    setNewTargetDraft(createEmptyTarget(card.card_type))
  }

  function closeDetail() {
    setSelectedCardId(null)
    setDetailDraft(null)
    setActiveDetailStep('basic')
    setCompleteNote('')
    setTargetSearch('')
    setExistingBulkDraft('')
    setNewTargetBulkDraft('')
    setExistingBulkOpen(false)
    setNewBulkOpen(false)
    setEditingNewTargetIndex(null)
    setNewTargetDraft(createEmptyTarget('new'))
  }

  async function handleCreate(values: KanbanCardInput) {
    try {
      setSubmitting(true)
      setError('')
      const created = await api.createKanbanCard(normalizeCardInput(values))
      setCards((current) => sortCards([...current, created]))
      setActionOverlayMessage('작업 카드를 생성했습니다.')
      closeModal()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '작업 카드를 생성하지 못했습니다.')
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
      setActionOverlayMessage('작업 카드를 저장했습니다.')
      closeModal()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '작업 카드를 저장하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteCard() {
    if (!deleteDialogCard) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      await api.deleteKanbanCard(deleteDialogCard.id)
      setCards((current) => sortCards(current.filter((card) => card.id !== deleteDialogCard.id)))
      if (selectedCardId === deleteDialogCard.id) {
        closeDetail()
      }
      if (editorCard?.id === deleteDialogCard.id) {
        closeModal()
      }
      if (completeDialogCard?.id === deleteDialogCard.id) {
        closeCompleteDialog()
      }
      setActionOverlayMessage('작업 카드를 삭제했습니다.')
      closeDeleteDialog()
      closeModal()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '작업 카드를 삭제하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClearIncidentColumn() {
    const incidentCards = groupedCards.incident ?? []
    if (incidentCards.length === 0) {
      return
    }
    const confirmed = window.confirm(`장애 칼럼의 카드 ${incidentCards.length}개를 모두 삭제하시겠습니까?`)
    if (!confirmed) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      await api.clearKanbanColumnCards('incident')
      await loadCards()
      setActionOverlayMessage('장애 칼럼 카드를 모두 삭제했습니다.')
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : '장애 칼럼 카드를 삭제하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCompleteCard() {
    if (!completeDialogCard) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      await api.completeKanbanCard(completeDialogCard.id, completeNote.trim())
      setCards((current) => sortCards(current.filter((card) => card.id !== completeDialogCard.id)))
      if (selectedCardId === completeDialogCard.id) {
        closeDetail()
      }
      if (editorCard?.id === completeDialogCard.id) {
        closeModal()
      }
      setActionOverlayMessage('작업을 이력으로 이동했습니다.')
      closeCompleteDialog()
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : '작업 완료 처리에 실패했습니다.')
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
      setActionOverlayMessage(detailStepSuccessMessage(activeDetailStep))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '작업 정보를 저장하지 못했습니다.')
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
      setError(reorderError instanceof Error ? reorderError.message : '작업 카드 순서를 변경하지 못했습니다.')
    }
  }

  function updateDetailDraft(changes: Partial<KanbanCardInput>) {
    setDetailDraft((current) => (current ? { ...current, ...changes } : current))
  }

  function handleAssigneeChange(rawUserId: string) {
    const nextUserId = rawUserId ? Number(rawUserId) : null
    const selectedUser = users.find((user) => user.id === nextUserId) ?? null
    updateDetailDraft({
      assignee_user_id: nextUserId,
      assignee: selectedUser?.display_name ?? '',
    })
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

  function resetNewTargetEditor() {
    setEditingNewTargetIndex(null)
    setNewTargetDraft(createEmptyTarget('new'))
  }

  function startEditNewTarget(index: number) {
    const target = targetRows[index]
    if (!target) {
      return
    }
    setEditingNewTargetIndex(index)
    setNewTargetDraft({
      ...createEmptyTarget('new'),
      ...target,
      target_kind: 'new',
      match_status: target.match_status || 'manual_only',
    })
  }

  function saveNewTargetDraft() {
    const normalized = normalizeTargetItem(
      {
        ...newTargetDraft,
        id: editingNewTargetIndex === null ? targetDraftIdRef.current-- : newTargetDraft.id,
        target_kind: 'new',
        match_status: 'manual_only',
        cvp_device_id: '',
      },
      'new',
    )
    if (!normalized.display_name) {
      setError('??ル맪???縕???Hostname ???裕??縕?????藥?????놁졑??怨룻뒍 ??紐껊퉵??')
      return
    }

    setError('')
    if (editingNewTargetIndex === null) {
      setDetailDraft((current) =>
        current
          ? {
              ...current,
              targets: [...(current.targets ?? []), normalized],
            }
          : current,
      )
    } else {
      updateTargetItem(editingNewTargetIndex, normalized)
    }
    resetNewTargetEditor()
  }

  function addExistingTargetsFromBulk() {
    const tokens = parseBulkLines(existingBulkDraft)
    if (!tokens.length) {
      return
    }

    const selectedIds = new Set(targetRows.map((item) => item.cvp_device_id).filter(Boolean))
    const matchedDevices: DeviceSummary[] = []
    const missedTokens: string[] = []

    tokens.forEach((token) => {
      const lookup = token.toLowerCase()
      const device = devices.find((candidate) => {
        const hostname = candidate.hostname.trim().toLowerCase()
        const mgmtIp = candidate.mgmt_ip.trim().toLowerCase()
        const deviceId = candidate.device_id.trim().toLowerCase()
        return hostname === lookup || mgmtIp === lookup || deviceId === lookup
      })
      if (!device) {
        missedTokens.push(token)
        return
      }
      if (!selectedIds.has(device.device_id)) {
        selectedIds.add(device.device_id)
        matchedDevices.push(device)
      }
    })

    if (matchedDevices.length) {
      matchedDevices.forEach((device) => addExistingTarget(device))
      setExistingBulkDraft('')
    }

    if (missedTokens.length) {
      setError(`?筌뤾퍒萸??ル벣遊?????嶺뚢돦堉? 嶺뚮쪇沅?뇡??縕?? ${missedTokens.join(', ')}`)
    } else {
      setError('')
    }
  }

  function addNewTargetsFromBulk() {
    const parsedTargets = parseNewTargetBulk(newTargetBulkDraft)
    if (!parsedTargets.length) {
      return
    }

    setDetailDraft((current) =>
      current
        ? {
            ...current,
            targets: [
              ...(current.targets ?? []),
              ...parsedTargets.map((target) => ({
                ...target,
                id: targetDraftIdRef.current--,
              })),
            ],
          }
        : current,
    )
    setNewTargetBulkDraft('')
    setError('')
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
    if (editingNewTargetIndex === index) {
      resetNewTargetEditor()
    } else if (editingNewTargetIndex !== null && editingNewTargetIndex > index) {
      setEditingNewTargetIndex((current) => (current === null ? null : current - 1))
    }
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
                  <div className="kanban-column-head-actions">
                    <small>{cardsInColumn.length}개 카드</small>
                    {columnMeta.key === 'incident' && cardsInColumn.length > 0 ? (
                      <button
                        className="kanban-danger-button compact"
                        type="button"
                        onClick={() => void handleClearIncidentColumn()}
                        disabled={loading || submitting}
                      >
                        <Trash2 size={14} />
                        <span>전체 삭제</span>
                      </button>
                    ) : null}
                  </div>
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
                    <strong>아직 카드가 없습니다.</strong>
                    <p>새 작업을 등록하거나 다른 상태로 카드를 이동해 보세요.</p>
                  </div>
                ) : (
                  cardsInColumn.map((card, index) => (
                    <article
                      key={card.id}
                      className={`kanban-card priority-${card.priority} ${dragCardId === card.id ? 'dragging' : ''} ${isCardOverdue(card) ? 'is-overdue' : ''}`}
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
                        <div className="kanban-card-title-block">
                          <span className="kanban-card-code">{card.card_code}</span>
                          <h4>{card.title}</h4>
                        </div>
                        <span className={`kanban-type-badge ${card.card_type}`}>
                          {card.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}
                        </span>
                      </div>

                      <p className="kanban-card-description">{card.description || '작업 설명이 아직 없습니다.'}</p>
                      <div className="kanban-card-ownership">
                        <span>생성자 {card.created_by_name || '미지정'}</span>
                        <span>담당자 {card.assignee || '미지정'}</span>
                      </div>
                      <div className="kanban-card-meta">
                        <span>{card.due_at ? `완료 예정 ${formatDueDateTime(card.due_at)}` : '완료 예정 미지정'}</span>
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
          <h3>작업 보드</h3>
          <p className="kanban-copy">
            작업 카드의 생성, 배치, 우선순위, 담당자와 현재 진행률을 한 화면에서 관리합니다.
            자세히 보기에서는 기본 정보와 작업 대상만 수정할 수 있으며, 진행률은 워크플로우 전체 진행도와 연동됩니다.
          </p>
        </div>
        <div className="kanban-inline-actions">
          <button className="kanban-ghost-button" type="button" onClick={() => void loadCards()} disabled={loading || submitting}>
            <RefreshCcw size={16} />
            <span>카드 새로고침</span>
          </button>
          <button className="kanban-primary-button" type="button" onClick={openCreateModal}>
            <Plus size={16} />
            <span>작업 추가</span>
          </button>
        </div>
      </div>

      {error ? <div className="kanban-message error">{error}</div> : null}
      {loading ? <div className="kanban-loading">작업 카드 목록을 불러오는 중입니다.</div> : null}

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
                    카드 수정
                  </button>
                </div>
                <div className="kanban-summary-row">
                  <span>담당자</span>
                  <strong>{detailDraft.assignee.trim() || '미지정'}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>생성자</span>
                  <strong>{selectedCard.created_by_name || '미지정'}</strong>
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
                  <span>완료 예정</span>
                  <strong>{detailDraft.due_at ? formatDueDateTime(detailDraft.due_at) : '미지정'}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>마지막 갱신</span>
                  <strong>{formatDateTime(selectedCard.updated_at)}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>최종 수정자</span>
                  <strong>{selectedCard.updated_by_name || '미지정'}</strong>
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
                        <select value={detailDraft.assignee_user_id ?? ''} onChange={(event) => handleAssigneeChange(event.target.value)}>
                          <option value="">미지정</option>
                          {users.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.display_name} ({user.username})
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="kanban-field">
                        <span>현재 상태</span>
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

                      <label className="kanban-field">
                        <span>완료 예정 일시</span>
                        <input
                          type="datetime-local"
                          value={detailDraft.due_at}
                          onChange={(event) => updateDetailDraft({ due_at: event.target.value })}
                        />
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
                          <h4>작업 대상 구성</h4>
                          <p className="kanban-target-helper">
                            {detailDraft.card_type === 'new'
                              ? '신규 장비 작업에도 기존 CVP 장비와 신규 등록 장비를 함께 추가할 수 있습니다.'
                              : '기존 CVP 장비를 검색해 작업 대상으로 추가하고 관리합니다.'}
                          </p>
                        </div>
                        <div className="kanban-inline-actions left">
                          <button className="kanban-ghost-button compact" type="button" onClick={() => void loadDevices()} disabled={deviceLoading}>
                            <RefreshCcw size={15} />
                            <span>{deviceLoading ? '장비 목록 불러오는 중...' : '장비 목록 새로고침'}</span>
                          </button>
                          {detailDraft.card_type === 'new' ? (
                            <button className="kanban-ghost-button" type="button" onClick={resetNewTargetEditor}>
                              입력 초기화
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="kanban-target-section">
                        <div className="kanban-target-section-head">
                          <div>
                            <strong>기존 장비 선택</strong>
                            <p>Hostname, Mgmt IP, Model, Serial 기준으로 검색해 현재 작업 대상에 추가합니다.</p>
                          </div>
                        </div>
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
                                <strong>선택 가능한 장비가 없습니다.</strong>
                                <p>검색 조건을 바꾸거나 snapshot 장비 목록을 다시 불러오세요.</p>
                              </div>
                            )}
                          </div>
                          <div className="kanban-target-form-card compact">
                            <div className="kanban-target-editor-head">
                              <div>
                                <strong>여러 장비 한 번에 추가</strong>
                                <p>`hostname` 또는 `mgmt ip`를 한 줄에 하나씩 입력하면 선택 가능한 장비를 한 번에 추가합니다.</p>
                              </div>
                              <button className="kanban-ghost-button compact" type="button" onClick={() => setExistingBulkOpen((current) => !current)}>
                                {existingBulkOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                <span>{existingBulkOpen ? '접기' : '열기'}</span>
                              </button>
                            </div>
                            {existingBulkOpen ? (
                              <>
                                <label className="kanban-field wide">
                                  <span>일괄 입력</span>
                                  <AutoGrowTextarea
                                    value={existingBulkDraft}
                                    rows={3}
                                    onChange={(event) => setExistingBulkDraft(event.target.value)}
                                    placeholder={'leaf01\\nleaf02\\n10.10.10.11'}
                                  />
                                </label>
                                <div className="kanban-target-card-actions">
                                  <p className="kanban-target-helper">입력한 hostname 또는 관리 IP와 일치하는 장비만 추가됩니다.</p>
                                  <button className="kanban-ghost-button compact" type="button" onClick={addExistingTargetsFromBulk}>
                                    <Plus size={15} />
                                    <span>일괄 추가</span>
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {detailDraft.card_type === 'new' ? (
                        <div className="kanban-target-form-list">
                          <div className="kanban-target-section">
                            <div className="kanban-target-section-head">
                              <div>
                                <strong>신규 장비 등록</strong>
                                <p>아직 CVP에 없는 장비를 직접 등록합니다. 신규 장비 행만 이후 수정할 수 있습니다.</p>
                              </div>
                            </div>
                          <div className="kanban-target-form-card">
                            <div className="kanban-target-editor-head">
                              <div>
                                <strong>{editingNewTargetIndex === null ? '신규 장비 추가' : '신규 장비 수정'}</strong>
                                <p>Hostname, 관리 IP, 모델, 역할 힌트를 입력해 작업 대상에 직접 등록합니다.</p>
                              </div>
                              <div className="kanban-inline-actions left">
                                <button className="kanban-ghost-button" type="button" onClick={resetNewTargetEditor}>
                                  입력 초기화
                                </button>
                                <button className="kanban-primary-button" type="button" onClick={saveNewTargetDraft}>
                                  <Plus size={16} />
                                  <span>{editingNewTargetIndex === null ? '장비 추가' : '수정 완료'}</span>
                                </button>
                              </div>
                            </div>
                            <div className="kanban-target-form-grid">
                              <label className="kanban-field">
                                <span>장비명 / Hostname</span>
                                <input
                                  value={newTargetDraft.display_name}
                                  onChange={(event) =>
                                    setNewTargetDraft((current) => ({ ...current, display_name: event.target.value, target_kind: 'new' }))
                                  }
                                  placeholder="예: LEAF-NEW-01"
                                />
                              </label>
                              <label className="kanban-field">
                                <span>Mgmt IP</span>
                                <input
                                  value={newTargetDraft.mgmt_ip}
                                  onChange={(event) =>
                                    setNewTargetDraft((current) => ({ ...current, mgmt_ip: event.target.value, target_kind: 'new' }))
                                  }
                                  placeholder="예: 10.10.10.11"
                                />
                              </label>
                              <label className="kanban-field">
                                <span>Model</span>
                                <input
                                  value={newTargetDraft.model}
                                  onChange={(event) =>
                                    setNewTargetDraft((current) => ({ ...current, model: event.target.value, target_kind: 'new' }))
                                  }
                                  placeholder="?? DCS-7280"
                                />
                              </label>
                              <label className="kanban-field">
                                <span>역할 / 역할 힌트</span>
                                <input
                                  value={newTargetDraft.role_hint}
                                  onChange={(event) =>
                                    setNewTargetDraft((current) => ({ ...current, role_hint: event.target.value, target_kind: 'new' }))
                                  }
                                  placeholder="예: Spine uplink"
                                />
                              </label>
                            </div>
                            <div className="kanban-target-form-card compact nested">
                              <div className="kanban-target-editor-head">
                                <div>
                                  <strong>신규 장비 여러 대 한 번에 추가</strong>
                                  <p>`hostname, mgmt ip, model, 역할 힌트` 순서로 한 줄에 한 대씩 입력합니다.</p>
                                </div>
                                <button className="kanban-ghost-button compact" type="button" onClick={() => setNewBulkOpen((current) => !current)}>
                                  {newBulkOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                  <span>{newBulkOpen ? '접기' : '열기'}</span>
                                </button>
                              </div>
                              {newBulkOpen ? (
                                <>
                                  <label className="kanban-field wide">
                                    <span>신규 장비 일괄 입력</span>
                                    <AutoGrowTextarea
                                      value={newTargetBulkDraft}
                                      rows={3}
                                      onChange={(event) => setNewTargetBulkDraft(event.target.value)}
                                      placeholder={'LEAF-NEW-01,10.10.10.11,DCS-7280,Spine uplink\\nLEAF-NEW-02,10.10.10.12'}
                                    />
                                  </label>
                                  <div className="kanban-target-card-actions">
                                    <p className="kanban-target-helper">Hostname은 필수이며, 나머지는 비워 둘 수 있습니다.</p>
                                    <button className="kanban-ghost-button compact" type="button" onClick={addNewTargetsFromBulk}>
                                      <Plus size={15} />
                                      <span>일괄 등록</span>
                                    </button>
                                  </div>
                                </>
                              ) : null}
                            </div>
                          </div>
                          </div>
                          {targetRows.filter((target) => target.target_kind === 'new').length === 0 ? (
                            <div className="kanban-target-empty">
                              <strong>등록된 신규 장비가 없습니다.</strong>
                              <p>위 입력 영역에서 한 대씩 추가하거나 여러 줄 입력으로 한 번에 등록하세요.</p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {targetRows.length > 0 ? (
                        <div className="kanban-target-table-shell">
                          <div className="kanban-target-table-head">
                            <strong>현재 등록된 작업 대상</strong>
                            <span>{targetRows.length}대</span>
                          </div>
                          <div className="kanban-target-table">
                            <div className="kanban-target-table-row header">
                              <span>장비명</span>
                              <span>Mgmt IP</span>
                              <span>Model</span>
                              <span>연결 상태</span>
                              <span>관리</span>
                            </div>
                            {targetRows.map((target, index) => (
                              <div
                                key={target.id ?? `${target.display_name}-${index}`}
                                className={`kanban-target-table-row ${target.target_kind === 'new' && editingNewTargetIndex === index ? 'active' : ''} ${target.target_kind === 'new' ? 'editable' : ''}`}
                                onClick={target.target_kind === 'new' ? () => startEditNewTarget(index) : undefined}
                              >
                                <span>{target.display_name || '-'}</span>
                                <span>{target.mgmt_ip || '-'}</span>
                                <span>{target.model || '-'}</span>
                                <span>{target.cvp_device_id ? 'CVP 연결됨' : target.target_kind === 'new' ? '신규 수기 등록' : '수기 등록 대상'}</span>
                                <span>
                                  {target.target_kind === 'new' ? (
                                    <button
                                      className="kanban-link-button"
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        startEditNewTarget(index)
                                      }}
                                    >
                                      수정
                                    </button>
                                  ) : null}
                                  <button
                                    className="kanban-link-button danger"
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      removeTargetItem(index)
                                    }}
                                  >
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

                {activeDetailStep === 'manage' ? (
                  <section className="kanban-form">
                    <div className="kanban-note-card">
                      <strong>작업 완료</strong>
                      <p>완료 처리된 카드는 작업 보드에서 제거되고 작업 이력 탭으로 이동합니다. 완료 메모는 완료 확인 오버레이에서만 입력합니다.</p>
                    </div>

                    <div className="kanban-note-card">
                      <strong>카드 삭제</strong>
                      <p>카드 삭제는 작업 이력으로 이동하지 않고, 현재 작업 보드에서 완전히 제거됩니다.</p>
                    </div>

                    <div className="kanban-detail-actions">
                      <div className="kanban-inline-actions left">
                        <button className="kanban-danger-button" type="button" onClick={() => openDeleteDialog(selectedCard)} disabled={submitting}>
                          <span>카드 삭제</span>
                        </button>
                      </div>
                      <div className="kanban-inline-actions">
                        <button className="kanban-primary-button" type="button" onClick={() => openCompleteDialog(selectedCard)} disabled={submitting}>
                          <CheckCircle2 size={16} />
                          <span>작업 완료</span>
                        </button>
                      </div>
                    </div>
                  </section>
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
          users={users}
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
          onDelete={editorCard ? () => openDeleteDialog(editorCard) : undefined}
          onComplete={editorCard ? () => openCompleteDialog(editorCard) : undefined}
        />
      ) : null}

      {completeDialogCard ? (
        <div className="kanban-modal-backdrop" onClick={closeCompleteDialog}>
          <div className="kanban-modal kanban-complete-modal" onClick={(event) => event.stopPropagation()}>
            <div className="kanban-modal-head">
              <div>
                <p className="kanban-kicker">Complete Card</p>
                <h3>작업 완료 확인</h3>
              </div>
              <button className="kanban-ghost-button" type="button" onClick={closeCompleteDialog} disabled={submitting}>
                닫기
              </button>
            </div>

            <div className="kanban-complete-copy">
              <strong>{completeDialogCard.title}</strong>
              <p>정말 이 작업을 완료 처리하고 작업 이력으로 이동하시겠습니까?</p>
            </div>

            <label className="kanban-field wide">
              <span>완료 메모</span>
              <AutoGrowTextarea
                value={completeNote}
                onChange={(event) => setCompleteNote(event.target.value)}
                placeholder="작업 완료 결과나 전달 메모를 남길 수 있습니다."
                rows={5}
              />
            </label>

            <div className="kanban-modal-actions">
              <span />
              <div className="kanban-inline-actions">
                <button className="kanban-ghost-button" type="button" onClick={closeCompleteDialog} disabled={submitting}>
                  아니오
                </button>
                <button className="kanban-primary-button" type="button" onClick={() => void handleCompleteCard()} disabled={submitting}>
                  {submitting ? '완료 처리 중...' : '예, 완료합니다'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteDialogCard ? (
        <div className="kanban-modal-backdrop" onClick={closeDeleteDialog}>
          <div className="kanban-modal kanban-complete-modal" onClick={(event) => event.stopPropagation()}>
            <div className="kanban-modal-head">
              <div>
                <p className="kanban-kicker">Delete Card</p>
                <h3>카드 삭제 확인</h3>
              </div>
              <button className="kanban-ghost-button" type="button" onClick={closeDeleteDialog} disabled={submitting}>
                닫기
              </button>
            </div>

            <div className="kanban-complete-copy">
              <strong>{deleteDialogCard.title}</strong>
              <p>정말 이 작업 카드를 삭제하시겠습니까?</p>
              <p>삭제된 카드는 작업 이력으로 이동하지 않고 완전히 제거됩니다.</p>
            </div>

            <div className="kanban-modal-actions">
              <span />
              <div className="kanban-inline-actions">
                <button className="kanban-ghost-button" type="button" onClick={closeDeleteDialog} disabled={submitting}>
                  아니오
                </button>
                <button className="kanban-danger-button" type="button" onClick={() => void handleDeleteCard()} disabled={submitting}>
                  {submitting ? '삭제 중...' : '예, 삭제합니다'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {actionOverlayMessage ? (
        <div className="kanban-action-overlay" aria-live="polite" aria-atomic="true">
          <div className="kanban-action-overlay-card">
            <CheckCircle2 size={22} />
            <strong>{actionOverlayMessage}</strong>
          </div>
        </div>
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
    due_at: card.due_at || '',
    assignee: card.assignee,
    assignee_user_id: card.assignee_user_id ?? null,
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

function formatDueDateTime(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isCardOverdue(card: Pick<KanbanCard, 'due_at' | 'column_key'>) {
  if (!card.due_at || card.column_key === 'done') {
    return false
  }
  const parsed = new Date(card.due_at)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }
  return parsed.getTime() < Date.now()
}

function detailStepSuccessMessage(step: DetailStepKey) {
  if (step === 'basic') return '기본 정보가 저장되었습니다.'
  return '작업 대상이 저장되었습니다.'
}

function createEmptyTarget(targetKind: KanbanTargetKind): KanbanTargetItem {
  return {
    target_kind: targetKind,
    display_name: '',
    mgmt_ip: '',
    model: '',
    role_hint: '',
    cvp_device_id: '',
    match_status: targetKind === 'existing' ? 'linked_to_cvp' : 'manual_only',
  }
}

function parseBulkLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[,\t]/)[0]?.trim() ?? '')
    .filter(Boolean)
}

function parseNewTargetBulk(text: string): KanbanTargetItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [displayName = '', mgmtIp = '', model = '', roleHint = ''] = line.split(/[,\t]/).map((part) => part.trim())
      return {
        ...createEmptyTarget('new'),
        display_name: displayName,
        mgmt_ip: mgmtIp,
        model,
        role_hint: roleHint,
      }
    })
    .filter((target) => target.display_name)
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
    due_at: values.due_at.trim(),
    assignee: values.assignee.trim(),
    assignee_user_id: values.assignee_user_id ?? null,
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
