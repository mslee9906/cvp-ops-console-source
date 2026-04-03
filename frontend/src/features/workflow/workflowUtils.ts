import type {
  KanbanCard,
  WorkflowBlock,
  WorkflowChecklistBlock,
  WorkflowChecklistItem,
  WorkflowDocument,
  WorkflowNoteBlock,
  WorkflowPhase,
  WorkflowStatus,
  WorkflowTableBlock,
  WorkflowTableColumn,
  WorkflowTemplate,
} from '../../types'

export const STATUS_FLOW: WorkflowStatus[] = ['not_started', 'in_progress', 'done', 'blocked', 'n_a']

export const STATUS_LABEL: Record<WorkflowStatus, string> = {
  not_started: '대기',
  in_progress: '진행',
  done: '완료',
  blocked: '차단',
  n_a: '해당없음',
}

export const MIN_BLOCK_SPAN = 3
export const MAX_BLOCK_SPAN = 12
export const MIN_BLOCK_HEIGHT = 180
export const DEFAULT_BLOCK_HEIGHT = 220
export const MIN_COLUMN_WIDTH = 88
export const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * 46

export function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function getDefaultColumnWidth(column: Pick<WorkflowTableColumn, 'key' | 'type'>) {
  if (column.type === 'status') return 96
  if (column.type === 'textarea') return 220
  if (column.key === 'hostname') return 132
  if (column.key === 'completedAt') return 144
  if (column.key === 'assignee') return 120
  if (column.key === 'work') return 190
  return 150
}

export function createEmptyRow(columns: WorkflowTableColumn[]) {
  return columns.reduce<Record<string, string>>((row, column) => {
    row[column.key] = column.type === 'status' ? 'not_started' : ''
    return row
  }, {})
}

export function createTargetTableBlock(
  title: string,
  subtitle: string,
  targets: string[],
  owner: string,
  seedRows?: Array<Record<string, string>>,
): WorkflowTableBlock {
  const columns: WorkflowTableColumn[] = [
    { key: 'hostname', label: 'Hostname', type: 'text', width: getDefaultColumnWidth({ key: 'hostname', type: 'text' }) },
    { key: 'work', label: '작업 항목', type: 'text', width: getDefaultColumnWidth({ key: 'work', type: 'text' }) },
    { key: 'status', label: '상태', type: 'status', width: getDefaultColumnWidth({ key: 'status', type: 'status' }) },
    { key: 'assignee', label: '담당자', type: 'text', width: getDefaultColumnWidth({ key: 'assignee', type: 'text' }) },
    { key: 'note', label: '메모', type: 'textarea', width: getDefaultColumnWidth({ key: 'note', type: 'textarea' }) },
    { key: 'completedAt', label: '완료 시각', type: 'text', width: getDefaultColumnWidth({ key: 'completedAt', type: 'text' }) },
  ]

  const baseRows =
    seedRows ??
    targets.map((hostname) => ({
      hostname,
      work: '',
      status: 'not_started',
      assignee: owner || '미정',
      note: '',
      completedAt: '-',
    }))

  return {
    id: uid('table'),
    type: 'table',
    mode: 'target',
    title,
    subtitle,
    editing: false,
    size: 'full',
    widthUnits: 12,
    heightPx: 240,
    columns,
    rows: replaceTargetRows(
      {
        id: uid('table-base'),
        type: 'table',
        mode: 'target',
        title,
        subtitle,
        editing: false,
        size: 'full',
        widthUnits: 12,
        heightPx: 240,
        columns,
        rows: baseRows,
      },
      targets,
      owner,
    ).rows,
  }
}

export function createCustomTableBlock(): WorkflowTableBlock {
  const columns: WorkflowTableColumn[] = [
    { key: uid('col'), label: '구분', type: 'text', width: getDefaultColumnWidth({ key: 'kind', type: 'text' }) },
    { key: uid('col'), label: '내용', type: 'text', width: getDefaultColumnWidth({ key: 'content', type: 'text' }) },
    { key: uid('status'), label: '상태', type: 'status', width: getDefaultColumnWidth({ key: 'status', type: 'status' }) },
    { key: uid('col'), label: '담당자', type: 'text', width: getDefaultColumnWidth({ key: 'assignee', type: 'text' }) },
    { key: uid('col'), label: '메모', type: 'textarea', width: getDefaultColumnWidth({ key: 'note', type: 'textarea' }) },
  ]

  return {
    id: uid('table'),
    type: 'table',
    mode: 'custom',
    title: '커스텀 표',
    subtitle: '컬럼과 행을 자유롭게 수정할 수 있습니다.',
    editing: true,
    size: 'wide',
    widthUnits: 8,
    heightPx: 220,
    columns,
    rows: [createEmptyRow(columns)],
  }
}

export function createNoteBlock(title = '메모 블록', subtitle = '자유 메모 블록', content = ''): WorkflowNoteBlock {
  return {
    id: uid('note'),
    type: 'note',
    title,
    subtitle,
    editing: true,
    size: 'regular',
    widthUnits: 6,
    heightPx: 230,
    content,
  }
}

export function createChecklistBlock(
  title = '체크리스트 블록',
  subtitle = '확인 항목 관리',
  items?: WorkflowChecklistItem[],
): WorkflowChecklistBlock {
  return {
    id: uid('check'),
    type: 'checklist',
    title,
    subtitle,
    editing: true,
    size: 'regular',
    widthUnits: 6,
    heightPx: 220,
    items:
      items ??
      [
        { text: '추가 확인 항목 1', done: false, assignee: '미정' },
        { text: '추가 확인 항목 2', done: false, assignee: '미정' },
      ],
  }
}

export function ensureStatusColumn(block: WorkflowBlock): WorkflowBlock {
  if (block.type !== 'table') {
    return block
  }

  const nextBlock = cloneValue(block)
  const hasStatus = nextBlock.columns.some((column) => column.type === 'status')
  if (!hasStatus) {
    nextBlock.columns.splice(Math.min(2, nextBlock.columns.length), 0, {
      key: uid('status'),
      label: '상태',
      type: 'status',
      width: 96,
    })
  }

  nextBlock.columns = nextBlock.columns.map((column) => ({
    ...column,
    width: column.width ?? getDefaultColumnWidth(column),
  }))

  nextBlock.rows = nextBlock.rows.map((row) => {
    const nextRow = { ...row }
    nextBlock.columns.forEach((column) => {
      if (nextRow[column.key] === undefined) {
        nextRow[column.key] = column.type === 'status' ? 'not_started' : ''
      }
    })
    return nextRow
  })

  return nextBlock
}

export function replaceTargetRows(block: WorkflowTableBlock, targets: string[], owner: string): WorkflowTableBlock {
  const hostnameKey = block.columns.find((column) => column.key === 'hostname')?.key ?? block.columns[0]?.key ?? 'hostname'
  const assigneeKey = block.columns.find((column) => column.key === 'assignee')?.key ?? 'assignee'
  const completedAtKey = block.columns.find((column) => column.key === 'completedAt')?.key ?? 'completedAt'
  const statusKey = block.columns.find((column) => column.type === 'status')?.key ?? 'status'

  const rows = targets.map((hostname) => {
    const existing = block.rows.find((row) => String(row[hostnameKey] ?? '').trim().toLowerCase() === hostname.trim().toLowerCase())
    const row = createEmptyRow(block.columns)
    row[hostnameKey] = hostname
    if (existing) {
      block.columns.forEach((column) => {
        const value = existing[column.key]
        if (column.key !== hostnameKey && value !== undefined && value !== '') {
          row[column.key] = value
        }
      })
    }
    row[statusKey] = row[statusKey] || 'not_started'
    row[assigneeKey] = row[assigneeKey] || owner || '미정'
    row[completedAtKey] = row[completedAtKey] || '-'
    return row
  })

  return {
    ...block,
    rows: rows.length > 0 ? rows : [createEmptyRow(block.columns)],
  }
}

export function getPhaseAssigneeName(phase: Partial<WorkflowPhase>, fallback = '미정') {
  return String(phase.assigneeName ?? '').trim() || fallback
}

export function isPhaseIncludedInProgress(phase: Partial<WorkflowPhase>) {
  return phase.includeInProgress !== false
}

export function reconcilePhaseCompletion(phase: WorkflowPhase): WorkflowPhase {
  if (computePhaseProgress(phase) >= 100) {
    phase.completedAt = String(phase.completedAt ?? '')
    phase.completedByUserId = typeof phase.completedByUserId === 'number' ? phase.completedByUserId : null
    phase.completedByName = String(phase.completedByName ?? '')
    return phase
  }
  phase.isCompleted = false
  phase.completedAt = ''
  phase.completedByUserId = null
  phase.completedByName = ''
  return phase
}

export function normalizeWorkflowDocument(workflow: WorkflowDocument, card: KanbanCard): WorkflowDocument {
  const owner = workflow.owner || card.assignee || '미정'
  const targets = (card.targets ?? []).map((target) => target.display_name).filter(Boolean)
  const normalizedPhases = (workflow.phases ?? []).map((phase) => ({
    ...phase,
    assigneeUserId: typeof phase.assigneeUserId === 'number' ? phase.assigneeUserId : null,
    assigneeName: getPhaseAssigneeName(phase),
    includeInProgress: isPhaseIncludedInProgress(phase),
    isCompleted: phase.isCompleted === true,
    completedAt: String(phase.completedAt ?? ''),
    completedByUserId: typeof phase.completedByUserId === 'number' ? phase.completedByUserId : null,
    completedByName: String(phase.completedByName ?? ''),
    blocks: (phase.blocks ?? []).map((block) => {
      const normalizedBlock = ensureStatusColumn(block)
      if (normalizedBlock.type === 'table' && normalizedBlock.mode === 'target') {
        return replaceTargetRows(normalizedBlock, targets.length > 0 ? targets : ['미정'], owner)
      }
      return normalizedBlock
    }),
  })).map((phase) => reconcilePhaseCompletion(phase))

  return {
    ...workflow,
    ticketId: card.card_code,
    cardTitle: card.title,
    projectName: workflow.projectName || card.title,
    summary: workflow.summary || card.description || '작업 보드 카드 기반 워크플로우입니다.',
    grade: workflow.grade || 'B',
    owner,
    createdBy: workflow.createdBy || card.created_by_name || 'Administrator',
    lastUpdated: workflow.lastUpdated || card.updated_at || card.created_at,
    lastUpdatedBy: workflow.lastUpdatedBy || card.updated_by_name || card.created_by_name || '',
    targets: targets.length > 0 ? targets : ['미정'],
    phases: normalizedPhases,
  }
}

export function applyTemplateToWorkflow(current: WorkflowDocument, template: WorkflowTemplate): WorkflowDocument {
  const next = cloneValue(current)
  next.templateId = template.id
  next.templateName = template.name
  next.phases = cloneValue(template.workflow.phases ?? [])
  return next
}

export function countTotalInBlock(block: WorkflowBlock) {
  if (block.type === 'table') return block.rows.length
  if (block.type === 'checklist') return block.items.length
  return 0
}

export function countDoneInBlock(block: WorkflowBlock) {
  if (block.type === 'table') {
    const statusKey = block.columns.find((column) => column.type === 'status')?.key
    if (!statusKey) return 0
    return block.rows.filter((row) => ['done', 'n_a'].includes(String(row[statusKey] ?? ''))).length
  }
  if (block.type === 'checklist') {
    return block.items.filter((item) => item.done).length
  }
  return 0
}

export function computePhaseProgress(phase: WorkflowPhase) {
  const totals = phase.blocks.reduce(
    (acc, block) => {
      acc.done += countDoneInBlock(block)
      acc.total += countTotalInBlock(block)
      return acc
    },
    { done: 0, total: 0 },
  )
  if (!totals.total) return 0
  return Math.round((totals.done / totals.total) * 100)
}

export function computeWorkflowProgress(workflow: WorkflowDocument) {
  const totals = workflow.phases.reduce(
    (acc, phase) => {
      if (!isPhaseIncludedInProgress(phase)) {
        return acc
      }
      phase.blocks.forEach((block) => {
        acc.done += countDoneInBlock(block)
        acc.total += countTotalInBlock(block)
      })
      return acc
    },
    { done: 0, total: 0 },
  )

  if (!totals.total) {
    return { percent: 0, done: 0, total: 0 }
  }
  return {
    percent: Math.round((totals.done / totals.total) * 100),
    done: totals.done,
    total: totals.total,
  }
}

export function buildTableCopyText(block: WorkflowTableBlock) {
  const lines = [
    block.columns.map((column) => column.label).join('\t'),
    ...block.rows.map((row) => block.columns.map((column) => String(row[column.key] ?? '').replace(/\r?\n/g, ' ')).join('\t')),
  ]
  return lines.join('\n')
}
