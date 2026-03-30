import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import type { KanbanCard, KanbanCardInput, KanbanColumnKey, KanbanPriority, KanbanCardType } from '../../types'
import { AutoGrowTextarea } from './AutoGrowTextarea'

const columnOptions: Array<{ value: KanbanColumnKey; label: string }> = [
  { value: 'blocked', label: '보류' },
  { value: 'planned', label: '작업 예정' },
  { value: 'ready', label: '준비 완료' },
  { value: 'in_progress', label: '작업 중' },
  { value: 'verifying', label: '검증 중' },
  { value: 'done', label: '완료' },
]

const typeOptions: Array<{ value: KanbanCardType; label: string }> = [
  { value: 'existing', label: '기존 장비 작업' },
  { value: 'new', label: '신규 장비 작업' },
]

const priorityOptions: Array<{ value: KanbanPriority; label: string }> = [
  { value: 'high', label: '높음' },
  { value: 'medium', label: '중간' },
  { value: 'low', label: '낮음' },
]

type Props = {
  mode: 'create' | 'edit'
  initialValues: KanbanCardInput
  card?: KanbanCard | null
  submitting: boolean
  onClose: () => void
  onSubmit: (values: KanbanCardInput) => void | Promise<void>
  onDelete?: (() => void | Promise<void>) | undefined
}

export function KanbanCardModal({ mode, initialValues, card, submitting, onClose, onSubmit, onDelete }: Props) {
  const [values, setValues] = useState<KanbanCardInput>(initialValues)

  useEffect(() => {
    setValues(initialValues)
  }, [initialValues])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void onSubmit({
      ...values,
      title: values.title.trim(),
      description: values.description.trim(),
    })
  }

  return (
    <div className="kanban-modal-backdrop" onClick={onClose}>
      <div className="kanban-modal" onClick={(event) => event.stopPropagation()}>
        <div className="kanban-modal-head">
          <div>
            <p className="kanban-kicker">{mode === 'create' ? 'Create Card' : 'Quick Edit'}</p>
            <h3>{mode === 'create' ? '새 카드 생성' : card?.title ?? '카드 수정'}</h3>
          </div>
          <button className="kanban-ghost-button" type="button" onClick={onClose}>
            닫기
          </button>
        </div>

        <form className="kanban-form" onSubmit={handleSubmit}>
          <label className="kanban-field wide">
            <span>작업 제목</span>
            <input
              value={values.title}
              onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
              placeholder="예: LEAF1 BGP 정책 검토"
              required
            />
          </label>

          <div className="kanban-field-grid">
            <label className="kanban-field">
              <span>상태</span>
              <select
                value={values.column_key}
                onChange={(event) =>
                  setValues((current) => ({ ...current, column_key: event.target.value as KanbanColumnKey }))
                }
              >
                {columnOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="kanban-field">
              <span>작업 유형</span>
              <select
                value={values.card_type}
                onChange={(event) =>
                  setValues((current) => ({ ...current, card_type: event.target.value as KanbanCardType }))
                }
              >
                {typeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="kanban-field">
              <span>우선순위</span>
              <select
                value={values.priority}
                onChange={(event) =>
                  setValues((current) => ({ ...current, priority: event.target.value as KanbanPriority }))
                }
              >
                {priorityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="kanban-field wide">
            <span>작업 설명</span>
            <AutoGrowTextarea
              value={values.description}
              onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
              placeholder="작업 목적, 메모, 변경 포인트를 적습니다."
              rows={6}
            />
          </label>

          <div className="kanban-modal-actions">
            {mode === 'edit' && onDelete ? (
              <button className="kanban-danger-button" type="button" onClick={() => void onDelete()} disabled={submitting}>
                카드 삭제
              </button>
            ) : <span />}
            <div className="kanban-inline-actions">
              <button className="kanban-ghost-button" type="button" onClick={onClose} disabled={submitting}>
                취소
              </button>
              <button className="kanban-primary-button" type="submit" disabled={submitting || !values.title.trim()}>
                {submitting ? '저장 중...' : mode === 'create' ? '생성' : '저장'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
