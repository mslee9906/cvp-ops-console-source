import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'
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

const BLOCK_GRID_GAP = 8
const BLOCK_GRID_ROW_HEIGHT = 4

function getBlockHeightPx(heightPx?: number) {
  return Math.max(heightPx ?? DEFAULT_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT)
}

function getBlockRowSpan(heightPx?: number) {
  return Math.max(1, Math.ceil((getBlockHeightPx(heightPx) + BLOCK_GRID_GAP) / (BLOCK_GRID_ROW_HEIGHT + BLOCK_GRID_GAP)))
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
  const draggedBlockIdRef = useRef<string | null>(null)
  const draggedColumnRef = useRef<DraggedColumn | null>(null)
  const pendingFocusPhaseIdRef = useRef<string>('')
  const stageLaneRef = useRef<HTMLDivElement | null>(null)
  const stageLaneScrollTargetRef = useRef(0)
  const stageLaneScrollFrameRef = useRef<number | null>(null)

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

    stageLaneScrollTargetRef.current = container.scrollLeft

    const animateScroll = () => {
      const stageLane = stageLaneRef.current
      if (!stageLane) {
        stageLaneScrollFrameRef.current = null
        return
      }

      const delta = stageLaneScrollTargetRef.current - stageLane.scrollLeft
      if (Math.abs(delta) < 1) {
        stageLane.scrollLeft = stageLaneScrollTargetRef.current
        stageLaneScrollFrameRef.current = null
        return
      }

      stageLane.scrollLeft += delta * 0.18
      stageLaneScrollFrameRef.current = window.requestAnimationFrame(animateScroll)
    }

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return
      }

      const maxScrollLeft = container.scrollWidth - container.clientWidth
      if (maxScrollLeft <= 0) {
        return
      }

      const firstNode = container.querySelector<HTMLElement>('.workflow-stage-node')
      const laneStyle = window.getComputedStyle(container)
      const laneGap = Number.parseFloat(laneStyle.columnGap || laneStyle.gap || '0') || 0
      const scrollStep = Math.max((firstNode?.getBoundingClientRect().width ?? 248) + laneGap, 220)
      const direction = event.deltaY > 0 ? 1 : -1

      event.preventDefault()
      stageLaneScrollTargetRef.current = Math.max(
        0,
        Math.min(maxScrollLeft, stageLaneScrollTargetRef.current + direction * scrollStep),
      )

      if (stageLaneScrollFrameRef.current === null) {
        stageLaneScrollFrameRef.current = window.requestAnimationFrame(animateScroll)
      }
    }

    const handleScroll = () => {
      if (stageLaneScrollFrameRef.current === null) {
        stageLaneScrollTargetRef.current = container.scrollLeft
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    container.addEventListener('scroll', handleScroll)

    return () => {
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('scroll', handleScroll)
      if (stageLaneScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(stageLaneScrollFrameRef.current)
        stageLaneScrollFrameRef.current = null
      }
    }
  }, [workflow?.phases.length])

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

  function buildPhaseAssignee(userId: number | null, fallback = '誘몄젙') {
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
      setError(loadError instanceof Error ? loadError.message : '?묒뾽 移대뱶瑜?遺덈윭?ㅼ? 紐삵뻽?듬땲??')
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
        setError('?뚰겕?뚮줈??臾몄꽌瑜?遺덈윭?ㅼ? 紐삵뻽?듬땲??')
      } else {
        setError(loadError instanceof Error ? loadError.message : '?뚰겕?뚮줈?곕? 遺덈윭?ㅼ? 紐삵뻽?듬땲??')
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
      setError(saveError instanceof Error ? saveError.message : '?뚰겕?뚮줈?곕? ??ν븯吏 紐삵뻽?듬땲??')
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
      blocks: [createNoteBlock('硫붾え 釉붾줉', '???④퀎??湲곕낯 硫붾え', '')],
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
          `?뚮┝ 諛쒖넚: ${response.notification_recipient} / ${response.notification_title} / ${response.notification_body}`,
        )
      } else if (response.notified_phase_title) {
        setCompletionFeedback(`?ㅼ쓬 ?④퀎 "${response.notified_phase_title}"??以鍮꾨릺?덉?留??먮룞 ?뚮┝ ??곸? ?놁뒿?덈떎.`)
      } else {
        setCompletionFeedback('?ㅼ쓬 ?대떦?먭? ?놁뼱 ?먮룞 ?뚮┝? 諛쒖넚?섏? ?딆븯?듬땲??')
      }
      if (response.notified_phase_id && normalized.phases.some((phase) => phase.id === response.notified_phase_id)) {
        setSelectedPhaseId(response.notified_phase_id)
      } else if (normalized.phases.some((phase) => phase.id === selectedPhase.id)) {
        setSelectedPhaseId(selectedPhase.id)
      }
      setEditingPhase(false)
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : '?④퀎瑜??꾨즺 泥섎━?섏? 紐삵뻽?듬땲??')
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
      setError(templateError instanceof Error ? templateError.message : '?쒗뵆由우쓣 ??ν븯吏 紐삵뻽?듬땲??')
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
      setError(templateError instanceof Error ? templateError.message : '?쒗뵆由우쓣 ?섏젙?섏? 紐삵뻽?듬땲??')
    }
  }

  async function handleRenameTemplate(template: WorkflowTemplate) {
    if (!canEdit) {
      return
    }
    const name = window.prompt('?쒗뵆由??대쫫???낅젰?섏꽭??', template.name)
    if (!name) {
      return
    }
    const description = window.prompt('?쒗뵆由??ㅻ챸???낅젰?섏꽭??', template.description || '') ?? ''
    try {
      const updated = await api.updateWorkflowTemplate(template.id, { name, description })
      setTemplates((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setWorkflow((current) =>
        current && current.templateId === updated.id ? { ...current, templateName: updated.name } : current,
      )
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : '?쒗뵆由??대쫫???섏젙?섏? 紐삵뻽?듬땲??')
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
      setError(templateError instanceof Error ? templateError.message : '?쒗뵆由우쓣 ??젣?섏? 紐삵뻽?듬땲??')
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
      () => setCopyFeedback('?쒕? 蹂듭궗?덉뒿?덈떎.'),
      (copyError: unknown) => setError(copyError instanceof Error ? copyError.message : '?쒕? 蹂듭궗?섏? 紐삵뻽?듬땲??'),
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
        label: `而щ읆 ${block.columns.length + 1}`,
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
      block.items.push({ text: '??泥댄겕 ??ぉ', done: false, assignee: draft.owner })
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

  function handleBlockDragStart(blockId: string) {
    draggedBlockIdRef.current = blockId
  }

  function handleBlockDrop(targetBlockId: string) {
    if (!canEdit || !workflow || !selectedPhase) {
      return
    }
    const draggedBlockId = draggedBlockIdRef.current
    if (!draggedBlockId || draggedBlockId === targetBlockId) {
      return
    }
    mutateWorkflow((draft) => {
      const phase = draft.phases.find((item) => item.id === selectedPhase.id)
      if (!phase) {
        return
      }
      const from = phase.blocks.findIndex((block) => block.id === draggedBlockId)
      const to = phase.blocks.findIndex((block) => block.id === targetBlockId)
      if (from === -1 || to === -1) {
        return
      }
      const [moved] = phase.blocks.splice(from, 1)
      phase.blocks.splice(to, 0, moved)
    })
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
    const colWidth = (boardRect.width - BLOCK_GRID_GAP * 11) / 12
    const startX = event.clientX
    const startY = event.clientY
    const startSpan = block.widthUnits ?? 6
    const startHeight = block.heightPx ?? DEFAULT_BLOCK_HEIGHT
    let nextSpan = startSpan
    let nextHeight = startHeight

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      const spanDelta = Math.round(dx / (colWidth + BLOCK_GRID_GAP))
      nextSpan = clamp(startSpan + spanDelta, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)
      nextHeight = Math.max(startHeight + dy, MIN_BLOCK_HEIGHT)
      card.style.gridColumn = `span ${nextSpan}`
      card.style.gridRow = `span ${getBlockRowSpan(nextHeight)}`
      card.style.height = `${nextHeight}px`
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      mutateWorkflow((draft) => {
        const currentBlock = findBlock(selectedPhase.id, blockId, draft)
        if (!currentBlock) {
          return
        }
        currentBlock.widthUnits = nextSpan
        currentBlock.heightPx = nextHeight
      })
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
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
              <button className="workflow-soft-btn" type="button" onClick={() => handleAddRow(phase.id, block.id)}>
                ??異붽?
              </button>
              <button className="workflow-soft-btn" type="button" onClick={() => handleAddColumn(phase.id, block.id)}>
                而щ읆 異붽?
              </button>
              {block.mode === 'target' ? (
                <button className="workflow-soft-btn" type="button" onClick={() => handleReloadTargets(phase.id, block.id)}>
                  ?λ퉬 紐⑸줉 ?ㅼ떆 媛?몄삤湲?                </button>
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
                              className="workflow-mini-icon-button"
                              type="button"
                              onClick={() => handleRemoveColumn(phase.id, block.id, column.key)}
                              disabled={!canDelete}
                              aria-label={`${column.label} 而щ읆 ??젣`}
                              title={`${column.label} 而щ읆 ??젣`}
                            >
                              ??                            </button>
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
                        className="workflow-mini-icon-button"
                        type="button"
                        onClick={() => handleRemoveRow(phase.id, block.id, rowIndex)}
                        aria-label={`??${rowIndex + 1} ??젣`}
                        title={`??${rowIndex + 1} ??젣`}
                      >
                        ??                      </button>
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
          rows={9}
          value={block.content}
          onChange={(event) => handleNoteChange(phase.id, block.id, event.target.value)}
        />
      )
    }

    return <div className="workflow-note-sheet">{block.content || '硫붾え媛 ?놁뒿?덈떎.'}</div>
  }

  function renderChecklistBlock(phase: WorkflowPhase, block: WorkflowChecklistBlock) {
    return (
      <div className="workflow-checklist-body">
        {block.editing ? (
          <div className="workflow-block-toolbar">
            <div className="workflow-toolbar-group">
              <button className="workflow-soft-btn" type="button" onClick={() => handleAddChecklistItem(phase.id, block.id)}>
                ??ぉ 異붽?
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
                    aria-label={`泥댄겕 ??ぉ ${index + 1} ??젣`}
                    title={`泥댄겕 ??ぉ ${index + 1} ??젣`}
                  >
                    ??                  </button>
                </>
              ) : (
                <>
                  <div className="workflow-check-view-copy">
                    <strong>{item.text}</strong>
                    <span>{item.done ? '완료됨' : '미완료'}</span>
                  </div>
                  <div className="workflow-check-assignee">{item.assignee || '誘몄젙'}</div>
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
          <p>?뚰겕?뚮줈?곕? ?곌껐???묒뾽 移대뱶瑜?以鍮꾪븯怨??덉뒿?덈떎.</p>
        </div>
      </section>
    )
  }

  if (!cards.length) {
    return (
      <section className="workflow-shell">
        <div className="workflow-state-panel">
          <strong>전체 진행률</strong>
          <p>癒쇱? ?묒뾽 蹂대뱶?먯꽌 移대뱶瑜??앹꽦?????뚰겕?뚮줈?곕? ?곌껐?????덉뒿?덈떎.</p>
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
          <p>?좏깮???묒뾽 移대뱶???④퀎, 釉붾줉, ?쒗뵆由우쓣 以鍮꾪븯怨??덉뒿?덈떎.</p>
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
                        <strong>{selectedCard?.title || '카드를 선택하세요'}</strong>
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
                                <strong>전체 진행률</strong>
                                <span>템플릿</span>
                              </div>
                              <div className="workflow-card-option-meta">
                                <span>템플릿</span>
                                <span>템플릿</span>
                              </div>
                            </button>
                          ))}
                          {!filteredCards.length ? (
                            <div className="workflow-card-option empty">
                              <strong>전체 진행률</strong>
                              <span>템플릿</span>
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
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
                </div>
                <div className="workflow-meta-row">
                  <span>템플릿</span>
                  <strong>전체 진행률</strong>
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
                      <strong>전체 진행률</strong>
                    </div>
                  </div>
                  <div className="workflow-progress-caption">전체 진행률</div>
                  <div className="workflow-progress-meta">
                    {workflowProgress.done}媛??꾨즺 / {workflowProgress.total}媛??꾩껜 ??ぉ
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
                                ?대떦: {phaseAssigneeLabel}
                                {phaseIncludedInProgress ? ' 쨌 吏꾪뻾瑜?諛섏쁺' : ' 쨌 吏꾪뻾瑜??쒖쇅'}
                              </span>
                            </div>
                            <span>템플릿</span>
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
                    {workflowProgress.done}媛??꾨즺 / {workflowProgress.total}媛??꾩껜 ??ぉ
                    {hasExcludedPhases ? ' 쨌 吏꾪뻾瑜?諛섏쁺 ?④퀎留?吏묎퀎' : ''}
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
                          <option value="">誘몄젙</option>
                          {selectedPhase.assigneeUserId && !userDirectory.has(selectedPhase.assigneeUserId) ? (
                            <option value={String(selectedPhase.assigneeUserId)}>{getPhaseAssigneeName(selectedPhase)}</option>
                          ) : null}
                          {phaseAssigneeOptions.map((user) => (
                            <option key={user.id} value={String(user.id)}>
                              {user.display_name || user.username}
                              {user.is_active ? '' : ' (鍮꾪솢??'}
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
                        <span>템플릿</span>
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
                          ? '?대? ?꾨즺???④퀎?낅땲??'
                          : canCompleteSelectedPhase
                            ? '?④퀎瑜??꾨즺 泥섎━?⑸땲??'
                            : selectedPhaseProgress < 100
                            ? '吏꾪뻾瑜?100%媛 ?섎㈃ ?꾨즺?????덉뒿?덈떎.'
                            : '?대떦???먮뒗 admin留??꾨즺?????덉뒿?덈떎.'
                      }
                    >
                      <Check size={15} />
                      <span>{selectedPhase.isCompleted ? '완료됨' : completingPhase ? '완료 처리 중...' : '단계 완료'}</span>
                    </button>
                    <button className="workflow-ghost-button" type="button" onClick={() => setShowAddOverlay(true)} disabled={!canEdit}>
                      <Plus size={15} />
                      <span>템플릿</span>
                    </button>
                    <button className="workflow-icon-button" type="button" onClick={togglePhaseEditing} disabled={!canEdit} aria-label="?④퀎 ?섏젙">
                      {editingPhase ? <Check size={15} /> : <Pencil size={15} />}
                    </button>
                    <button
                      className="workflow-icon-button danger"
                      type="button"
                      onClick={handleDeletePhase}
                      disabled={!canEdit || workflow.phases.length <= 1}
                      aria-label="?④퀎 ??젣"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="workflow-block-board" ref={blockBoardRef}>
                {selectedPhase.blocks.map((block) => {
                  const blockHeightPx = getBlockHeightPx(block.heightPx)
                  return (
                    <article
                      key={block.id}
                      className="workflow-block-card"
                      style={{
                        gridColumn: `span ${clamp(block.widthUnits ?? 6, MIN_BLOCK_SPAN, MAX_BLOCK_SPAN)}`,
                        gridRow: `span ${getBlockRowSpan(blockHeightPx)}`,
                        height: `${blockHeightPx}px`,
                      }}
                      onDragOver={(event) => {
                        if (canEdit) {
                          event.preventDefault()
                        }
                      }}
                      onDrop={() => handleBlockDrop(block.id)}
                    >
                      <div
                        className="workflow-block-head"
                        draggable={canEdit}
                        onDragStart={(event: ReactDragEvent<HTMLDivElement>) => {
                          if ((event.target as HTMLElement).closest('button,input,textarea')) {
                            event.preventDefault()
                            return
                          }
                          handleBlockDragStart(block.id)
                        }}
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
                                <strong>전체 진행률</strong>
                                <span>템플릿</span>
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
                              aria-label={`${block.title} ??蹂듭궗`}
                              title={`${block.title} ??蹂듭궗`}
                            >
                              <Copy size={14} />
                            </button>
                          ) : null}
                          <span className={`workflow-block-type type-${block.type}`}>
                            {block.type === 'table' ? '??釉붾줉' : block.type === 'note' ? '硫붾え 釉붾줉' : '泥댄겕由ъ뒪??釉붾줉'}
                          </span>
                          <button
                            className="workflow-icon-button"
                            type="button"
                            onClick={() => handleToggleBlockEditing(selectedPhase.id, block.id, !block.editing)}
                            disabled={!canEdit}
                            aria-label={block.editing ? '釉붾줉 ?몄쭛 ?꾨즺' : '釉붾줉 ?몄쭛'}
                          >
                            {block.editing ? <Check size={15} /> : <Pencil size={15} />}
                          </button>
                          <button
                            className="workflow-icon-button danger"
                            type="button"
                            onClick={() => handleDeleteBlock(selectedPhase.id, block.id)}
                            disabled={!canEdit || selectedPhase.blocks.length <= 1}
                            aria-label="釉붾줉 ??젣"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      <div className="workflow-block-body">{renderBlockBody(selectedPhase, block)}</div>

                      {canEdit ? (
                        <div className="workflow-resize-handle" onPointerDown={(event) => startBlockResize(block.id, event)} />
                      ) : null}
                    </article>
                  )
                })}
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
                <h3>?뚰겕?ㅽ럹?댁뒪??異붽???釉붾줉???좏깮?⑸땲??</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowAddOverlay(false)} aria-label="異붽? ?ㅻ쾭?덉씠 ?リ린">
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
                <h3>?꾩옱 ?뚰겕?뚮줈?곕? ?쒗뵆由우쑝濡???ν븯怨??곸슜?⑸땲??</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowTemplateOverlay(false)} aria-label="?쒗뵆由??ㅻ쾭?덉씠 ?リ린">
                <X size={15} />
              </button>
            </div>

            <div className="workflow-template-create">
              <div className="workflow-template-create-fields">
                <label className="workflow-field">
                  <span>템플릿</span>
                  <input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="카드 제목, 코드, 담당자 검색"
                  />
                </label>
                <label className="workflow-field">
                  <span>템플릿</span>
                  <input
                    value={templateDescription}
                    onChange={(event) => setTemplateDescription(event.target.value)}
                    placeholder="카드 제목, 코드, 담당자 검색"
                  />
                </label>
              </div>
              <button className="workflow-primary-button" type="button" onClick={() => void handleCreateTemplate()} disabled={!canEdit}>
                ?쒗뵆由????              </button>
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
                    {workflow?.templateId === template.id ? <span className="workflow-inline-chip">?꾩옱 ?곸슜</span> : null}
                  </div>
                  <div className="workflow-template-card-actions">
                    <button className="workflow-soft-btn" type="button" onClick={() => handleApplyTemplate(template)} disabled={!canEdit}>
                      ?곸슜
                    </button>
                    <button className="workflow-soft-btn" type="button" onClick={() => void handleOverwriteTemplate(template.id)} disabled={!canEdit}>
                      ?꾩옱 ?먮쫫 ???                    </button>
                    <button className="workflow-soft-btn" type="button" onClick={() => void handleRenameTemplate(template)} disabled={!canEdit}>
                      ?대쫫 ?섏젙
                    </button>
                    {!template.is_system ? (
                      <button className="workflow-soft-btn danger" type="button" onClick={() => void handleDeleteTemplate(template)} disabled={!canEdit}>
                        ??젣
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
                <h3>???④퀎 ?뺣낫瑜??낅젰?⑸땲??</h3>
              </div>
              <button className="workflow-icon-button" type="button" onClick={() => setShowPhaseOverlay(false)} aria-label="?④퀎 異붽? ?ㅻ쾭?덉씠 ?リ린">
                <X size={15} />
              </button>
            </div>

            <div className="workflow-phase-create-fields">
              <label className="workflow-field">
                <span>템플릿</span>
                <input
                  value={newPhaseTitle}
                  onChange={(event) => setNewPhaseTitle(event.target.value)}
                  placeholder="카드 제목, 코드, 담당자 검색"
                />
              </label>
              <label className="workflow-field">
                <span>소제목</span>
                <input
                  value={newPhaseSubtitle}
                  onChange={(event) => setNewPhaseSubtitle(event.target.value)}
                  placeholder="카드 제목, 코드, 담당자 검색"
                />
              </label>
              <label className="workflow-field">
                <span>담당자</span>
                <select
                  className="workflow-field-select"
                  value={newPhaseAssigneeUserId}
                  onChange={(event) => setNewPhaseAssigneeUserId(event.target.value)}
                >
                  <option value="">誘몄젙</option>
                  {phaseAssigneeOptions.map((user) => (
                    <option key={user.id} value={String(user.id)}>
                      {user.display_name || user.username}
                      {user.is_active ? '' : ' (鍮꾪솢??'}
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
                <span>템플릿</span>
              </label>
            </div>

            <div className="workflow-overlay-actions">
              <button className="workflow-ghost-button" type="button" onClick={() => setShowPhaseOverlay(false)}>
                痍⑥냼
              </button>
              <button className="workflow-primary-button" type="button" onClick={handleAddPhase} disabled={!newPhaseTitle.trim()}>
                ?④퀎 ?앹꽦
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
    return '誘몄젙'
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



