import { useEffect, useMemo, useRef, useState } from 'react'
import type { WheelEvent as ReactWheelEvent } from 'react'
import { ArrowLeft, Copy, ExternalLink, GripVertical, Link2 } from 'lucide-react'

import type {
  KanbanCard,
  WorkflowBlock,
  WorkflowChecklistBlock,
  WorkflowDocument,
  WorkflowLinkBlock,
  WorkflowNoteBlock,
  WorkflowStatus,
  WorkflowTableBlock,
} from '../../types'
import {
  buildTableCopyText,
  cloneValue,
  computePhaseProgress,
  computeWorkflowProgress,
  DEFAULT_BLOCK_HEIGHT,
  MAX_BLOCK_SPAN,
  MIN_BLOCK_HEIGHT,
  MIN_BLOCK_SPAN,
  PROGRESS_CIRCUMFERENCE,
  getPhaseAssigneeName,
  isPhaseIncludedInProgress,
  normalizeWorkflowDocument,
} from '../workflow/workflowUtils'
import '../workflow/workflow.css'

type Props = {
  card: KanbanCard
  workflow: WorkflowDocument
  onBack: () => void
}

type BlockLayoutRect = {
  id: string
  column: number
  row: number
  widthUnits: number
  rowSpan: number
}

const BLOCK_GRID_COLUMNS = 12
const BLOCK_GRID_GAP = 10
const BLOCK_GRID_ROW_HEIGHT = 4

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  not_started: '대기',
  in_progress: '진행',
  done: '완료',
  blocked: '차단',
  n_a: '해당없음',
}

export function HistoryWorkflowViewer({ card, workflow, onBack }: Props) {
  const stageLaneRef = useRef<HTMLDivElement | null>(null)
  const [compactMode, setCompactMode] = useState(false)
  const [selectedPhaseId, setSelectedPhaseId] = useState('')
  const [message, setMessage] = useState('')

  const activeWorkflow = useMemo(() => {
    const normalized = normalizeWorkflowDocument(cloneValue(workflow), card)
    normalized.phases.forEach((phase) => {
      phase.blocks.forEach((block) => {
        block.editing = false
      })
    })
    return normalized
  }, [card, workflow])

  const selectedPhase = useMemo(
    () => activeWorkflow.phases.find((phase) => phase.id === selectedPhaseId) ?? activeWorkflow.phases[0] ?? null,
    [activeWorkflow, selectedPhaseId],
  )

  const selectedPhaseLayoutMap = useMemo(() => {
    const layouts = new Map<string, BlockLayoutRect>()
    if (!selectedPhase) {
      return layouts
    }

    const placedBlocks = cloneValue(selectedPhase.blocks)
    reflowPhaseBlocks(placedBlocks)
    placedBlocks.forEach((block) => {
      layouts.set(block.id, buildBlockLayoutRect(block))
    })
    return layouts
  }, [selectedPhase])

  const selectedPhaseBoardHeight = useMemo(() => {
    if (!selectedPhase) {
      return MIN_BLOCK_HEIGHT
    }

    let maxBottom = MIN_BLOCK_HEIGHT
    selectedPhase.blocks.forEach((block) => {
      const layout = selectedPhaseLayoutMap.get(block.id) ?? buildBlockLayoutRect(block)
      const top = (layout.row - 1) * (BLOCK_GRID_ROW_HEIGHT + BLOCK_GRID_GAP)
      const bottom = top + getBlockHeightPx(block.heightPx)
      if (bottom > maxBottom) {
        maxBottom = bottom
      }
    })
    return maxBottom
  }, [selectedPhase, selectedPhaseLayoutMap])

  const selectedPhaseProgress = useMemo(() => (selectedPhase ? computePhaseProgress(selectedPhase) : 0), [selectedPhase])
  const workflowProgress = useMemo(() => computeWorkflowProgress(activeWorkflow), [activeWorkflow])
  const hasExcludedPhases = useMemo(
    () => activeWorkflow.phases.some((phase) => !isPhaseIncludedInProgress(phase)),
    [activeWorkflow],
  )
  const targetSummary = useMemo(() => summarizeTargets(activeWorkflow.targets ?? []), [activeWorkflow.targets])

  useEffect(() => {
    setSelectedPhaseId((current) => {
      if (!activeWorkflow.phases.length) {
        return ''
      }
      if (current && activeWorkflow.phases.some((phase) => phase.id === current)) {
        return current
      }
      return activeWorkflow.phases[0].id
    })
  }, [activeWorkflow])

  useEffect(() => {
    if (!message) {
      return
    }
    const timer = window.setTimeout(() => setMessage(''), 1600)
    return () => window.clearTimeout(timer)
  }, [message])

  function handleStageWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const container = stageLaneRef.current
    if (!container) {
      return
    }
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()

    const stageNodes = [...container.querySelectorAll<HTMLElement>('.workflow-stage-node')]
    if (!stageNodes.length) {
      return
    }

    const maxScrollLeft = container.scrollWidth - container.clientWidth
    if (maxScrollLeft <= 0) {
      return
    }

    const direction = event.deltaY > 0 ? 1 : -1
    const containerRect = container.getBoundingClientRect()
    const offsets = stageNodes.map((node) => {
      const nodeRect = node.getBoundingClientRect()
      const relativeLeft = nodeRect.left - containerRect.left + container.scrollLeft
      return Math.max(0, Math.min(Math.round(relativeLeft), maxScrollLeft))
    })

    const currentOffset = container.scrollLeft
    let nearestIndex = 0

    offsets.forEach((offset, index) => {
      if (Math.abs(offset - currentOffset) < Math.abs(offsets[nearestIndex] - currentOffset)) {
        nearestIndex = index
      }
    })

    const nextIndex = clamp(nearestIndex + direction, 0, offsets.length - 1)
    if (nextIndex === nearestIndex && Math.abs(offsets[nextIndex] - currentOffset) < 1) {
      return
    }

    container.scrollTo({
      left: offsets[nextIndex],
      behavior: 'smooth',
    })
  }

  async function handleCopyTable(block: WorkflowTableBlock) {
    try {
      await copyPlainText(buildTableCopyText(block))
      setMessage('표를 복사했습니다.')
    } catch {
      setMessage('표 복사에 실패했습니다.')
    }
  }

  return (
    <section className={`workflow-shell history-workflow-view ${compactMode ? 'compact' : ''}`}>
      {message ? <div className="workflow-message success">{message}</div> : null}

      <section className="workflow-hero-grid">
        <article className={`workflow-hero ${compactMode ? 'is-compact' : ''}`}>
          <div className="workflow-hero-top">
            <div className="workflow-hero-main">
              <h2>{activeWorkflow.cardTitle}</h2>
              <p className="workflow-hero-summary">{activeWorkflow.summary}</p>
            </div>

            <div className="workflow-hero-side">
              <div className="workflow-hero-card-picker">
                <button className="workflow-ghost-button" type="button" onClick={onBack}>
                  <ArrowLeft size={15} />
                  <span>작업 이력으로 돌아가기</span>
                </button>
                <div className="workflow-selected-card">
                  <div>
                    <strong>{card.title}</strong>
                    <span>
                      {card.card_code} · {card.assignee || '담당자 미지정'} · {(card.targets ?? []).length} targets
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="workflow-meta-sheet">
            <div className="workflow-meta-row">
              <span>작업 코드</span>
              <strong>{activeWorkflow.ticketId}</strong>
            </div>
            <div className="workflow-meta-row">
              <span>프로젝트명</span>
              <strong>{activeWorkflow.projectName}</strong>
            </div>
            <div className="workflow-meta-row">
              <span>생성자</span>
              <strong>{activeWorkflow.createdBy}</strong>
            </div>
            <div className="workflow-meta-row">
              <span>마지막 갱신</span>
              <strong>{formatWorkflowDisplayTimestamp(activeWorkflow.lastUpdated)}</strong>
            </div>
            <div className="workflow-meta-row">
              <span>실 담당자</span>
              <strong>{activeWorkflow.owner}</strong>
            </div>
            <div className="workflow-meta-row">
              <span>작업 대상</span>
              <strong>{targetSummary}</strong>
            </div>
          </div>
        </article>

        <article className={`workflow-progress-shell ${compactMode ? 'is-compact' : ''}`}>
          <div className="workflow-progress-layout">
            <div className="workflow-progress-panel">
              <div className="workflow-progress-ring-wrap">
                <svg className="workflow-progress-ring" viewBox="0 0 120 120" aria-hidden="true">
                  <circle className="workflow-progress-ring-track" cx="60" cy="60" r="46" />
                  <circle
                    className="workflow-progress-ring-fill"
                    cx="60"
                    cy="60"
                    r="46"
                    style={{
                      strokeDasharray: PROGRESS_CIRCUMFERENCE,
                      strokeDashoffset: PROGRESS_CIRCUMFERENCE - (PROGRESS_CIRCUMFERENCE * workflowProgress.percent) / 100,
                      stroke: getProgressColor(workflowProgress.percent),
                    }}
                  />
                </svg>
                <div className="workflow-progress-ring-value">
                  <strong>{workflowProgress.percent}%</strong>
                </div>
              </div>
              <div className="workflow-progress-caption">전체 진행률</div>
              <div className="workflow-progress-meta">
                {workflowProgress.done}개 완료 / {workflowProgress.total}개 전체 단계
              </div>
            </div>

            <div className="workflow-phase-progress-panel">
              <p className="workflow-kicker">Phase Progress</p>
              <div className="workflow-phase-progress-list">
                {activeWorkflow.phases.map((phase, index) => {
                  const progress = computePhaseProgress(phase)
                  const phaseIncludedInProgress = isPhaseIncludedInProgress(phase)
                  return (
                    <div key={phase.id} className="workflow-phase-progress-item">
                      <div className="workflow-phase-progress-copy">
                        <div className="workflow-phase-progress-copy-main">
                          <strong>
                            {index + 1}. {phase.title}
                          </strong>
                          <span className="workflow-phase-progress-subcopy">
                            담당: {getPhaseAssigneeName(phase)}
                            {phaseIncludedInProgress ? ' · 진행률 반영' : ' · 진행률 제외'}
                          </span>
                        </div>
                        <span>{progress}%</span>
                      </div>
                      <div className="workflow-phase-progress-bar">
                        <span style={{ width: `${progress}%`, background: getProgressColor(progress) }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="workflow-progress-summary-bar">
              <div className="workflow-progress-summary-copy">
                <strong>전체 진행률</strong>
                <span>{workflowProgress.percent}%</span>
              </div>
              <div className="workflow-progress-summary-track">
                <span
                  style={{
                    width: `${workflowProgress.percent}%`,
                    background: getProgressColor(workflowProgress.percent),
                  }}
                />
              </div>
              <div className="workflow-progress-summary-meta">
                {workflowProgress.done}개 완료 / {workflowProgress.total}개 전체 단계
                {hasExcludedPhases ? ' · 진행률 반영 단계만 집계' : ''}
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className={`workflow-stage-shell ${compactMode ? 'is-compact' : ''}`}>
        <div className="workflow-section-head">
          <div className="workflow-section-head-left">
            <div className="workflow-stage-title-row">
              <h3>STAGE</h3>
              <div className="workflow-inline-actions">
                <span className="workflow-inline-chip">{activeWorkflow.templateName || '기본 템플릿'}</span>
              </div>
            </div>
          </div>
          <div className="workflow-head-actions">
            <button
              className={`workflow-ghost-button workflow-stage-top-button workflow-compact-toggle ${compactMode ? 'is-active' : ''}`}
              type="button"
              onClick={() => setCompactMode((current) => !current)}
              aria-pressed={compactMode}
            >
              <span>{compactMode ? '기본 보기' : '간소화'}</span>
            </button>
          </div>
        </div>

        <div ref={stageLaneRef} className="workflow-stage-lane" onWheel={handleStageWheel}>
          {activeWorkflow.phases.map((phase, index) => {
            const progress = computePhaseProgress(phase)
            return (
              <div key={phase.id} className="workflow-stage-node">
                <article
                  className={`workflow-stage-card ${phase.id === selectedPhase?.id ? 'active' : ''}`}
                  onClick={() => setSelectedPhaseId(phase.id)}
                >
                  <h4>{phase.title}</h4>
                  <p className="workflow-stage-description">{phase.subtitle}</p>
                  <div className="workflow-stage-meta">
                    <div className="workflow-stage-meta-head">
                      <span className="workflow-stage-text">담당 {getPhaseAssigneeName(phase)}</span>
                      <span className="workflow-stage-progress-value">{progress}%</span>
                    </div>
                    <span className="workflow-mini-progress">
                      <span style={{ width: `${progress}%`, background: getProgressColor(progress) }} />
                    </span>
                  </div>
                </article>
                {index < activeWorkflow.phases.length - 1 ? <div className="workflow-stage-arrow">→</div> : null}
              </div>
            )
          })}
        </div>
      </section>

      {selectedPhase ? (
        <section className="workflow-detail-shell">
          <div className="workflow-section-head">
            <div className="workflow-detail-titles">
              <p className="workflow-kicker">Stage Workspace</p>
              <div className="workflow-phase-view">
                <h3 className="workflow-detail-title">{selectedPhase.title}</h3>
                <p className="workflow-detail-description">{selectedPhase.subtitle}</p>
              </div>
            </div>

            <div className="workflow-head-actions workflow-detail-head-actions">
              <div className="workflow-inline-actions">
                <span className="workflow-inline-chip">담당 {getPhaseAssigneeName(selectedPhase)}</span>
                <span className="workflow-inline-chip">{selectedPhaseProgress}%</span>
                {selectedPhase.isCompleted ? <span className="workflow-inline-chip">완료됨</span> : null}
              </div>
            </div>
          </div>

          <div className="workflow-block-board" style={{ minHeight: `${selectedPhaseBoardHeight}px` }}>
            {selectedPhase.blocks.map((block) => {
              const blockHeightPx = getBlockHeightPx(block.heightPx)
              const layout = selectedPhaseLayoutMap.get(block.id) ?? buildBlockLayoutRect(block)
              return (
                <article
                  key={block.id}
                  className={`workflow-block-card type-${block.type}`}
                  style={{
                    gridColumn: `${layout.column} / span ${clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)}`,
                    gridRow: `${layout.row} / span ${getBlockRowSpan(blockHeightPx)}`,
                    height: `${blockHeightPx}px`,
                  }}
                >
                  <div className="workflow-block-head">
                    <div className="workflow-block-head-left">
                      <span className="workflow-drag-handle">
                        <GripVertical size={16} />
                      </span>
                      <div className="workflow-block-title-wrap">
                        <div className="workflow-block-title-view">
                          <strong>{block.title || '제목 없음'}</strong>
                          {block.subtitle ? <span>{block.subtitle}</span> : null}
                        </div>
                      </div>
                    </div>

                    <div className="workflow-block-tools">
                      {block.type === 'table' ? (
                        <button
                          className="workflow-copy-button"
                          type="button"
                          onClick={() => void handleCopyTable(block)}
                          aria-label={`${block.title} 표 복사`}
                          title={`${block.title} 표 복사`}
                        >
                          <Copy size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="workflow-block-body">{renderBlockBody(block)}</div>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}
    </section>
  )
}

function renderBlockBody(block: WorkflowBlock) {
  if (block.type === 'table') {
    return renderTableBlock(block)
  }
  if (block.type === 'note') {
    return renderNoteBlock(block)
  }
  if (block.type === 'links') {
    return renderLinkBlock(block)
  }
  return renderChecklistBlock(block)
}

function renderTableBlock(block: WorkflowTableBlock) {
  return (
    <div className="workflow-table-wrap">
      <table className="workflow-table">
        <colgroup>
          {block.columns.map((column) => (
            <col key={column.key} data-column-key={column.key} style={{ width: `${column.width}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {block.columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${block.id}-${rowIndex}`}>
              {block.columns.map((column) => {
                if (column.type === 'status') {
                  const status = (row[column.key] || 'not_started') as WorkflowStatus
                  return (
                    <td key={column.key}>
                      <span className={`workflow-status-chip status-${status}`}>{STATUS_LABELS[status]}</span>
                    </td>
                  )
                }

                return (
                  <td key={column.key}>
                    <div className={`workflow-table-value ${column.key === 'hostname' ? 'is-strong' : ''}`}>{row[column.key] || '-'}</div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderNoteBlock(block: WorkflowNoteBlock) {
  return <div className="workflow-note-sheet">{block.content || '메모가 없습니다.'}</div>
}

function renderChecklistBlock(block: WorkflowChecklistBlock) {
  return (
    <div className="workflow-checklist-body">
      <div className="workflow-checklist-items">
        {block.items.map((item, index) => (
          <div key={`${block.id}-${index}`} className={`workflow-check-item ${item.done ? 'done' : ''}`}>
            <button className="workflow-check-toggle" type="button" disabled aria-hidden="true" />
            <div className="workflow-check-view-copy">
              <strong>{item.text}</strong>
              <span>{item.done ? '완료됨' : '미완료'}</span>
            </div>
            <div className="workflow-check-assignee">{item.assignee || '미정'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function renderLinkBlock(block: WorkflowLinkBlock) {
  return (
    <div className="workflow-link-body">
      <div className="workflow-link-items">
        {block.items.map((item, index) => (
          <div key={`${block.id}-link-${index}`} className="workflow-link-item is-view">
            <div className="workflow-link-view-copy">
              <strong>{item.label || `링크 ${index + 1}`}</strong>
              <p>{item.description || '설명이 없습니다.'}</p>
            </div>
            <button
              className="workflow-link-open-button"
              type="button"
              onClick={() => window.open(ensureWorkflowUrl(item.url), '_blank', 'noopener,noreferrer')}
              disabled={!item.url.trim()}
            >
              <Link2 size={15} />
              <span>열기</span>
              <ExternalLink size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function getBlockHeightPx(heightPx?: number) {
  return Math.max(heightPx ?? DEFAULT_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT)
}

function getBlockRowSpan(heightPx?: number) {
  return Math.max(1, Math.ceil((getBlockHeightPx(heightPx) + BLOCK_GRID_GAP) / (BLOCK_GRID_ROW_HEIGHT + BLOCK_GRID_GAP)))
}

function getBlockLayoutColumn(block: WorkflowBlock) {
  const widthUnits = clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
  const rawColumn = typeof block.layoutColumn === 'number' ? Math.round(block.layoutColumn) : 1
  return clamp(rawColumn, 1, BLOCK_GRID_COLUMNS - widthUnits + 1)
}

function getBlockLayoutRow(block: WorkflowBlock) {
  const rawRow = typeof block.layoutRow === 'number' ? Math.round(block.layoutRow) : 1
  return Math.max(1, rawRow)
}

function buildBlockLayoutRect(block: WorkflowBlock): BlockLayoutRect {
  return {
    id: block.id,
    column: getBlockLayoutColumn(block),
    row: getBlockLayoutRow(block),
    widthUnits: clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN),
    rowSpan: getBlockRowSpan(block.heightPx),
  }
}

function compareBlocksForLayout(left: WorkflowBlock, right: WorkflowBlock) {
  const leftRect = buildBlockLayoutRect(left)
  const rightRect = buildBlockLayoutRect(right)
  if (leftRect.row !== rightRect.row) {
    return leftRect.row - rightRect.row
  }
  if (leftRect.column !== rightRect.column) {
    return leftRect.column - rightRect.column
  }
  return 0
}

function rectanglesOverlap(left: BlockLayoutRect, right: BlockLayoutRect) {
  const leftEndColumn = left.column + left.widthUnits
  const rightEndColumn = right.column + right.widthUnits
  const leftEndRow = left.row + left.rowSpan
  const rightEndRow = right.row + right.rowSpan
  return !(leftEndColumn <= right.column || rightEndColumn <= left.column || leftEndRow <= right.row || rightEndRow <= left.row)
}

function clampLayoutRect(rect: BlockLayoutRect): BlockLayoutRect {
  const widthUnits = clamp(rect.widthUnits, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
  return {
    ...rect,
    widthUnits,
    rowSpan: Math.max(1, rect.rowSpan),
    column: clamp(rect.column, 1, BLOCK_GRID_COLUMNS - widthUnits + 1),
    row: Math.max(1, rect.row),
  }
}

function findVerticalPushLayout(baseRect: BlockLayoutRect, others: BlockLayoutRect[]) {
  const placed = clampLayoutRect(baseRect)
  for (let safety = 0; safety < 256; safety += 1) {
    const overlaps = others.filter((other) => rectanglesOverlap(placed, other))
    if (!overlaps.length) {
      return placed
    }
    placed.row = Math.max(...overlaps.map((other) => other.row + other.rowSpan))
  }
  return placed
}

function reflowPhaseBlocks(blocks: WorkflowBlock[]) {
  const placedLayouts: BlockLayoutRect[] = []
  const layoutMap = new Map<string, BlockLayoutRect>()
  const orderedBlocks = [...blocks].sort(compareBlocksForLayout)

  orderedBlocks.forEach((block) => {
    const placedRect = findVerticalPushLayout(buildBlockLayoutRect(block), placedLayouts)
    placedLayouts.push(placedRect)
    layoutMap.set(block.id, placedRect)
  })

  blocks.forEach((block) => {
    const placedRect = layoutMap.get(block.id)
    if (!placedRect) {
      return
    }
    block.layoutColumn = placedRect.column
    block.layoutRow = placedRect.row
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function summarizeTargets(targets: string[]) {
  const cleaned = targets.map((target) => target.trim()).filter(Boolean)
  if (!cleaned.length) {
    return '미정'
  }
  if (cleaned.length <= 2) {
    return cleaned.join(', ')
  }
  return `${cleaned.slice(0, 2).join(', ')}...`
}

function getProgressColor(percent: number) {
  if (percent >= 100) {
    return '#1e8a5d'
  }
  if (percent >= 50) {
    return '#d08a2f'
  }
  return '#d9a1aa'
}

function formatWorkflowTimestamp(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function formatWorkflowDisplayTimestamp(value: string) {
  if (!value) {
    return '-'
  }
  const normalized = value.includes('T') ? value : value.replace(/\.\s*/g, '-').replace(/\s+/g, ' ')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return formatWorkflowTimestamp(parsed)
}

function ensureWorkflowUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `https://${trimmed}`
}

async function copyPlainText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
