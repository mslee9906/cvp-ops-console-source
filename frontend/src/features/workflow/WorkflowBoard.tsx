import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  Check,
  Copy,
  GripVertical,
  LayoutTemplate,
  ListChecks,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react'

import { ApiError, api } from '../../api'
import type {
  KanbanCard,
  UserSummary,
  WorkflowBlock,
  WorkflowChecklistBlock,
  WorkflowDocument,
  WorkflowNoteBlock,
  WorkflowPhase,
  WorkflowStatus,
  WorkflowTableBlock,
  WorkflowTemplate,
} from '../../types'
import {
  DEFAULT_BLOCK_HEIGHT,
  MAX_BLOCK_SPAN,
  MIN_BLOCK_HEIGHT,
  MIN_BLOCK_SPAN,
  MIN_COLUMN_WIDTH,
  PROGRESS_CIRCUMFERENCE,
  STATUS_FLOW,
  STATUS_LABEL,
  applyTemplateToWorkflow,
  buildTableCopyText,
  cloneValue,
  computePhaseProgress,
  computeWorkflowProgress,
  createChecklistBlock,
  createCustomTableBlock,
  createEmptyRow,
  createNoteBlock,
  createTargetTableBlock,
  getDefaultColumnWidth,
  getPhaseAssigneeName,
  isPhaseIncludedInProgress,
  normalizeWorkflowDocument,
  reconcilePhaseCompletion,
  replaceTargetRows,
  uid,
} from './workflowUtils'
import './workflow.css'

type WorkflowBoardProps = {
  currentUser: UserSummary | null
  users: UserSummary[]
  focusRequest?: {
    cardId: number
    phaseId?: string | null
    token: number
  } | null
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

type DraggedColumn = {
  blockId: string
  columnKey: string
}

type BlockLayoutRect = {
  id: string
  column: number
  row: number
  widthUnits: number
  rowSpan: number
}

type BlockPointerDragState = {
  blockId: string
  originColumn: number
  originRow: number
  targetColumn: number
  targetRow: number
  widthUnits: number
  heightPx: number
  startLeft: number
  startTop: number
  translateX: number
  translateY: number
  offsetX: number
  offsetY: number
}

const BLOCK_GRID_COLUMNS = 12
const BLOCK_GRID_GAP = 10
const BLOCK_GRID_ROW_HEIGHT = 4

function getBlockHeightPx(heightPx?: number) {
  return Math.max(heightPx ?? DEFAULT_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT)
}

function getBlockRowSpan(heightPx?: number) {
  return Math.max(1, Math.ceil((getBlockHeightPx(heightPx) + BLOCK_GRID_GAP) / (BLOCK_GRID_ROW_HEIGHT + BLOCK_GRID_GAP)))
}

function getMinimumTableInnerWidth(block: WorkflowTableBlock) {
  const columnsWidth = block.columns.reduce((total, column) => total + Math.max(Number(column.width) || 0, MIN_COLUMN_WIDTH), 0)
  const manageColumnWidth = block.editing ? 56 : 0
  return columnsWidth + manageColumnWidth
}

function getMinimumTableSpan(block: WorkflowTableBlock, columnWidth: number) {
  const requiredCardWidth = getMinimumTableInnerWidth(block) + 24
  return clamp(
    Math.ceil((requiredCardWidth + BLOCK_GRID_GAP) / Math.max(columnWidth + BLOCK_GRID_GAP, 1)),
    MIN_BLOCK_SPAN,
    MAX_BLOCK_SPAN,
  )
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

function rectanglesOverlap(left: BlockLayoutRect, right: BlockLayoutRect) {
  const leftEndColumn = left.column + left.widthUnits
  const rightEndColumn = right.column + right.widthUnits
  const leftEndRow = left.row + left.rowSpan
  const rightEndRow = right.row + right.rowSpan
  return !(leftEndColumn <= right.column || rightEndColumn <= left.column || leftEndRow <= right.row || rightEndRow <= left.row)
}

function hasLayoutOverlap(rect: BlockLayoutRect, others: BlockLayoutRect[]) {
  return others.some((other) => rectanglesOverlap(rect, other))
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

function findNearestFreeLayout(baseRect: BlockLayoutRect, others: BlockLayoutRect[]) {
  const base = clampLayoutRect(baseRect)
  if (!hasLayoutOverlap(base, others)) {
    return base
  }

  const maxRadius = 120
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (const dy of [-radius, radius]) {
        const candidate = clampLayoutRect({
          ...base,
          column: base.column + dx,
          row: base.row + dy,
        })
        if (!hasLayoutOverlap(candidate, others)) {
          return candidate
        }
      }
    }
    for (let dy = -radius + 1; dy <= radius - 1; dy += 1) {
      for (const dx of [-radius, radius]) {
        const candidate = clampLayoutRect({
          ...base,
          column: base.column + dx,
          row: base.row + dy,
        })
        if (!hasLayoutOverlap(candidate, others)) {
          return candidate
        }
      }
    }
  }

  return base
}

export function WorkflowBoard({ currentUser, users, focusRequest = null }: WorkflowBoardProps) {
  const canEdit = currentUser?.role !== 'viewer'
  const cardPickerRef = useRef<HTMLDivElement | null>(null)
  const blockBoardRef = useRef<HTMLDivElement | null>(null)
  const workflowRef = useRef<WorkflowDocument | null>(null)
  const selectedCardIdRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const saveFingerprintRef = useRef('')
  const draggedPhaseIdRef = useRef<string | null>(null)
  const draggedColumnRef = useRef<DraggedColumn | null>(null)
  const pendingFocusPhaseIdRef = useRef<string>('')
  const stageLaneRef = useRef<HTMLDivElement | null>(null)

  const [cards, setCards] = useState<KanbanCard[]>([])
  const [loadingCards, setLoadingCards] = useState(true)
  const [loadingWorkflow, setLoadingWorkflow] = useState(false)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [showCardPicker, setShowCardPicker] = useState(false)
  const [cardFilter, setCardFilter] = useState('')
  const deferredCardFilter = useDeferredValue(cardFilter)
  const [workflow, setWorkflow] = useState<WorkflowDocument | null>(null)
  const [selectedPhaseId, setSelectedPhaseId] = useState('')
  const [editingPhase, setEditingPhase] = useState(false)
  const [compactMode, setCompactMode] = useState(false)
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [showAddOverlay, setShowAddOverlay] = useState(false)
  const [showTemplateOverlay, setShowTemplateOverlay] = useState(false)
  const [showPhaseOverlay, setShowPhaseOverlay] = useState(false)
  const [newPhaseTitle, setNewPhaseTitle] = useState('')
  const [newPhaseSubtitle, setNewPhaseSubtitle] = useState('')
  const [newPhaseAssigneeUserId, setNewPhaseAssigneeUserId] = useState('')
  const [newPhaseIncludeInProgress, setNewPhaseIncludeInProgress] = useState(true)
  const [templateName, setTemplateName] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [, setSaveState] = useState<SaveState>('idle')
  const [, setSaveMessage] = useState('')
  const [, setCopyFeedback] = useState('')
  const [completingPhase, setCompletingPhase] = useState(false)
  const [completionFeedback, setCompletionFeedback] = useState('')
  const [blockDragState, setBlockDragState] = useState<BlockPointerDragState | null>(null)
  const [resizingBlockId, setResizingBlockId] = useState('')

  const selectedCard = useMemo(
    () => cards.find((card) => card.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )
  const filteredCards = useMemo(() => {
    const token = deferredCardFilter.trim().toLowerCase()
    if (!token) {
      return cards
    }
    return cards.filter((card) =>
      [card.card_code, card.title, card.assignee, card.description].join(' ').toLowerCase().includes(token),
    )
  }, [cards, deferredCardFilter])
  const selectedPhase = useMemo(
    () => workflow?.phases.find((phase) => phase.id === selectedPhaseId) ?? workflow?.phases[0] ?? null,
    [selectedPhaseId, workflow],
  )
  const selectedPhaseLayoutMap = useMemo(() => {
    const layouts = new Map<string, BlockLayoutRect>()
    if (!selectedPhase) {
      return layouts
    }

    const placedLayouts: BlockLayoutRect[] = []
    selectedPhase.blocks.forEach((block) => {
      const placedRect = findNearestFreeLayout(buildBlockLayoutRect(block), placedLayouts)
      placedLayouts.push(placedRect)
      layouts.set(block.id, placedRect)
    })
    return layouts
  }, [selectedPhase])
  const selectedPhaseProgress = useMemo(() => (selectedPhase ? computePhaseProgress(selectedPhase) : 0), [selectedPhase])
  const workflowProgress = useMemo(
    () => (workflow ? computeWorkflowProgress(workflow) : { percent: 0, done: 0, total: 0 }),
    [workflow],
  )
  const hasExcludedPhases = useMemo(
    () => workflow?.phases.some((phase) => !isPhaseIncludedInProgress(phase)) ?? false,
    [workflow],
  )
  const workflowFingerprint = useMemo(() => (workflow ? JSON.stringify(workflow) : ''), [workflow])
  const targetSummary = useMemo(() => summarizeTargets(workflow?.targets ?? []), [workflow?.targets])
  const userDirectory = useMemo(() => {
    return new Map(users.map((user) => [user.id, user]))
  }, [users])
  const phaseAssigneeOptions = useMemo(() => {
    return [...users].sort((left, right) => {
      if (left.is_active !== right.is_active) {
        return left.is_active ? -1 : 1
      }
      return `${left.display_name}${left.username}`.localeCompare(`${right.display_name}${right.username}`, 'ko')
    })
  }, [users])
  const canCompleteSelectedPhase = useMemo(() => {
    if (!selectedPhase || !currentUser) {
      return false
    }
    if (selectedPhase.isCompleted || selectedPhaseProgress < 100) {
      return false
    }
    if (currentUser.role === 'admin') {
      return true
    }
    return selectedPhase.assigneeUserId === currentUser.id
  }, [currentUser, selectedPhase, selectedPhaseProgress])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    workflowRef.current = workflow
  }, [workflow])

  useEffect(() => {
    selectedCardIdRef.current = selectedCardId
  }, [selectedCardId])

  useEffect(() => {
    if (!cards.length) {
      setSelectedCardId(null)
      return
    }
    if (!selectedCardId || !cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(cards[0].id)
    }
  }, [cards, selectedCardId])

  useEffect(() => {
    if (!workflow?.phases.length) {
      setSelectedPhaseId('')
      return
    }
    if (!selectedPhaseId || !workflow.phases.some((phase) => phase.id === selectedPhaseId)) {
      setSelectedPhaseId(workflow.phases[0].id)
    }
  }, [selectedPhaseId, workflow])

  useEffect(() => {
    if (!selectedCardId) {
      setWorkflow(null)
      setSelectedPhaseId('')
      return
    }
    void loadCardWorkflow(selectedCardId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId])

  useEffect(() => {
    if (!selectedCardId) {
      return
    }
    if (!cards.some((card) => card.id === selectedCardId)) {
      return
    }
    if (workflowRef.current?.ticketId === cards.find((card) => card.id === selectedCardId)?.card_code) {
      return
    }
    void loadCardWorkflow(selectedCardId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, selectedCardId])

  useEffect(() => {
    const container = stageLaneRef.current
    if (!container) {
      return
    }

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return
      }

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

      event.preventDefault()
      container.scrollTo({
        left: offsets[nextIndex],
        behavior: 'smooth',
      })
    }

    container.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [workflow?.phases.length])

  useEffect(() => {
    if (!selectedPhase || !blockBoardRef.current || blockDragState) {
      return
    }

    const syncBlockMeasurements = () => {
      const board = blockBoardRef.current
      if (!board) {
        return
      }

      const boardRect = board.getBoundingClientRect()
      const columnWidth = (boardRect.width - BLOCK_GRID_GAP * (BLOCK_GRID_COLUMNS - 1)) / BLOCK_GRID_COLUMNS
      const pendingUpdates = selectedPhase.blocks
        .map((block) => {
          const card = board.querySelector<HTMLElement>(`[data-block-card-id="${block.id}"]`)
          if (!card) {
            return null
          }
          const head = card.querySelector<HTMLElement>('.workflow-block-head')
          const body = card.querySelector<HTMLElement>('.workflow-block-body')
          if (!head || !body) {
            return null
          }

          const measuredHeight = Math.ceil(head.offsetHeight + body.scrollHeight + 2)
          const currentHeight = getBlockHeightPx(block.heightPx)
          let nextHeight = currentHeight
          if (measuredHeight > currentHeight + 6) {
            nextHeight = Math.max(measuredHeight, MIN_BLOCK_HEIGHT)
          }

          let nextWidthUnits = clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
          if (block.type === 'table') {
            const minSpanFromTable = getMinimumTableSpan(block, columnWidth)
            nextWidthUnits = Math.max(nextWidthUnits, minSpanFromTable)
          }

          if (nextHeight === currentHeight && nextWidthUnits === clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)) {
            return null
          }

          return { id: block.id, heightPx: nextHeight, widthUnits: nextWidthUnits }
        })
        .filter((item): item is { id: string; heightPx: number; widthUnits: number } => item !== null)

      if (!pendingUpdates.length) {
        return
      }

      mutateWorkflow(
        (draft) => {
          const phase = draft.phases.find((item) => item.id === selectedPhase.id)
          if (!phase) {
            return
          }

          pendingUpdates.forEach(({ id, heightPx, widthUnits }) => {
            const block = phase.blocks.find((item) => item.id === id)
            if (block) {
              block.heightPx = heightPx
              block.widthUnits = widthUnits
            }
          })
        },
        { touch: false },
      )
    }

    const frameId = window.requestAnimationFrame(syncBlockMeasurements)
    const handleResize = () => window.requestAnimationFrame(syncBlockMeasurements)
    window.addEventListener('resize', handleResize)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', handleResize)
    }
  }, [blockDragState, selectedPhase])

  useEffect(() => {
    if (!focusRequest?.cardId) {
      return
    }
    pendingFocusPhaseIdRef.current = focusRequest.phaseId ?? ''
    void (async () => {
      if (selectedCardIdRef.current !== focusRequest.cardId) {
        await handleSelectCard(focusRequest.cardId)
        return
      }
      if (pendingFocusPhaseIdRef.current) {
        setSelectedPhaseId(pendingFocusPhaseIdRef.current)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token])

  useEffect(() => {
    if (!showCardPicker) {
      return
    }

    function handleOutsidePointer(event: MouseEvent) {
      if (!cardPickerRef.current?.contains(event.target as Node)) {
        setShowCardPicker(false)
      }
    }

    window.addEventListener('mousedown', handleOutsidePointer)
    return () => window.removeEventListener('mousedown', handleOutsidePointer)
  }, [showCardPicker])

  useEffect(() => {
    if (!workflow || !selectedCardId || !canEdit) {
      return
    }
    if (workflowFingerprint === saveFingerprintRef.current) {
      return
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }

    setSaveState('saving')
    setSaveMessage('자동 저장 중')
    saveTimerRef.current = window.setTimeout(() => {
      void persistWorkflow(workflow, selectedCardId)
    }, 650)

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [canEdit, selectedCardId, workflow, workflowFingerprint])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
      void flushPendingSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function parseOptionalUserId(value: string) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }

  function getPhaseAssigneeLabel(phase: WorkflowPhase) {
    if (phase.assigneeUserId) {
      const matchedUser = userDirectory.get(phase.assigneeUserId)
      if (matchedUser) {
        return matchedUser.display_name || matchedUser.username
      }
    }
    return getPhaseAssigneeName(phase)
  }

  function buildPhaseAssignee(userId: number | null, fallback = '미정') {
    if (!userId) {
      return { assigneeUserId: null, assigneeName: fallback }
    }
    const matchedUser = userDirectory.get(userId)
    if (!matchedUser) {
      return { assigneeUserId: userId, assigneeName: fallback }
    }
    return {
      assigneeUserId: matchedUser.id,
      assigneeName: matchedUser.display_name || matchedUser.username || fallback,
    }
  }

  function openPhaseOverlay() {
    setNewPhaseTitle('')
    setNewPhaseSubtitle('')
    setNewPhaseAssigneeUserId('')
    setNewPhaseIncludeInProgress(true)
    setShowPhaseOverlay(true)
  }

  async function bootstrap() {
    try {
      setLoadingCards(true)
      setError('')
      const loadedCards = await api.getKanbanCards()
      setCards(loadedCards)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 카드를 불러오지 못했습니다.')
    } finally {
      setLoadingCards(false)
    }
  }

  async function loadCardWorkflow(cardId: number) {
    const card = cards.find((item) => item.id === cardId)
    if (!card) {
      return
    }

    try {
      setLoadingWorkflow(true)
      setError('')
      setCompletionFeedback('')
      const [workflowResponse, templateResponse] = await Promise.all([
        api.getWorkflow(cardId),
        api.getWorkflowTemplates(card.card_type),
      ])
      const normalized = normalizeWorkflowDocument(workflowResponse.workflow, card)
      saveFingerprintRef.current = JSON.stringify(normalized)
      setWorkflow(normalized)
      setTemplates(templateResponse)
      const focusedPhaseId =
        pendingFocusPhaseIdRef.current && normalized.phases.some((phase) => phase.id === pendingFocusPhaseIdRef.current)
          ? pendingFocusPhaseIdRef.current
          : normalized.phases[0]?.id ?? ''
      setSelectedPhaseId(focusedPhaseId)
      pendingFocusPhaseIdRef.current = ''
      setEditingPhase(false)
      setSaveState('saved')
      setSaveMessage('자동 저장 중')
    } catch (loadError) {
      setWorkflow(null)
      setTemplates([])
      if (loadError instanceof ApiError && loadError.status === 404) {
        setError('워크플로우 문서를 불러오지 못했습니다.')
      } else {
        setError(loadError instanceof Error ? loadError.message : '워크플로우를 불러오지 못했습니다.')
      }
      setSaveState('error')
      setSaveMessage('자동 저장 중')
    } finally {
      setLoadingWorkflow(false)
    }
  }

  async function persistWorkflow(document: WorkflowDocument, cardId: number) {
    try {
      const response = await api.saveWorkflow(cardId, document)
      const matchedCard = cards.find((card) => card.id === cardId)
      const normalized = matchedCard ? normalizeWorkflowDocument(response.workflow, matchedCard) : response.workflow
      const nextFingerprint = JSON.stringify(normalized)
      if (selectedCardIdRef.current === cardId) {
        setWorkflow(normalized)
      }
      saveFingerprintRef.current = nextFingerprint
      setSaveState('saved')
      setSaveMessage('자동 저장 중')
    } catch (saveError) {
      setSaveState('error')
      setSaveMessage('자동 저장 중')
      setError(saveError instanceof Error ? saveError.message : '워크플로우를 저장하지 못했습니다.')
    }
  }

  async function flushPendingSave() {
    if (!canEdit) {
      return
    }
    const current = workflowRef.current
    const cardId = selectedCardIdRef.current
    if (!current || !cardId) {
      return
    }
    const fingerprint = JSON.stringify(current)
    if (fingerprint === saveFingerprintRef.current) {
      return
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await persistWorkflow(current, cardId)
  }

  async function handleSelectCard(cardId: number) {
    await flushPendingSave()
    setSelectedCardId(cardId)
    setShowCardPicker(false)
    setCardFilter('')
  }

  function mutateWorkflow(mutator: (draft: WorkflowDocument) => void, options?: { touch?: boolean }) {
    setWorkflow((current) => {
      if (!current) {
        return current
      }
      const next = cloneValue(current)
      mutator(next)
      next.phases = next.phases.map((phase) => reconcilePhaseCompletion(phase))
      if (options?.touch !== false) {
        next.lastUpdated = formatWorkflowTimestamp(new Date())
        next.lastUpdatedBy = currentUser?.display_name || currentUser?.username || next.lastUpdatedBy || ''
      }
      return next
    })
  }

  function findBlock(phaseId: string, blockId: string, document: WorkflowDocument) {
    return document.phases.find((phase) => phase.id === phaseId)?.blocks.find((block) => block.id === blockId)
  }

  function handleUpdatePhaseTitle(value: string) {
    if (!canEdit || !selectedPhase) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (phase) {
        phase.title = value
      }
    })
  }

  function handleUpdatePhaseSubtitle(value: string) {
    if (!canEdit || !selectedPhase) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (phase) {
        phase.subtitle = value
      }
    })
  }

  function handleUpdatePhaseAssignee(value: string) {
    if (!canEdit || !selectedPhase) {
      return
    }
    const nextAssignee = buildPhaseAssignee(parseOptionalUserId(value), getPhaseAssigneeName(selectedPhase))
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (phase) {
        phase.assigneeUserId = nextAssignee.assigneeUserId
        phase.assigneeName = nextAssignee.assigneeName
      }
    })
  }

  function handleUpdatePhaseIncludeInProgress(includeInProgress: boolean) {
    if (!canEdit || !selectedPhase) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (phase) {
        phase.includeInProgress = includeInProgress
      }
    })
  }

  function togglePhaseEditing() {
    if (!canEdit) {
      return
    }
    setEditingPhase((current) => !current)
  }

  function handleDeletePhase() {
    if (!canEdit || !workflow || workflow.phases.length <= 1 || !selectedPhase) {
      return
    }
    mutateWorkflow((draft) => {
      const index = draft.phases.findIndex((phase) => phase.id === selectedPhase.id)
      if (index === -1) {
        return
      }
      draft.phases.splice(index, 1)
      const fallback = draft.phases[Math.max(0, index - 1)]
      setSelectedPhaseId(fallback?.id ?? '')
    })
    setEditingPhase(false)
  }

  function handleAddPhase() {
    if (!canEdit) {
      return
    }
    const title = newPhaseTitle.trim()
    if (!title) {
      return
    }
    const subtitle = newPhaseSubtitle.trim()
    const newPhaseAssignee = buildPhaseAssignee(parseOptionalUserId(newPhaseAssigneeUserId))
    const newPhase: WorkflowPhase = {
      id: uid('phase'),
      title,
      subtitle,
      assigneeUserId: newPhaseAssignee.assigneeUserId,
      assigneeName: newPhaseAssignee.assigneeName,
      includeInProgress: newPhaseIncludeInProgress,
      isCompleted: false,
      completedAt: '',
      completedByUserId: null,
      completedByName: '',
      blocks: [createNoteBlock('메모 블록', '새 단계의 기본 메모', '')],
    }

    mutateWorkflow((draft) => {
      draft.phases.push(newPhase)
      setSelectedPhaseId(newPhase.id)
    })
    setEditingPhase(true)
    setShowPhaseOverlay(false)
    setNewPhaseTitle('')
    setNewPhaseSubtitle('')
    setNewPhaseAssigneeUserId('')
    setNewPhaseIncludeInProgress(true)
  }

  function handleApplyTemplate(template: WorkflowTemplate) {
    if (!canEdit || !workflow || !selectedCard) {
      return
    }
    mutateWorkflow((draft) => {
      const next = normalizeWorkflowDocument(applyTemplateToWorkflow(draft, template), selectedCard)
      Object.assign(draft, next)
      setSelectedPhaseId(next.phases[0]?.id ?? '')
    })
    setEditingPhase(false)
    setShowTemplateOverlay(false)
  }

  async function handleCompleteSelectedPhase() {
    if (!selectedCard || !selectedPhase || !canCompleteSelectedPhase) {
      return
    }
    try {
      setCompletingPhase(true)
      setError('')
      await flushPendingSave()
      const response = await api.completeWorkflowPhase(selectedCard.id, selectedPhase.id)
      const normalized = normalizeWorkflowDocument(response.workflow, selectedCard)
      saveFingerprintRef.current = JSON.stringify(normalized)
      setWorkflow(normalized)
      if (response.notification_recipient && response.notification_title) {
        setCompletionFeedback(
          `알림 발송: ${response.notification_recipient} / ${response.notification_title} / ${response.notification_body}`,
        )
      } else if (response.notified_phase_title) {
        setCompletionFeedback(`다음 단계 "${response.notified_phase_title}"는 준비되었지만 자동 알림 대상이 없습니다.`)
      } else {
        setCompletionFeedback('다음 담당자가 없어 자동 알림은 발송되지 않았습니다.')
      }
      if (response.notified_phase_id && normalized.phases.some((phase) => phase.id === response.notified_phase_id)) {
        setSelectedPhaseId(response.notified_phase_id)
      } else if (normalized.phases.some((phase) => phase.id === selectedPhase.id)) {
        setSelectedPhaseId(selectedPhase.id)
      }
      setEditingPhase(false)
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : '단계를 완료 처리하지 못했습니다.')
    } finally {
      setCompletingPhase(false)
    }
  }

  async function handleCreateTemplate() {
    if (!canEdit || !workflow || !selectedCard) {
      return
    }
    const name = templateName.trim()
    if (!name) {
      return
    }
    try {
      const created = await api.createWorkflowTemplate({
        name,
        description: templateDescription.trim(),
        card_type: selectedCard.card_type,
        workflow,
      })
      setTemplates((current) => [created, ...current])
      setWorkflow((current) =>
        current
          ? {
              ...current,
              templateId: created.id,
              templateName: created.name,
            }
          : current,
      )
      setTemplateName('')
      setTemplateDescription('')
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : '템플릿을 저장하지 못했습니다.')
    }
  }

  async function handleOverwriteTemplate(templateId: number) {
    if (!canEdit || !workflow) {
      return
    }
    try {
      const updated = await api.updateWorkflowTemplate(templateId, { workflow })
      setTemplates((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setWorkflow((current) =>
        current
          ? {
              ...current,
              templateId: updated.id,
              templateName: updated.name,
            }
          : current,
      )
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : '템플릿을 수정하지 못했습니다.')
    }
  }

  async function handleRenameTemplate(template: WorkflowTemplate) {
    if (!canEdit) {
      return
    }
    const name = window.prompt('템플릿 이름을 입력하세요.', template.name)
    if (!name) {
      return
    }
    const description = window.prompt('템플릿 설명을 입력하세요.', template.description || '') ?? ''
    try {
      const updated = await api.updateWorkflowTemplate(template.id, { name, description })
      setTemplates((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setWorkflow((current) =>
        current && current.templateId === updated.id ? { ...current, templateName: updated.name } : current,
      )
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : '템플릿 이름을 수정하지 못했습니다.')
    }
  }

  async function handleDeleteTemplate(template: WorkflowTemplate) {
    if (!canEdit || template.is_system) {
      return
    }
    try {
      await api.deleteWorkflowTemplate(template.id)
      setTemplates((current) => current.filter((item) => item.id !== template.id))
      setWorkflow((current) =>
        current && current.templateId === template.id ? { ...current, templateId: null, templateName: '' } : current,
      )
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : '템플릿을 삭제하지 못했습니다.')
    }
  }

  function handleAddBlock(kind: 'target-table' | 'custom-table' | 'note' | 'checklist') {
    if (!canEdit || !workflow || !selectedPhase) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (!phase) {
        return
      }
      let block: WorkflowBlock
      if (kind === 'target-table') {
        block = createTargetTableBlock('장비 목록 실행표', '작업 대상 장비 기준 자동 생성', draft.targets, draft.owner)
      } else if (kind === 'custom-table') {
        block = createCustomTableBlock()
      } else if (kind === 'checklist') {
        block = createChecklistBlock()
      } else {
        block = createNoteBlock()
      }
      phase.blocks.push(block)
    })
    setShowAddOverlay(false)
  }

  function handleToggleBlockEditing(phaseId: string, blockId: string, editing: boolean) {
    if (!canEdit) {
      return
    }
    mutateWorkflow(
      (draft) => {
        const block = findBlock(phaseId, blockId, draft)
        if (block) {
          block.editing = editing
        }
      },
      { touch: !editing },
    )
  }

  function handleDeleteBlock(phaseId: string, blockId: string) {
    if (!canEdit || !workflow) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === phaseId)
      if (!phase || phase.blocks.length <= 1) {
        return
      }
      const index = phase.blocks.findIndex((item) => item.id === blockId)
      if (index >= 0) {
        phase.blocks.splice(index, 1)
      }
    })
  }

  function handleCopyTable(block: WorkflowTableBlock) {
    void copyPlainText(buildTableCopyText(block)).then(
      () => setCopyFeedback('표가 복사되었습니다.'),
      (copyError: unknown) => setError(copyError instanceof Error ? copyError.message : '표를 복사하지 못했습니다.'),
    )
  }

  function handleCycleStatus(phaseId: string, blockId: string, rowIndex: number, columnKey: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      const row = block.rows[rowIndex]
      if (!row) {
        return
      }
      const current = (row[columnKey] || 'not_started') as WorkflowStatus
      row[columnKey] = STATUS_FLOW[(STATUS_FLOW.indexOf(current) + 1) % STATUS_FLOW.length]
      row.completedAt = row[columnKey] === 'done' ? formatWorkflowTimestamp(new Date()) : '-'
    })
  }

  function handleReloadTargets(phaseId: string, blockId: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table' || block.mode !== 'target') {
        return
      }
      Object.assign(block, replaceTargetRows(block, draft.targets, draft.owner))
    })
  }

  function handleAddRow(phaseId: string, blockId: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      block.rows.push(createEmptyRow(block.columns))
    })
  }

  function handleRemoveRow(phaseId: string, blockId: string, rowIndex: number) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table' || block.rows.length <= 1) {
        return
      }
      block.rows.splice(rowIndex, 1)
    })
  }

  function handleAddColumn(phaseId: string, blockId: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      const key = uid('col')
      block.columns.push({
        key,
        label: `컬럼 ${block.columns.length + 1}`,
        type: 'text',
        width: getDefaultColumnWidth({ key, type: 'text' }),
      })
      block.rows = block.rows.map((row) => ({ ...row, [key]: '' }))
    })
  }

  function handleRemoveColumn(phaseId: string, blockId: string, columnKey: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      const column = block.columns.find((item) => item.key === columnKey)
      if (!column) {
        return
      }
      if (column.type === 'status' && block.columns.filter((item) => item.type === 'status').length === 1) {
        return
      }
      block.columns = block.columns.filter((item) => item.key !== columnKey)
      block.rows = block.rows.map((row) => {
        const nextRow = { ...row }
        delete nextRow[columnKey]
        return nextRow
      })
    })
  }

  function handleTableCellChange(phaseId: string, blockId: string, rowIndex: number, columnKey: string, value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      const row = block.rows[rowIndex]
      if (row) {
        row[columnKey] = value
      }
    })
  }

  function handleColumnLabelChange(phaseId: string, blockId: string, columnKey: string, value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'table') {
        return
      }
      const column = block.columns.find((item) => item.key === columnKey)
      if (column) {
        column.label = value
      }
    })
  }

  function handleNoteChange(phaseId: string, blockId: string, value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (block && block.type === 'note') {
        block.content = value
      }
    })
  }

  function handleChecklistTextChange(phaseId: string, blockId: string, itemIndex: number, value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'checklist') {
        return
      }
      const item = block.items[itemIndex]
      if (item) {
        item.text = value
      }
    })
  }

  function handleChecklistAssigneeChange(phaseId: string, blockId: string, itemIndex: number, value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'checklist') {
        return
      }
      const item = block.items[itemIndex]
      if (item) {
        item.assignee = value
      }
    })
  }

  function handleAddChecklistItem(phaseId: string, blockId: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'checklist') {
        return
      }
      block.items.push({ text: '새 체크 항목', done: false, assignee: draft.owner })
    })
  }

  function handleRemoveChecklistItem(phaseId: string, blockId: string, itemIndex: number) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'checklist' || block.items.length <= 1) {
        return
      }
      block.items.splice(itemIndex, 1)
    })
  }

  function handleToggleChecklistItem(phaseId: string, blockId: string, itemIndex: number) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (!block || block.type !== 'checklist') {
        return
      }
      const item = block.items[itemIndex]
      if (item) {
        item.done = !item.done
      }
    })
  }

  function handleUpdateBlockField(phaseId: string, blockId: string, field: 'title' | 'subtitle', value: string) {
    if (!canEdit) {
      return
    }
    mutateWorkflow((draft) => {
      const block = findBlock(phaseId, blockId, draft)
      if (block) {
        block[field] = value
      }
    })
  }

  function handleStageDragStart(phaseId: string) {
    draggedPhaseIdRef.current = phaseId
  }

  function handleStageDrop(targetPhaseId: string) {
    if (!canEdit || !workflow) {
      return
    }
    const draggedPhaseId = draggedPhaseIdRef.current
    if (!draggedPhaseId || draggedPhaseId === targetPhaseId) {
      return
    }
    mutateWorkflow((draft) => {
      const from = draft.phases.findIndex((phase) => phase.id === draggedPhaseId)
      const to = draft.phases.findIndex((phase) => phase.id === targetPhaseId)
      if (from === -1 || to === -1) {
        return
      }
      const [moved] = draft.phases.splice(from, 1)
      draft.phases.splice(to, 0, moved)
    })
  }

  function handleBlockPointerDragStart(blockId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (!canEdit || !selectedPhase || !blockBoardRef.current) {
      return
    }
    if ((event.target as HTMLElement).closest('button,input,textarea,select,label')) {
      return
    }

    const block = selectedPhase.blocks.find((item) => item.id === blockId)
    const header = event.currentTarget
    const card = header.closest('.workflow-block-card') as HTMLElement | null
    const board = blockBoardRef.current
    if (!block || !card || !board) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const blockRect = card.getBoundingClientRect()
    const offsetX = event.clientX - blockRect.left
    const offsetY = event.clientY - blockRect.top
    const others = selectedPhase.blocks
      .filter((item) => item.id !== blockId)
      .map((item) => selectedPhaseLayoutMap.get(item.id) ?? buildBlockLayoutRect(item))
    const widthUnits = clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
    const heightPx = getBlockHeightPx(block.heightPx)
    const rowSpan = getBlockRowSpan(heightPx)
    const currentLayout = selectedPhaseLayoutMap.get(block.id) ?? buildBlockLayoutRect(block)
    const originColumn = currentLayout.column
    const originRow = currentLayout.row

    const applyPreview = (clientX: number, clientY: number) => {
      const boardRect = board.getBoundingClientRect()
      const columnWidth = (boardRect.width - BLOCK_GRID_GAP * (BLOCK_GRID_COLUMNS - 1)) / BLOCK_GRID_COLUMNS
      const cellWidth = columnWidth + BLOCK_GRID_GAP
      const cellHeight = BLOCK_GRID_ROW_HEIGHT + BLOCK_GRID_GAP
      const relativeLeft = clientX - boardRect.left - offsetX
      const relativeTop = clientY - boardRect.top - offsetY
      const targetColumn = clamp(Math.round(relativeLeft / cellWidth) + 1, 1, BLOCK_GRID_COLUMNS - widthUnits + 1)
      const targetRow = Math.max(1, Math.round(relativeTop / cellHeight) + 1)
      const snapped = findNearestFreeLayout(
        {
          id: blockId,
          column: targetColumn,
          row: targetRow,
          widthUnits,
          rowSpan,
        },
        others,
      )

      setBlockDragState({
        blockId,
        originColumn,
        originRow,
        targetColumn: snapped.column,
        targetRow: snapped.row,
        widthUnits,
        heightPx,
        startLeft: blockRect.left,
        startTop: blockRect.top,
        translateX: clientX - offsetX - blockRect.left,
        translateY: clientY - offsetY - blockRect.top,
        offsetX,
        offsetY,
      })
    }

    applyPreview(event.clientX, event.clientY)
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: PointerEvent) => {
      applyPreview(moveEvent.clientX, moveEvent.clientY)
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = ''

      setBlockDragState((currentState) => {
        if (!currentState || currentState.blockId !== blockId) {
          return null
        }
        mutateWorkflow((draft) => {
          const currentBlock = findBlock(selectedPhase.id, blockId, draft)
          if (!currentBlock) {
            return
          }
          currentBlock.layoutColumn = currentState.targetColumn
          currentBlock.layoutRow = currentState.targetRow
        })
        return null
      })

      try {
        header.releasePointerCapture(event.pointerId)
      } catch {
        return
      }
    }

    header.setPointerCapture(event.pointerId)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
    document.addEventListener('pointercancel', onUp, { once: true })
  }

  function handleColumnDragStart(blockId: string, columnKey: string) {
    draggedColumnRef.current = { blockId, columnKey }
  }

  function handleColumnDrop(blockId: string, targetColumnKey: string) {
    if (!canEdit) {
      return
    }
    const dragged = draggedColumnRef.current
    if (!dragged || dragged.blockId !== blockId || dragged.columnKey === targetColumnKey) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhaseId)
      const block = phase?.blocks.find((item) => item.id === blockId)
      if (!block || block.type !== 'table') {
        return
      }
      const from = block.columns.findIndex((column) => column.key === dragged.columnKey)
      const to = block.columns.findIndex((column) => column.key === targetColumnKey)
      if (from === -1 || to === -1) {
        return
      }
      const [moved] = block.columns.splice(from, 1)
      block.columns.splice(to, 0, moved)
    })
  }

  function startBlockResize(blockId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (!canEdit || !workflow || !selectedPhase || !blockBoardRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()

    const card = event.currentTarget.closest('.workflow-block-card') as HTMLDivElement | null
    if (!card) {
      return
    }
    const block = selectedPhase.blocks.find((item) => item.id === blockId)
    if (!block) {
      return
    }

    const boardRect = blockBoardRef.current.getBoundingClientRect()
    const colWidth = (boardRect.width - BLOCK_GRID_GAP * (BLOCK_GRID_COLUMNS - 1)) / BLOCK_GRID_COLUMNS
    const startX = event.clientX
    const startY = event.clientY
    const startSpan = clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
    const startHeight = getBlockHeightPx(block.heightPx)
    const currentLayout = selectedPhaseLayoutMap.get(block.id) ?? buildBlockLayoutRect(block)
    const startColumn = currentLayout.column
    const startRow = currentLayout.row
    const others = selectedPhase.blocks
      .filter((item) => item.id !== blockId)
      .map((item) => selectedPhaseLayoutMap.get(item.id) ?? buildBlockLayoutRect(item))
    const minSpanFromContent = block.type === 'table' ? getMinimumTableSpan(block, colWidth) : MIN_BLOCK_SPAN
    let nextSpan = startSpan
    let nextHeight = startHeight
    let lastGoodSpan = startSpan
    let lastGoodHeight = startHeight
    setResizingBlockId(blockId)

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      const spanDelta = Math.round(dx / (colWidth + BLOCK_GRID_GAP))
      nextSpan = clamp(startSpan + spanDelta, minSpanFromContent, MAX_BLOCK_SPAN)
      nextHeight = Math.max(startHeight + dy, MIN_BLOCK_HEIGHT)
      const candidate = findNearestFreeLayout(
        {
          id: blockId,
          column: startColumn,
          row: startRow,
          widthUnits: nextSpan,
          rowSpan: getBlockRowSpan(nextHeight),
        },
        others,
      )

      if (candidate.column !== startColumn || candidate.row !== startRow) {
        card.classList.add('layout-overlap')
        nextSpan = lastGoodSpan
        nextHeight = lastGoodHeight
        return
      }

      lastGoodSpan = nextSpan
      lastGoodHeight = nextHeight
      card.classList.remove('layout-overlap')
      card.style.gridColumn = `${startColumn} / span ${nextSpan}`
      card.style.gridRow = `${startRow} / span ${getBlockRowSpan(nextHeight)}`
      card.style.height = `${nextHeight}px`
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      card.classList.remove('layout-overlap')
      setResizingBlockId('')
      mutateWorkflow((draft) => {
        const currentBlock = findBlock(selectedPhase.id, blockId, draft)
        if (!currentBlock) {
          return
        }
        currentBlock.widthUnits = lastGoodSpan
        currentBlock.heightPx = lastGoodHeight
      })
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
    document.addEventListener('pointercancel', onUp, { once: true })
  }

  function startColumnResize(blockId: string, columnKey: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (!canEdit || !selectedPhase) {
      return
    }
    event.preventDefault()
    event.stopPropagation()

    const card = event.currentTarget.closest('.workflow-block-card') as HTMLElement | null
    const currentBlock = selectedPhase.blocks.find((item) => item.id === blockId)
    const currentColumn = currentBlock && currentBlock.type === 'table' ? currentBlock.columns.find((item) => item.key === columnKey) : null
    if (!card || !currentBlock || currentBlock.type !== 'table' || !currentColumn) {
      return
    }

    const startX = event.clientX
    const startWidth = currentColumn.width ?? getDefaultColumnWidth(currentColumn)
    let nextWidth = startWidth

    const applyWidth = (width: number) => {
      card.querySelectorAll<HTMLElement>(`col[data-column-key="${columnKey}"]`).forEach((col) => {
        col.style.width = `${width}px`
      })
    }

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX
      nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + dx))
      applyWidth(nextWidth)
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      mutateWorkflow((draft) => {
        const block = findBlock(selectedPhaseId, blockId, draft)
        if (!block || block.type !== 'table') {
          return
        }
        const column = block.columns.find((item) => item.key === columnKey)
        if (column) {
          column.width = nextWidth
        }
      })
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
  }

  function renderBlockBody(phase: WorkflowPhase, block: WorkflowBlock) {
    if (block.type === 'table') {
      return renderTableBlock(phase, block)
    }
    if (block.type === 'note') {
      return renderNoteBlock(phase, block)
    }
    return renderChecklistBlock(phase, block)
  }

  function renderTableBlock(phase: WorkflowPhase, block: WorkflowTableBlock) {
    const statusColumnCount = block.columns.filter((column) => column.type === 'status').length

    return (
      <>
        {block.editing ? (
          <div className="workflow-block-toolbar">
            <div className="workflow-toolbar-group">
              <button
                className="workflow-soft-btn workflow-block-tool-button"
                type="button"
                onClick={() => handleAddRow(phase.id, block.id)}
              >
                행 추가
              </button>
              <button
                className="workflow-soft-btn workflow-block-tool-button"
                type="button"
                onClick={() => handleAddColumn(phase.id, block.id)}
              >
                컬럼 추가
              </button>
              {block.mode === 'target' ? (
                <button
                  className="workflow-soft-btn workflow-block-tool-button"
                  type="button"
                  onClick={() => handleReloadTargets(phase.id, block.id)}
                >
                  장비 동기화
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="workflow-table-wrap">
          <table className="workflow-table">
            <colgroup>
              {block.columns.map((column) => (
                <col key={column.key} data-column-key={column.key} style={{ width: `${column.width ?? getDefaultColumnWidth(column)}px` }} />
              ))}
              {block.editing ? <col style={{ width: '56px' }} /> : null}
            </colgroup>
            <thead>
              <tr>
                {block.columns.map((column) => {
                  const canDelete = !(column.type === 'status' && statusColumnCount === 1)
                  return (
                    <th
                      key={column.key}
                      className={block.editing ? 'workflow-table-head-cell' : undefined}
                      draggable={canEdit && block.editing}
                      onDragStart={(event) => {
                        if ((event.target as HTMLElement).closest('input,button,.workflow-column-resize')) {
                          event.preventDefault()
                          return
                        }
                        handleColumnDragStart(block.id, column.key)
                      }}
                      onDragOver={(event) => {
                        if (canEdit && block.editing) {
                          event.preventDefault()
                        }
                      }}
                      onDrop={() => {
                        if (canEdit && block.editing) {
                          handleColumnDrop(block.id, column.key)
                        }
                      }}
                    >
                      {block.editing ? (
                        <input
                          className="workflow-table-cell-input"
                          value={column.label}
                          onChange={(event) => handleColumnLabelChange(phase.id, block.id, column.key, event.target.value)}
                        />
                      ) : (
                        column.label
                      )}
                      {block.editing ? (
                        <>
                          <div className="workflow-column-tools">
                            <button
                              className="workflow-mini-icon-button workflow-column-delete-button"
                              type="button"
                              onClick={() => handleRemoveColumn(phase.id, block.id, column.key)}
                              disabled={!canDelete}
                              aria-label={`${column.label} 컬럼 삭제`}
                              title={`${column.label} 컬럼 삭제`}
                            >
                              <X size={12} />
                            </button>
                          </div>
                          <div
                            className="workflow-column-resize"
                            onPointerDown={(event) => startColumnResize(block.id, column.key, event)}
                          />
                        </>
                      ) : null}
                    </th>
                  )
                })}
                {block.editing ? <th>관리</th> : null}
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
                          <button
                            className={`workflow-status-chip status-${status}`}
                            type="button"
                            onClick={() => handleCycleStatus(phase.id, block.id, rowIndex, column.key)}
                            disabled={!canEdit}
                          >
                            {STATUS_LABEL[status]}
                          </button>
                        </td>
                      )
                    }

                    if (block.editing) {
                      if (column.type === 'textarea') {
                        return (
                          <td key={column.key}>
                            <textarea
                              className="workflow-table-cell-textarea"
                              rows={2}
                              value={row[column.key] ?? ''}
                              onChange={(event) =>
                                handleTableCellChange(phase.id, block.id, rowIndex, column.key, event.target.value)
                              }
                            />
                          </td>
                        )
                      }

                      return (
                        <td key={column.key}>
                          <input
                            className="workflow-table-cell-input"
                            value={row[column.key] ?? ''}
                            onChange={(event) =>
                              handleTableCellChange(phase.id, block.id, rowIndex, column.key, event.target.value)
                            }
                          />
                        </td>
                      )
                    }

                    return (
                      <td key={column.key}>
                        <div className={`workflow-table-value ${column.key === 'hostname' ? 'is-strong' : ''}`}>
                          {row[column.key] || '-'}
                        </div>
                      </td>
                    )
                  })}
                  {block.editing ? (
                    <td>
                      <button
                        className="workflow-mini-icon-button workflow-row-delete-button"
                        type="button"
                        onClick={() => handleRemoveRow(phase.id, block.id, rowIndex)}
                        aria-label={`행 ${rowIndex + 1} 삭제`}
                        title={`행 ${rowIndex + 1} 삭제`}
                      >
                        <X size={12} />
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    )
  }

  function renderNoteBlock(phase: WorkflowPhase, block: WorkflowNoteBlock) {
    if (block.editing) {
      return (
        <textarea
          className="workflow-note-textarea"
          rows={5}
          value={block.content}
          onChange={(event) => handleNoteChange(phase.id, block.id, event.target.value)}
        />
      )
    }

    return <div className="workflow-note-sheet">{block.content || '메모가 없습니다.'}</div>
  }

  function renderChecklistBlock(phase: WorkflowPhase, block: WorkflowChecklistBlock) {
    return (
      <div className="workflow-checklist-body">
        {block.editing ? (
          <div className="workflow-block-toolbar">
            <div className="workflow-toolbar-group">
              <button
                className="workflow-soft-btn workflow-block-tool-button"
                type="button"
                onClick={() => handleAddChecklistItem(phase.id, block.id)}
              >
                항목 추가
              </button>
            </div>
          </div>
        ) : null}
        <div className="workflow-checklist-items">
          {block.items.map((item, index) => (
            <div key={`${block.id}-${index}`} className={`workflow-check-item ${item.done ? 'done' : ''}`}>
              <button
                className="workflow-check-toggle"
                type="button"
                onClick={() => handleToggleChecklistItem(phase.id, block.id, index)}
                disabled={!canEdit}
              />
              {block.editing ? (
                <>
                  <input
                    className="workflow-check-text-input"
                    value={item.text}
                    onChange={(event) => handleChecklistTextChange(phase.id, block.id, index, event.target.value)}
                  />
                  <input
                    className="workflow-check-assignee-input"
                    value={item.assignee}
                    onChange={(event) => handleChecklistAssigneeChange(phase.id, block.id, index, event.target.value)}
                  />
                  <button
                    className="workflow-mini-icon-button"
                    type="button"
                    onClick={() => handleRemoveChecklistItem(phase.id, block.id, index)}
                    aria-label={`체크 항목 ${index + 1} 삭제`}
                    title={`체크 항목 ${index + 1} 삭제`}
                  >
                    x
                  </button>
                </>
              ) : (
                <>
                  <div className="workflow-check-view-copy">
                    <strong>{item.text}</strong>
                    <span>{item.done ? '완료됨' : '미완료'}</span>
                  </div>
                  <div className="workflow-check-assignee">{item.assignee || '미정'}</div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (loadingCards) {
    return (
      <section className="workflow-shell">
        <div className="workflow-state-panel">
          <strong>전체 진행률</strong>
          <p>워크플로우를 연결할 작업 카드를 준비하고 있습니다.</p>
        </div>
      </section>
    )
  }

  if (!cards.length) {
    return (
      <section className="workflow-shell">
        <div className="workflow-state-panel">
          <strong>전체 진행률</strong>
          <p>먼저 작업 보드에서 카드를 생성해야 워크플로우를 연결할 수 있습니다.</p>
        </div>
      </section>
    )
  }

  return (
    <section className={`workflow-shell ${compactMode ? 'compact' : ''}`}>
      {error ? <div className="workflow-message error">{error}</div> : null}
      {completionFeedback ? <div className="workflow-message success">{completionFeedback}</div> : null}

      {loadingWorkflow || !workflow || !selectedCard ? (
        <div className="workflow-state-panel">
          <strong>전체 진행률</strong>
          <p>선택한 작업 카드의 단계, 블록, 템플릿을 준비하고 있습니다.</p>
        </div>
      ) : (
        <>
          <section className="workflow-hero-grid">
            <article className={`workflow-hero ${compactMode ? 'is-compact' : ''}`}>
              <div className="workflow-hero-top">
                <div className="workflow-hero-main">
                  <h2>{workflow.cardTitle}</h2>
                  <p className="workflow-hero-summary">{workflow.summary}</p>
                </div>

                <div className="workflow-hero-side" ref={cardPickerRef}>
                  <div className="workflow-hero-card-picker">
                    <button
                      className={`workflow-selected-card ${showCardPicker ? 'open' : ''}`}
                      type="button"
                      onClick={() => setShowCardPicker((current) => !current)}
                    >
                      <div>
                        <strong>{selectedCard?.title || '카드를 선택하세요.'}</strong>
                        <span>
                          {selectedCard
                            ? `${selectedCard.card_code} · ${selectedCard.assignee || '담당자 미지정'} · ${(selectedCard.targets ?? []).length} targets`
                            : '워크플로우를 연결할 작업 카드를 선택합니다.'}
                        </span>
                      </div>
                      <Search size={16} />
                    </button>

                    {showCardPicker ? (
                      <div className="workflow-card-picker">
                        <label className="workflow-search-field">
                          <Search size={15} />
                          <input
                            value={cardFilter}
                            onChange={(event) => setCardFilter(event.target.value)}
                            placeholder="카드 제목, 코드, 담당자 검색"
                          />
                        </label>
                        <div className="workflow-card-list">
                          {filteredCards.map((card) => (
                            <button
                              key={card.id}
                              className={`workflow-card-option ${card.id === selectedCardId ? 'active' : ''}`}
                              type="button"
                              onClick={() => void handleSelectCard(card.id)}
                            >
                              <div>
                                <strong>{card.title}</strong>
                                <span>{card.assignee || '담당자 미지정'}</span>
                              </div>
                              <div className="workflow-card-option-meta">
                                <span>{card.card_code}</span>
                                <span>{(card.targets ?? []).length} targets</span>
                              </div>
                            </button>
                          ))}
                          {!filteredCards.length ? (
                            <div className="workflow-card-option empty">
                              <strong>검색 결과가 없습니다.</strong>
                              <span>다른 검색어로 다시 시도해 주세요.</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="workflow-meta-sheet">
                <div className="workflow-meta-row">
                  <span>작업 코드</span>
                  <strong>{workflow.ticketId}</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>프로젝트명</span>
                  <strong>{workflow.projectName}</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>생성자</span>
                  <strong>{workflow.createdBy}</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>마지막 갱신</span>
                  <strong>{workflow.lastUpdated}</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>실 담당자</span>
                  <strong>{workflow.owner}</strong>
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
                          strokeDashoffset:
                            PROGRESS_CIRCUMFERENCE -
                            (PROGRESS_CIRCUMFERENCE * workflowProgress.percent) / 100,
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
                    {workflow.phases.map((phase, index) => {
                      const progress = computePhaseProgress(phase)
                      const phaseAssigneeLabel = getPhaseAssigneeLabel(phase)
                      const phaseIncludedInProgress = isPhaseIncludedInProgress(phase)
                      return (
                        <div key={phase.id} className="workflow-phase-progress-item">
                          <div className="workflow-phase-progress-copy">
                            <div className="workflow-phase-progress-copy-main">
                              <strong>
                                {index + 1}. {phase.title}
                              </strong>
                              <span className="workflow-phase-progress-subcopy">
                                담당: {phaseAssigneeLabel}
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
                       <button className="workflow-ghost-button" type="button" onClick={() => setShowTemplateOverlay(true)}>
                         <LayoutTemplate size={15} />
                         <span>템플릿</span>
                      </button>
                      <span className="workflow-inline-chip">{workflow.templateName || '기본 템플릿'}</span>
                    </div>
                  </div>
                </div>
              <div className="workflow-head-actions">
                <button
                  className={`workflow-ghost-button workflow-compact-toggle ${compactMode ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setCompactMode((current) => !current)}
                  aria-pressed={compactMode}
                >
                  <span>{compactMode ? '기본 보기' : '간소화'}</span>
                </button>
                <button className="workflow-primary-button" type="button" onClick={openPhaseOverlay} disabled={!canEdit}>
                  <Plus size={15} />
                  <span>단계 추가</span>
                </button>
              </div>
            </div>

            <div ref={stageLaneRef} className="workflow-stage-lane">
              {workflow.phases.map((phase, index) => {
                const progress = computePhaseProgress(phase)
                const phaseAssigneeLabel = getPhaseAssigneeLabel(phase)
                return (
                  <div key={phase.id} className="workflow-stage-node">
                    <article
                      className={`workflow-stage-card ${phase.id === selectedPhaseId ? 'active' : ''}`}
                      draggable={canEdit}
                      onClick={() => {
                        setSelectedPhaseId(phase.id)
                        setEditingPhase(false)
                      }}
                      onDragStart={() => handleStageDragStart(phase.id)}
                      onDragOver={(event) => {
                        if (canEdit) {
                          event.preventDefault()
                        }
                      }}
                      onDrop={() => handleStageDrop(phase.id)}
                    >
                      <h4>{phase.title}</h4>
                      <p className="workflow-stage-description">{phase.subtitle}</p>
                      <div className="workflow-stage-meta">
                        <div className="workflow-stage-meta-head">
                          <span className="workflow-stage-text">담당 {phaseAssigneeLabel}</span>
                          <span className="workflow-stage-progress-value">{progress}%</span>
                        </div>
                        <span className="workflow-mini-progress">
                          <span style={{ width: `${progress}%`, background: getProgressColor(progress) }} />
                        </span>
                      </div>
                    </article>
                    {index < workflow.phases.length - 1 ? <div className="workflow-stage-arrow">→</div> : null}
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
                  {!editingPhase ? (
                    <div className="workflow-phase-view">
                      <h3 className="workflow-detail-title">{selectedPhase.title}</h3>
                      <p className="workflow-detail-description">{selectedPhase.subtitle}</p>
                    </div>
                  ) : (
                    <div className="workflow-phase-editor">
                      <input
                        className="workflow-phase-title-input"
                        value={selectedPhase.title}
                        onChange={(event) => handleUpdatePhaseTitle(event.target.value)}
                      />
                      <textarea
                        className="workflow-phase-subtitle-input"
                        rows={2}
                        value={selectedPhase.subtitle}
                        onChange={(event) => handleUpdatePhaseSubtitle(event.target.value)}
                      />
                    </div>
                  )}
                </div>

                <div className="workflow-head-actions workflow-detail-head-actions">
                  {editingPhase ? (
                    <div className="workflow-head-phase-settings">
                      <label className="workflow-field">
                        <span>담당자</span>
                        <select
                          className="workflow-field-select"
                          value={selectedPhase.assigneeUserId ? String(selectedPhase.assigneeUserId) : ''}
                          onChange={(event) => handleUpdatePhaseAssignee(event.target.value)}
                          disabled={!canEdit}
                        >
                          <option value="">미정</option>
                          {selectedPhase.assigneeUserId && !userDirectory.has(selectedPhase.assigneeUserId) ? (
                            <option value={String(selectedPhase.assigneeUserId)}>{getPhaseAssigneeName(selectedPhase)}</option>
                          ) : null}
                          {phaseAssigneeOptions.map((user) => (
                            <option key={user.id} value={String(user.id)}>
                              {user.display_name || user.username}
                              {user.is_active ? '' : ' (비활성)'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="workflow-phase-toggle">
                        <input
                          type="checkbox"
                          checked={isPhaseIncludedInProgress(selectedPhase)}
                          onChange={(event) => handleUpdatePhaseIncludeInProgress(event.target.checked)}
                          disabled={!canEdit}
                        />
                        <span>진행률 반영</span>
                      </label>
                    </div>
                  ) : null}
                  <div className="workflow-head-action-buttons">
                    <button
                      className={`workflow-primary-button workflow-complete-button ${selectedPhase.isCompleted ? 'is-complete' : ''}`}
                      type="button"
                      onClick={() => void handleCompleteSelectedPhase()}
                      disabled={completingPhase || !canCompleteSelectedPhase}
                      title={
                        selectedPhase.isCompleted
                          ? '이 단계는 이미 완료된 상태입니다.'
                          : canCompleteSelectedPhase
                            ? '단계를 완료 처리합니다.'
                            : selectedPhaseProgress < 100
                            ? '진행률이 100%가 되면 완료할 수 있습니다.'
                            : '담당자 또는 admin만 완료할 수 있습니다.'
                      }
                    >
                      <Check size={15} />
                      <span>{selectedPhase.isCompleted ? '완료됨' : completingPhase ? '완료 처리 중...' : '단계 완료'}</span>
                    </button>
                    <button className="workflow-ghost-button" type="button" onClick={() => setShowAddOverlay(true)} disabled={!canEdit}>
                      <Plus size={15} />
                      <span>블록 추가</span>
                    </button>
                    <button className="workflow-icon-button" type="button" onClick={togglePhaseEditing} disabled={!canEdit} aria-label="단계 수정">
                      {editingPhase ? <Check size={15} /> : <Pencil size={15} />}
                    </button>
                    <button
                      className="workflow-icon-button danger"
                      type="button"
                      onClick={handleDeletePhase}
                      disabled={!canEdit || workflow.phases.length <= 1}
                      aria-label="단계 삭제"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="workflow-block-board" ref={blockBoardRef}>
                {selectedPhase.blocks.map((block) => {
                  const blockHeightPx = getBlockHeightPx(block.heightPx)
                  const layout = selectedPhaseLayoutMap.get(block.id) ?? buildBlockLayoutRect(block)
                  const blockColumn = layout.column
                  const blockRow = layout.row
                  const isFloating = blockDragState?.blockId === block.id
                  return (
                    <article
                      key={block.id}
                      data-block-card-id={block.id}
                      className={`workflow-block-card type-${block.type} ${isFloating ? 'is-floating' : ''} ${
                        resizingBlockId === block.id ? 'is-resizing' : ''
                      }`}
                      style={{
                        gridColumn: `${blockColumn} / span ${clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)}`,
                        gridRow: `${blockRow} / span ${getBlockRowSpan(blockHeightPx)}`,
                        height: `${blockHeightPx}px`,
                        transform: isFloating
                          ? `translate3d(${blockDragState?.translateX ?? 0}px, ${blockDragState?.translateY ?? 0}px, 0)`
                          : undefined,
                        zIndex: isFloating ? 30 : undefined,
                      }}
                    >
                      <div
                        className="workflow-block-head"
                        onPointerDown={(event) => handleBlockPointerDragStart(block.id, event)}
                      >
                        <div className="workflow-block-head-left">
                          <span className="workflow-drag-handle">
                            <GripVertical size={16} />
                          </span>
                          <div className="workflow-block-title-wrap">
                            {block.editing ? (
                              <>
                                <input
                                  className="workflow-block-title-input"
                                  value={block.title}
                                  onChange={(event) => handleUpdateBlockField(selectedPhase.id, block.id, 'title', event.target.value)}
                                />
                                <input
                                  className="workflow-block-subtitle-input"
                                  value={block.subtitle}
                                  onChange={(event) => handleUpdateBlockField(selectedPhase.id, block.id, 'subtitle', event.target.value)}
                                />
                              </>
                            ) : (
                              <div className="workflow-block-title-view">
                                <strong>{block.title || '제목 없음'}</strong>
                                {block.subtitle ? <span>{block.subtitle}</span> : null}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="workflow-block-tools">
                          {block.type === 'table' ? (
                            <button
                              className="workflow-copy-button"
                              type="button"
                              onClick={() => handleCopyTable(block)}
                              aria-label={`${block.title} 표 복사`}
                              title={`${block.title} 표 복사`}
                            >
                              <Copy size={14} />
                            </button>
                          ) : null}
                          <button
                            className="workflow-icon-button"
                            type="button"
                            onClick={() => handleToggleBlockEditing(selectedPhase.id, block.id, !block.editing)}
                            disabled={!canEdit}
                            aria-label={block.editing ? '블록 편집 완료' : '블록 편집'}
                          >
                            {block.editing ? <Check size={15} /> : <Pencil size={15} />}
                          </button>
                          <button
                            className="workflow-icon-button danger"
                            type="button"
                            onClick={() => handleDeleteBlock(selectedPhase.id, block.id)}
                            disabled={!canEdit || selectedPhase.blocks.length <= 1}
                            aria-label="블록 삭제"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      <div className={`workflow-block-body type-${block.type} ${block.editing ? 'is-editing' : ''}`}>
                        {renderBlockBody(selectedPhase, block)}
                      </div>

                      {canEdit ? (
                        <div className="workflow-resize-handle" onPointerDown={(event) => startBlockResize(block.id, event)} />
                      ) : null}
                    </article>
                  )
                })}
                {blockDragState &&
                (blockDragState.targetColumn !== blockDragState.originColumn ||
                  blockDragState.targetRow !== blockDragState.originRow) ? (
                  <div
                    className="workflow-block-placeholder"
                    style={{
                      gridColumn: `${blockDragState.targetColumn} / span ${blockDragState.widthUnits}`,
                      gridRow: `${blockDragState.targetRow} / span ${getBlockRowSpan(blockDragState.heightPx)}`,
                      height: `${blockDragState.heightPx}px`,
                    }}
                  />
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      )}

      {showAddOverlay ? (
        <div className="workflow-overlay" onClick={() => setShowAddOverlay(false)}>
          <div className="workflow-overlay-backdrop" />
          <div className="workflow-overlay-panel" onClick={(event) => event.stopPropagation()}>
            <div className="workflow-overlay-head">
              <div>
                <p className="workflow-kicker">Add Block</p>
                <h3>워크스페이스에 추가할 블록을 선택합니다.</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowAddOverlay(false)} aria-label="추가 오버레이 닫기">
                <X size={15} />
              </button>
            </div>
            <div className="workflow-overlay-grid">
              <button className="workflow-overlay-choice" type="button" onClick={() => handleAddBlock('target-table')}>
                <Table2 size={18} />
                <strong>장비 목록 표</strong>
                <span>작업 보드의 대상 장비 기준으로 기본 행을 자동 생성합니다.</span>
              </button>
              <button className="workflow-overlay-choice" type="button" onClick={() => handleAddBlock('custom-table')}>
                <Table2 size={18} />
                <strong>커스텀 표</strong>
                <span>컬럼과 행을 자유롭게 구성할 수 있는 표 블록입니다.</span>
              </button>
              <button className="workflow-overlay-choice" type="button" onClick={() => handleAddBlock('note')}>
                <NotebookPen size={18} />
                <strong>메모 블록</strong>
                <span>특이사항, 승인 조건, 전달 사항을 자유롭게 기록합니다.</span>
              </button>
              <button className="workflow-overlay-choice" type="button" onClick={() => handleAddBlock('checklist')}>
                <ListChecks size={18} />
                <strong>체크리스트</strong>
                <span>간단한 확인 항목과 완료 여부를 단계 안에서 관리합니다.</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showTemplateOverlay ? (
        <div className="workflow-overlay" onClick={() => setShowTemplateOverlay(false)}>
          <div className="workflow-overlay-backdrop" />
          <div className="workflow-overlay-panel workflow-overlay-panel-wide" onClick={(event) => event.stopPropagation()}>
            <div className="workflow-overlay-head">
              <div>
                <p className="workflow-kicker">Template</p>
                <h3>현재 워크플로우를 템플릿으로 저장하고 적용합니다.</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowTemplateOverlay(false)} aria-label="템플릿 오버레이 닫기">
                <X size={15} />
              </button>
            </div>

            <div className="workflow-template-create">
              <div className="workflow-template-create-fields">
                <label className="workflow-field">
                  <span>템플릿 이름</span>
                  <input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="예: 기존 장비 BGP 변경 표준"
                  />
                </label>
                <label className="workflow-field">
                  <span>설명</span>
                  <input
                    value={templateDescription}
                    onChange={(event) => setTemplateDescription(event.target.value)}
                    placeholder="템플릿 설명"
                  />
                </label>
              </div>
              <button className="workflow-primary-button" type="button" onClick={() => void handleCreateTemplate()} disabled={!canEdit}>
                템플릿 저장
              </button>
            </div>

            <div className="workflow-template-list">
              {templates.map((template) => (
                <article key={template.id} className="workflow-template-card">
                  <div className="workflow-template-card-top">
                    <div className="workflow-template-card-copy">
                      <strong>{template.name}</strong>
                      <span>{template.description || '설명이 없습니다.'}</span>
                      <span className="workflow-template-card-meta">
                        {template.card_type === 'existing' ? '기존 장비 작업' : '신규 장비 작업'}
                        {template.is_system ? ' · 시스템 템플릿' : ' · 사용자 템플릿'}
                      </span>
                    </div>
                    {workflow?.templateId === template.id ? <span className="workflow-inline-chip">현재 적용</span> : null}
                  </div>
                  <div className="workflow-template-card-actions">
                    <button className="workflow-soft-btn" type="button" onClick={() => handleApplyTemplate(template)} disabled={!canEdit}>
                      적용
                    </button>
                    <button className="workflow-soft-btn" type="button" onClick={() => void handleOverwriteTemplate(template.id)} disabled={!canEdit}>
                      현재 흐름 저장
                    </button>
                    <button className="workflow-soft-btn" type="button" onClick={() => void handleRenameTemplate(template)} disabled={!canEdit}>
                      이름 수정
                    </button>
                    {!template.is_system ? (
                      <button className="workflow-soft-btn danger" type="button" onClick={() => void handleDeleteTemplate(template)} disabled={!canEdit}>
                        삭제
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showPhaseOverlay ? (
        <div className="workflow-overlay" onClick={() => setShowPhaseOverlay(false)}>
          <div className="workflow-overlay-backdrop" />
          <div className="workflow-overlay-panel" onClick={(event) => event.stopPropagation()}>
            <div className="workflow-overlay-head">
              <div>
                <p className="workflow-kicker">Add Phase</p>
                <h3>새 단계 정보를 입력합니다.</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowPhaseOverlay(false)} aria-label="단계 추가 오버레이 닫기">
                <X size={15} />
              </button>
            </div>

            <div className="workflow-phase-create-fields">
              <label className="workflow-field">
                <span>대제목</span>
                <input
                  value={newPhaseTitle}
                  onChange={(event) => setNewPhaseTitle(event.target.value)}
                  placeholder="예: 특이사항"
                />
              </label>
              <label className="workflow-field">
                <span>소제목</span>
                <input
                  value={newPhaseSubtitle}
                  onChange={(event) => setNewPhaseSubtitle(event.target.value)}
                  placeholder="예: 고객 특이 절차나 별도 승인 흐름을 적습니다."
                />
              </label>
              <label className="workflow-field">
                <span>담당자</span>
                <select
                  className="workflow-field-select"
                  value={newPhaseAssigneeUserId}
                  onChange={(event) => setNewPhaseAssigneeUserId(event.target.value)}
                >
                  <option value="">미정</option>
                  {phaseAssigneeOptions.map((user) => (
                    <option key={user.id} value={String(user.id)}>
                      {user.display_name || user.username}
                      {user.is_active ? '' : ' (비활성)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="workflow-phase-toggle">
                <input
                  type="checkbox"
                  checked={newPhaseIncludeInProgress}
                  onChange={(event) => setNewPhaseIncludeInProgress(event.target.checked)}
                />
                <span>진행률 반영</span>
              </label>
            </div>

            <div className="workflow-overlay-actions">
              <button className="workflow-ghost-button" type="button" onClick={() => setShowPhaseOverlay(false)}>
                취소
              </button>
              <button className="workflow-primary-button" type="button" onClick={handleAddPhase} disabled={!newPhaseTitle.trim()}>
                단계 생성
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function formatWorkflowTimestamp(date: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
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
  return `${cleaned.slice(0, 2).join(', ')}, ...`
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



