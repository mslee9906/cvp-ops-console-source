import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, GripVertical, Plus, RefreshCcw, Trash2 } from 'lucide-react'

import { api } from '../../api'
import type { KanbanCard, KanbanCardInput, KanbanColumnKey } from '../../types'
import { AutoGrowTextarea } from './AutoGrowTextarea'
import { KanbanCardModal } from './KanbanCardModal'
import './kanban.css'

const COLUMN_META: Array<{ key: KanbanColumnKey; label: string; tone: string }> = [
  { key: 'blocked', label: '보류', tone: 'rose' },
  { key: 'planned', label: '작업 예정', tone: 'blue' },
  { key: 'ready', label: '준비 완료', tone: 'teal' },
  { key: 'in_progress', label: '작업 중', tone: 'amber' },
  { key: 'verifying', label: '검증 중', tone: 'blue' },
  { key: 'done', label: '완료', tone: 'teal' },
]

const EMPTY_CARD_INPUT: KanbanCardInput = {
  title: '',
  description: '',
  column_key: 'planned',
  card_type: 'existing',
  priority: 'medium',
}

export function KanbanBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null)
  const [editorCard, setEditorCard] = useState<KanbanCard | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [detailDraft, setDetailDraft] = useState<KanbanCardInput | null>(null)
  const [dragCardId, setDragCardId] = useState<number | null>(null)

  const selectedCard = useMemo(
    () => cards.find((item) => item.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )

  const groupedCards = useMemo(() => {
    return Object.fromEntries(
      COLUMN_META.map((meta) => [meta.key, sortCards(cards.filter((card) => card.column_key === meta.key))]),
    ) as Record<KanbanColumnKey, KanbanCard[]>
  }, [cards])

  useEffect(() => {
    void loadCards()
  }, [])

  useEffect(() => {
    if (selectedCard) {
      setDetailDraft(toCardInput(selectedCard))
    }
  }, [selectedCard])

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
  }

  function closeDetail() {
    setSelectedCardId(null)
    setDetailDraft(null)
  }

  async function handleCreate(values: KanbanCardInput) {
    try {
      setSubmitting(true)
      setError('')
      const created = await api.createKanbanCard(values)
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
      const updated = await api.updateKanbanCard(cardId, values)
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
      const updated = await api.updateKanbanCard(selectedCard.id, detailDraft)
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
          <p className="kanban-copy">이번 단계에서는 카드 생성, 수정, 삭제와 드래그 이동까지만 관리합니다. 카드를 더블클릭하면 빠른 수정이 열리고, 자세히 보기에서는 기본 정보를 저장할 수 있습니다.</p>
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
          <div className="kanban-inline-actions left">
            <button className="kanban-ghost-button" type="button" onClick={closeDetail}>
              <ArrowLeft size={16} />
              <span>보드로 돌아가기</span>
            </button>
          </div>

          <div className="kanban-detail-layout">
            <aside className="kanban-detail-sidebar">
              <article className="kanban-detail-summary-card">
                <p className="kanban-kicker">Task Summary</p>
                <h3>{selectedCard.title}</h3>
                <div className="kanban-summary-row">
                  <span>카드 번호</span>
                  <strong>{selectedCard.card_code}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>현재 상태</span>
                  <strong>{columnLabel(selectedCard.column_key)}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>작업 유형</span>
                  <strong>{selectedCard.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>우선순위</span>
                  <strong>{priorityLabel(selectedCard.priority)}</strong>
                </div>
                <div className="kanban-summary-row">
                  <span>수정 시각</span>
                  <strong>{formatDateTime(selectedCard.updated_at)}</strong>
                </div>
              </article>

              <section className="kanban-step-panel">
                <p className="kanban-kicker">작업 단계</p>
                <button className="kanban-step-link active" type="button">
                  기본 정보
                </button>
                <p className="kanban-step-copy">이번 단계에서는 카드 기본 정보만 편집합니다. 장비 연결, 체크리스트, diff, 검증은 이후 단계에서 추가할 예정입니다.</p>
              </section>
            </aside>

            <section className="kanban-detail-main">
              <div className="kanban-section-head">
                <div>
                  <p className="kanban-kicker">Card Detail</p>
                  <h3>기본 정보 편집</h3>
                </div>
              </div>

              <form className="kanban-form" onSubmit={handleDetailSubmit}>
                <label className="kanban-field wide">
                  <span>작업 제목</span>
                  <input
                    value={detailDraft.title}
                    onChange={(event) => setDetailDraft((current) => (current ? { ...current, title: event.target.value } : current))}
                    required
                  />
                </label>

                <div className="kanban-field-grid">
                  <label className="kanban-field">
                    <span>상태</span>
                    <select
                      value={detailDraft.column_key}
                      onChange={(event) =>
                        setDetailDraft((current) =>
                          current ? { ...current, column_key: event.target.value as KanbanColumnKey } : current,
                        )
                      }
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
                        setDetailDraft((current) =>
                          current ? { ...current, card_type: event.target.value as KanbanCardInput['card_type'] } : current,
                        )
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
                      onChange={(event) =>
                        setDetailDraft((current) =>
                          current ? { ...current, priority: event.target.value as KanbanCardInput['priority'] } : current,
                        )
                      }
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
                    rows={10}
                    onChange={(event) => setDetailDraft((current) => (current ? { ...current, description: event.target.value } : current))}
                  />
                </label>

                <div className="kanban-detail-actions">
                  <button
                    className="kanban-danger-button"
                    type="button"
                    onClick={() => void handleDelete(selectedCard.id)}
                    disabled={submitting}
                  >
                    <Trash2 size={16} />
                    <span>카드 삭제</span>
                  </button>
                  <button className="kanban-primary-button" type="submit" disabled={submitting || !detailDraft.title.trim()}>
                    {submitting ? '저장 중...' : '기본 정보 저장'}
                  </button>
                </div>
              </form>
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
    column_key: card.column_key,
    card_type: card.card_type,
    priority: card.priority,
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
