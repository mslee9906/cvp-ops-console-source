import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react'
import { GripVertical, Pencil, Plus, RefreshCcw, Trash2, X } from 'lucide-react'
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { ApiError, api } from '../../api'
import type {
  BgpManagementItem,
  BgpManagementManualEntry,
  BgpManagementManualEntryKind,
  BgpManagementResponse,
} from '../../types'
import './BgpAsManagementPanel.css'

type ViewMode = 'all' | 'used' | 'reserved'
type DrawerTab = 'form' | 'list'
type PoolTone = 'core' | 'tenant' | 'security' | 'legacy'
type ServicePool = { id: string; name: string; rangeStart: number; rangeEnd: number; tone: PoolTone; description: string; sortOrder: number; locked?: boolean }
type PoolDraft = { name: string; rangeStart: string; rangeEnd: string; tone: PoolTone; description: string }
type ManualDraft = { asn: string; entryKind: BgpManagementManualEntryKind; deviceNames: string; note: string }
type DisplayRow = {
  key: string
  asn: string
  asnNumber: number | null
  status: 'in_use' | 'reserved' | 'custom' | 'available'
  statusLabel: string
  deviceNames: string[]
  detailPrimary: string
  detailSecondary: string
  poolId: string
  poolName: string
  sortKey: number
}
type StripSegment = {
  key: string
  start: number
  end: number
  state: 'used' | 'reserved'
  tone: PoolTone
  statusLabel: string
  leftPct: number
  widthPct: number
}
type AsnRange = { start: number; end: number }

const STORAGE_KEY = 'cvp-ops-console.bgp-service-pools.v3'
const MAX_AVAILABLE_ROWS = 4000
const toneOptions: Array<{ value: PoolTone; label: string }> = [
  { value: 'core', label: '코어' },
  { value: 'tenant', label: '테넌트' },
  { value: 'security', label: '보안' },
  { value: 'legacy', label: '레거시' },
]
const emptyPoolDraft: PoolDraft = { name: '', rangeStart: '', rangeEnd: '', tone: 'core', description: '' }
const emptyManualDraft: ManualDraft = { asn: '', entryKind: 'reserved', deviceNames: '', note: '' }

function parseAsn(value: string | number | null | undefined): number | null {
  const token = String(value ?? '').trim()
  return /^\d+$/.test(token) ? Number(token) : null
}
function formatCount(value: number): string {
  return new Intl.NumberFormat('ko-KR').format(value)
}
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '-'
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
function normalizeDeviceNames(value: string): string[] {
  const seen = new Set<string>()
  return value.replace(/,/g, '\n').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).filter((item) => {
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function createPoolId(): string {
  return `pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
function loadSavedPools(): ServicePool[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item, index) => {
      const rangeStart = parseAsn(item.rangeStart)
      const rangeEnd = parseAsn(item.rangeEnd)
      if (rangeStart === null || rangeEnd === null) return null
      return {
        id: String(item.id || createPoolId()),
        name: String(item.name || '').trim() || `서비스 풀 ${index + 1}`,
        rangeStart,
        rangeEnd,
        tone: (['core', 'tenant', 'security', 'legacy'].includes(String(item.tone)) ? item.tone : 'core') as PoolTone,
        description: String(item.description || '').trim(),
        sortOrder: Number(item.sortOrder ?? index),
      } satisfies ServicePool
    }).filter((item): item is ServicePool => Boolean(item)).sort((left, right) => left.sortOrder - right.sortOrder)
  } catch {
    return []
  }
}
function savePools(pools: ServicePool[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pools.map((item, index) => ({ ...item, sortOrder: index }))))
}
function reorderPools(pools: ServicePool[], draggedId: string, targetId: string): ServicePool[] {
  const sourceIndex = pools.findIndex((item) => item.id === draggedId)
  const targetIndex = pools.findIndex((item) => item.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return pools
  const next = [...pools]
  const [moved] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, moved)
  return next.map((item, index) => ({ ...item, sortOrder: index }))
}
function buildDefaultPool(snapshot: BgpManagementResponse | null): ServicePool {
  const minAsn = Math.max(snapshot?.min_asn ?? 1, 1)
  const maxAsn = snapshot?.max_asn ?? Math.max(minAsn, 1)
  return {
    id: 'default-all',
    name: 'BGP AS 전체 범위',
    rangeStart: minAsn,
    rangeEnd: maxAsn,
    tone: 'core',
    description: '스냅샷 ASN과 직접 등록 ASN을 모두 포함하는 기본 범위입니다.',
    sortOrder: -1,
    locked: true,
  }
}
function poolIncludesAsn(pool: ServicePool, asnNumber: number | null): boolean {
  return asnNumber !== null && asnNumber >= pool.rangeStart && asnNumber <= pool.rangeEnd
}
function resolvePoolForAsn(pools: ServicePool[], asnNumber: number | null): ServicePool {
  return pools.find((pool) => !pool.locked && poolIncludesAsn(pool, asnNumber)) ?? pools[0]
}
function buildSnapshotRows(items: BgpManagementItem[], pools: ServicePool[]): DisplayRow[] {
  const grouped = new Map<string, { asn: string; hostnames: Set<string>; vrfs: Set<string>; routerIds: Set<string>; shutdown: boolean }>()
  items.forEach((item) => {
    const asn = String(item.asn || '').trim()
    if (!asn) return
    const current = grouped.get(asn) ?? { asn, hostnames: new Set<string>(), vrfs: new Set<string>(), routerIds: new Set<string>(), shutdown: false }
    if (item.hostname) current.hostnames.add(item.hostname)
    if (item.vrf) current.vrfs.add(item.vrf)
    if (item.router_id) current.routerIds.add(item.router_id)
    current.shutdown = current.shutdown || Boolean(item.shutdown)
    grouped.set(asn, current)
  })
  const rows: Array<DisplayRow | null> = Array.from(grouped.values()).map((item) => {
    const asnNumber = parseAsn(item.asn)
    if (asnNumber === 0) return null
    const pool = resolvePoolForAsn(pools, asnNumber)
    const routerIdText = item.routerIds.size ? `Router ID ${Array.from(item.routerIds).join(', ')}` : 'Router ID 없음'
    return {
      key: `used-${item.asn}`,
      asn: item.asn,
      asnNumber,
      status: 'in_use',
      statusLabel: '사용중',
      deviceNames: Array.from(item.hostnames).sort((left, right) => left.localeCompare(right)),
      detailPrimary: item.vrfs.size ? Array.from(item.vrfs).join(', ') : '-',
      detailSecondary: item.shutdown ? `${routerIdText} / shutdown 포함` : routerIdText,
      poolId: pool.id,
      poolName: pool.name,
      sortKey: asnNumber ?? Number.MAX_SAFE_INTEGER,
    } satisfies DisplayRow
  })
  return rows.filter((item): item is DisplayRow => item !== null).sort((left, right) => left.sortKey - right.sortKey)
}
function buildManualRows(entries: BgpManagementManualEntry[], pools: ServicePool[]): DisplayRow[] {
  const rows: Array<DisplayRow | null> = [...entries].map((entry) => {
    const asnNumber = parseAsn(entry.asn)
    if (asnNumber === 0) return null
    const pool = resolvePoolForAsn(pools, asnNumber)
    const isReserved = entry.entry_kind === 'reserved'
    return {
      key: `manual-${entry.id}`,
      asn: entry.asn,
      asnNumber,
      status: isReserved ? 'reserved' : 'custom',
      statusLabel: isReserved ? '예약' : '기타',
      deviceNames: entry.device_names,
      detailPrimary: entry.note || (isReserved ? '예약 항목' : '직접 등록 항목'),
      detailSecondary: `${entry.created_by_name || '미상'} / ${formatDate(entry.updated_at || entry.created_at)}`,
      poolId: pool.id,
      poolName: pool.name,
      sortKey: asnNumber ?? Number.MAX_SAFE_INTEGER,
    } satisfies DisplayRow
  })
  return rows.filter((item): item is DisplayRow => item !== null).sort((left, right) => left.sortKey - right.sortKey)
}
function buildOccupiedSegments(pool: ServicePool, rows: DisplayRow[]): StripSegment[] {
  const total = Math.max(pool.rangeEnd - pool.rangeStart + 1, 1)
  const stateByAsn = new Map<number, 'used' | 'reserved'>()
  rows.forEach((row) => {
    const asnNumber = row.asnNumber
    if (asnNumber === null || !poolIncludesAsn(pool, asnNumber)) return
    if (row.status === 'in_use') {
      stateByAsn.set(asnNumber, 'used')
      return
    }
    if (!stateByAsn.has(asnNumber)) stateByAsn.set(asnNumber, 'reserved')
  })
  const asns = Array.from(stateByAsn.keys()).sort((left, right) => left - right)
  if (!asns.length) return []
  const segments: StripSegment[] = []
  let cursorStart = asns[0]
  let cursorEnd = asns[0]
  let cursorState = stateByAsn.get(asns[0]) ?? 'reserved'
  const flush = () => {
    segments.push({
      key: `seg-${cursorStart}-${cursorEnd}-${cursorState}`,
      start: cursorStart,
      end: cursorEnd,
      state: cursorState,
      tone: pool.tone,
      statusLabel: cursorState === 'used' ? '사용중' : '예약/기타',
      leftPct: ((cursorStart - pool.rangeStart) / total) * 100,
      widthPct: ((cursorEnd - cursorStart + 1) / total) * 100,
    })
  }
  for (let index = 1; index < asns.length; index += 1) {
    const asn = asns[index]
    const state = stateByAsn.get(asn) ?? 'reserved'
    if (asn === cursorEnd + 1 && state === cursorState) {
      cursorEnd = asn
      continue
    }
    flush()
    cursorStart = asn
    cursorEnd = asn
    cursorState = state
  }
  flush()
  return segments
}
function buildAvailableRows(pool: ServicePool, rows: DisplayRow[], scope: AsnRange | null = null, maxRows: number = MAX_AVAILABLE_ROWS): { rows: DisplayRow[]; truncated: boolean } {
  const occupiedAsn = new Set<number>()
  rows.forEach((row) => {
    if (row.asnNumber !== null) occupiedAsn.add(row.asnNumber)
  })
  const scopeStart = scope ? Math.max(pool.rangeStart, scope.start) : pool.rangeStart
  const scopeEnd = scope ? Math.min(pool.rangeEnd, scope.end) : pool.rangeEnd
  if (scopeStart > scopeEnd) return { rows: [], truncated: false }
  const availableRows: DisplayRow[] = []
  let truncated = false
  for (let asn = scopeStart; asn <= scopeEnd; asn += 1) {
    if (occupiedAsn.has(asn)) continue
    if (availableRows.length >= maxRows) {
      truncated = true
      break
    }
    availableRows.push({
      key: `available-${pool.id}-${asn}`,
      asn: String(asn),
      asnNumber: asn,
      status: 'available',
      statusLabel: '가용',
      deviceNames: [],
      detailPrimary: '미할당 ASN',
      detailSecondary: '-',
      poolId: pool.id,
      poolName: pool.name,
      sortKey: asn,
    })
  }
  return { rows: availableRows, truncated }
}
function buildPoolUsage(pool: ServicePool, rows: DisplayRow[]) {
  const total = Math.max(pool.rangeEnd - pool.rangeStart + 1, 0)
  const usedCount = rows.filter((row) => row.poolId === pool.id && row.status === 'in_use').length
  const reservedCount = rows.filter((row) => row.poolId === pool.id && row.status !== 'in_use').length
  const usedRatio = total ? (usedCount / total) * 100 : 0
  const reservedRatio = total ? (reservedCount / total) * 100 : 0
  return { usedCount, reservedCount, freeRatio: Math.max(100 - usedRatio - reservedRatio, 0), usedRatio, reservedRatio }
}

export function BgpAsManagementPanel() {
  const [snapshot, setSnapshot] = useState<BgpManagementResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('all')
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [manualError, setManualError] = useState('')
  const [submittingEntry, setSubmittingEntry] = useState(false)
  const [editingEntry, setEditingEntry] = useState<BgpManagementManualEntry | null>(null)
  const [manualDraft, setManualDraft] = useState<ManualDraft>(emptyManualDraft)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('form')
  const [customPools, setCustomPools] = useState<ServicePool[]>(() => loadSavedPools())
  const [poolFormOpen, setPoolFormOpen] = useState(false)
  const [poolDraft, setPoolDraft] = useState<PoolDraft>(emptyPoolDraft)
  const [editingPoolId, setEditingPoolId] = useState<string | null>(null)
  const [poolError, setPoolError] = useState('')
  const [selectedPoolId, setSelectedPoolId] = useState('default-all')
  const [draggedPoolId, setDraggedPoolId] = useState<string | null>(null)
  const [dragOverPoolId, setDragOverPoolId] = useState<string | null>(null)
  const [hoveredBlock, setHoveredBlock] = useState<StripSegment | null>(null)
  const [rangeFilter, setRangeFilter] = useState<AsnRange | null>(null)
  const [rangeDragStart, setRangeDragStart] = useState<number | null>(null)
  const [rangeDragMoved, setRangeDragMoved] = useState(false)
  const [rangeDragHadFilter, setRangeDragHadFilter] = useState(false)
  const [isRangeDragging, setIsRangeDragging] = useState(false)
  const stripTrackRef = useRef<HTMLDivElement | null>(null)
  const deferredSearch = useDeferredValue(search)

  const defaultPool = useMemo(() => buildDefaultPool(snapshot), [snapshot])
  const pools = useMemo(() => [defaultPool, ...customPools.slice().sort((left, right) => left.sortOrder - right.sortOrder)], [customPools, defaultPool])
  const manualEntries = snapshot?.manual_entries ?? []
  const snapshotRows = useMemo(() => buildSnapshotRows(snapshot?.items ?? [], pools), [pools, snapshot?.items])
  const manualRows = useMemo(() => buildManualRows(manualEntries, pools), [manualEntries, pools])
  const allRows = useMemo(() => [...snapshotRows, ...manualRows].sort((left, right) => left.sortKey - right.sortKey), [manualRows, snapshotRows])
  const selectedPool = useMemo(() => pools.find((pool) => pool.id === selectedPoolId) ?? pools[0], [pools, selectedPoolId])
  const selectedPoolTotal = selectedPool ? Math.max(selectedPool.rangeEnd - selectedPool.rangeStart + 1, 0) : 0
  const poolRows = useMemo(() => (selectedPool ? allRows.filter((row) => poolIncludesAsn(selectedPool, row.asnNumber)) : allRows), [allRows, selectedPool])
  const includeAvailableRows = !isRangeDragging && Boolean(selectedPool?.locked || rangeFilter)
  const availableResult = useMemo(() => {
    if (!selectedPool || !includeAvailableRows) return { rows: [] as DisplayRow[], truncated: false }
    return buildAvailableRows(selectedPool, poolRows, rangeFilter, MAX_AVAILABLE_ROWS)
  }, [includeAvailableRows, poolRows, rangeFilter, selectedPool])
  const availableRows = availableResult.rows
  const tableRows = useMemo(
    () => (availableRows.length ? [...poolRows, ...availableRows].sort((left, right) => left.sortKey - right.sortKey) : poolRows),
    [availableRows, poolRows],
  )
  const stripSegments = useMemo(() => (selectedPool ? buildOccupiedSegments(selectedPool, poolRows) : []), [poolRows, selectedPool])

  useEffect(() => { void loadSnapshot() }, [])
  useEffect(() => { savePools(customPools) }, [customPools])
  useEffect(() => { if (!pools.some((pool) => pool.id === selectedPoolId)) setSelectedPoolId(pools[0]?.id ?? 'default-all') }, [pools, selectedPoolId])
  useEffect(() => {
    setHoveredBlock(null)
    setRangeFilter(null)
    setRangeDragStart(null)
    setRangeDragMoved(false)
    setRangeDragHadFilter(false)
    setIsRangeDragging(false)
  }, [selectedPoolId])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 2200)
    return () => window.clearTimeout(timer)
  }, [message])

  async function loadSnapshot() {
    setLoading(true)
    setError('')
    try { setSnapshot(await api.getBgpManagementSnapshot()) }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : 'BGP AS 현황을 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }
  function resetManualForm(kind: BgpManagementManualEntryKind = 'reserved') {
    setEditingEntry(null)
    setManualDraft({ ...emptyManualDraft, entryKind: kind })
    setManualError('')
  }
  async function handleSubmitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setManualError('')
    setSubmittingEntry(true)
    const payload = { asn: manualDraft.asn.trim(), entry_kind: manualDraft.entryKind, device_names: normalizeDeviceNames(manualDraft.deviceNames), note: manualDraft.note.trim() }
    try {
      if (editingEntry) {
        await api.updateBgpManagementEntry(editingEntry.id, payload)
        setMessage(`AS ${payload.asn} 항목을 수정했습니다.`)
      } else {
        await api.createBgpManagementEntry(payload)
        setMessage(`AS ${payload.asn} 항목을 등록했습니다.`)
      }
      await loadSnapshot()
      resetManualForm(payload.entry_kind)
      setDrawerTab('list')
    } catch (caught) {
      setManualError(caught instanceof ApiError ? caught.message : '직접 등록 항목을 저장하지 못했습니다.')
    } finally {
      setSubmittingEntry(false)
    }
  }
  async function handleDeleteEntry(entry: BgpManagementManualEntry) {
    if (!window.confirm(`AS ${entry.asn} 항목을 삭제하시겠습니까?`)) return
    setManualError('')
    try {
      await api.deleteBgpManagementEntry(entry.id)
      if (editingEntry?.id === entry.id) resetManualForm()
      setMessage(`AS ${entry.asn} 항목을 삭제했습니다.`)
      await loadSnapshot()
    } catch (caught) {
      setManualError(caught instanceof ApiError ? caught.message : '직접 등록 항목을 삭제하지 못했습니다.')
    }
  }
  function handleEditEntry(entry: BgpManagementManualEntry) {
    setEditingEntry(entry)
    setManualDraft({ asn: entry.asn, entryKind: entry.entry_kind, deviceNames: entry.device_names.join('\n'), note: entry.note })
    setManualError('')
    setDrawerTab('form')
    setDrawerOpen(true)
  }
  function handlePoolSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const rangeStart = parseAsn(poolDraft.rangeStart)
    const rangeEnd = parseAsn(poolDraft.rangeEnd)
    if (rangeStart === null || rangeEnd === null) return setPoolError('ASN 범위는 숫자로 입력해 주세요.')
    if (rangeStart > rangeEnd) return setPoolError('시작 ASN이 종료 ASN보다 클 수 없습니다.')
    const nextPool: ServicePool = {
      id: editingPoolId ?? createPoolId(),
      name: poolDraft.name.trim() || `서비스 풀 ${customPools.length + 1}`,
      rangeStart,
      rangeEnd,
      tone: poolDraft.tone,
      description: poolDraft.description.trim(),
      sortOrder: editingPoolId !== null ? customPools.find((item) => item.id === editingPoolId)?.sortOrder ?? customPools.length : customPools.length,
    }
    setCustomPools((current) => editingPoolId ? current.map((item) => (item.id === editingPoolId ? nextPool : item)) : [...current, nextPool])
    setSelectedPoolId(nextPool.id)
    setEditingPoolId(null)
    setPoolDraft(emptyPoolDraft)
    setPoolError('')
    setPoolFormOpen(false)
  }
  function handlePoolEdit(pool: ServicePool) {
    if (pool.locked) return
    setEditingPoolId(pool.id)
    setPoolDraft({ name: pool.name, rangeStart: String(pool.rangeStart), rangeEnd: String(pool.rangeEnd), tone: pool.tone, description: pool.description })
    setPoolFormOpen(true)
    setPoolError('')
  }
  function handlePoolDelete(pool: ServicePool) {
    if (pool.locked || !window.confirm(`서비스 풀 "${pool.name}"을 삭제하시겠습니까?`)) return
    setCustomPools((current) => current.filter((item) => item.id !== pool.id).map((item, index) => ({ ...item, sortOrder: index })))
    if (selectedPoolId === pool.id) setSelectedPoolId('default-all')
  }
  function resolveAsnByClientX(clientX: number): number | null {
    if (!selectedPool || !stripTrackRef.current) return null
    const rect = stripTrackRef.current.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const total = Math.max(selectedPool.rangeEnd - selectedPool.rangeStart + 1, 1)
    const offset = Math.round(ratio * (total - 1))
    return Math.min(selectedPool.rangeEnd, Math.max(selectedPool.rangeStart, selectedPool.rangeStart + offset))
  }
  function handleStripPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const startAsn = resolveAsnByClientX(event.clientX)
    if (startAsn === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setHoveredBlock(null)
    setRangeDragHadFilter(Boolean(rangeFilter))
    setRangeDragMoved(false)
    setIsRangeDragging(true)
    setRangeDragStart(startAsn)
    if (!rangeFilter) setRangeFilter({ start: startAsn, end: startAsn })
  }
  function handleStripPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isRangeDragging || rangeDragStart === null) return
    const currentAsn = resolveAsnByClientX(event.clientX)
    if (currentAsn === null) return
    const moved = currentAsn !== rangeDragStart
    if (moved) setRangeDragMoved(true)
    if (!rangeFilter && !moved) return
    setRangeFilter({
      start: Math.min(rangeDragStart, currentAsn),
      end: Math.max(rangeDragStart, currentAsn),
    })
  }
  function handleStripPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isRangeDragging) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!rangeDragMoved && rangeDragHadFilter) {
      clearRangeFilter()
      return
    }
    setIsRangeDragging(false)
    setRangeDragStart(null)
    setRangeDragMoved(false)
    setRangeDragHadFilter(false)
  }
  function clearRangeFilter() {
    setRangeFilter(null)
    setRangeDragStart(null)
    setRangeDragMoved(false)
    setRangeDragHadFilter(false)
    setIsRangeDragging(false)
  }

  const filteredRows = tableRows.filter((row) => {
    if (viewMode === 'used' && row.status !== 'in_use') return false
    if (viewMode === 'reserved' && row.status !== 'reserved' && row.status !== 'custom') return false
    if (rangeFilter) {
      if (row.asnNumber === null) return false
      if (row.asnNumber < rangeFilter.start || row.asnNumber > rangeFilter.end) return false
    }
    const token = deferredSearch.trim().toLowerCase()
    if (!token) return true
    return [row.asn, row.statusLabel, row.deviceNames.join(' '), row.detailPrimary, row.detailSecondary, row.poolName].join(' ').toLowerCase().includes(token)
  })
  const usedCount = poolRows.filter((row) => row.status === 'in_use').length
  const reservedCount = poolRows.filter((row) => row.status !== 'in_use').length
  const availableCount = Math.max(selectedPoolTotal - usedCount - reservedCount, 0)
  const hoveredTooltipLeft = useMemo(() => {
    if (!selectedPool || !hoveredBlock) return 50
    const total = Math.max(selectedPool.rangeEnd - selectedPool.rangeStart + 1, 1)
    const midpoint = (hoveredBlock.start + hoveredBlock.end) / 2
    const raw = ((midpoint - selectedPool.rangeStart + 0.5) / total) * 100
    return Math.min(96, Math.max(4, raw))
  }, [hoveredBlock, selectedPool])
  const selectedRangeStyle = useMemo(() => {
    if (!selectedPool || !rangeFilter) return null
    const total = Math.max(selectedPool.rangeEnd - selectedPool.rangeStart + 1, 1)
    const leftPct = ((rangeFilter.start - selectedPool.rangeStart) / total) * 100
    const widthPct = ((rangeFilter.end - rangeFilter.start + 1) / total) * 100
    return {
      left: `${leftPct}%`,
      width: `max(${Math.max(widthPct, 0.0001)}%, 2px)`,
    }
  }, [rangeFilter, selectedPool])
  const rangeFilterLabel = rangeFilter ? `AS ${rangeFilter.start} - ${rangeFilter.end}` : ''

  return (
    <section className="bgp-proto-page">
      <div className="bgp-proto-shell">
        <div className="bgp-proto-main">
          <article className="bgp-proto-card bgp-proto-range-panel">
            <div className="bgp-proto-head">
              <div>
                <p className="section-kicker">BGP AS 현황</p>
                <h2>BGP AS 현황</h2>
                <p>스냅샷 ASN, 직접 등록 ASN, 서비스 풀 범위를 한 화면에서 확인합니다.</p>
              </div>
              <button className="secondary-action" type="button" onClick={() => void loadSnapshot()} disabled={loading}>
                <RefreshCcw size={16} className={loading ? 'spin' : ''} />
                <span>{loading ? '불러오는 중...' : '새로고침'}</span>
              </button>
            </div>
            {error ? <div className="message-banner error">{error}</div> : null}
            <div className="bgp-proto-meta-row">
              <div className="bgp-proto-meta-box"><span>전체 범위</span><strong>{formatCount(selectedPoolTotal)}</strong></div>
              <div className="bgp-proto-meta-box"><span>사용중 ASN</span><strong>{formatCount(usedCount)}</strong></div>
              <div className="bgp-proto-meta-box"><span>예약/기타</span><strong>{formatCount(reservedCount)}</strong></div>
              <div className="bgp-proto-meta-box"><span>사용 가능</span><strong>{formatCount(availableCount)}</strong></div>
            </div>
            {selectedPool ? (
              <div className="bgp-proto-range-board">
                <div className="bgp-proto-range-top">
                  <div><strong>{selectedPool.name}</strong><small>{selectedPool.description || `${selectedPool.rangeStart} ~ ${selectedPool.rangeEnd}`}</small></div>
                  <div className="bgp-proto-range-text">{selectedPool.rangeStart} - {selectedPool.rangeEnd}</div>
                </div>
                <div className="bgp-proto-strip-shell">
                  <div className="bgp-proto-strip-axis">
                    <span className="bgp-proto-edge">{selectedPool.rangeStart}</span>
                    <div
                      ref={stripTrackRef}
                      className={`bgp-proto-strip-track ${isRangeDragging ? 'dragging' : ''}`}
                      onPointerDown={handleStripPointerDown}
                      onPointerMove={handleStripPointerMove}
                      onPointerUp={handleStripPointerUp}
                      onPointerCancel={handleStripPointerUp}
                      onMouseLeave={() => { if (!isRangeDragging) setHoveredBlock(null) }}
                    >
                      {selectedRangeStyle ? <div className="bgp-proto-strip-selection" style={selectedRangeStyle} /> : null}
                      {hoveredBlock && !isRangeDragging ? (
                        <div className="bgp-proto-strip-tooltip" style={{ left: `${hoveredTooltipLeft}%` }}>
                          <strong>{hoveredBlock.start === hoveredBlock.end ? `AS ${hoveredBlock.start}` : `AS ${hoveredBlock.start} - ${hoveredBlock.end}`}</strong>
                          <span>{hoveredBlock.statusLabel}</span>
                        </div>
                      ) : null}
                      {stripSegments.map((segment) => (
                        <span
                          key={segment.key}
                          className={`bgp-proto-asn-seg ${segment.state === 'used' ? `in-use ${segment.tone}` : 'reserved'} ${hoveredBlock?.key === segment.key ? 'active' : ''}`}
                          style={{ left: `${segment.leftPct}%`, width: `max(${Math.max(segment.widthPct, 0.0001)}%, 2px)` }}
                          onMouseEnter={() => { if (!isRangeDragging) setHoveredBlock(segment) }}
                        />
                      ))}
                    </div>
                    <span className="bgp-proto-edge align-right">{selectedPool.rangeEnd}</span>
                  </div>
                </div>
                <div className="bgp-proto-legend">
                  <span className="bgp-proto-legend-item"><span className={`bgp-proto-dot in-use ${selectedPool.tone}`} />사용중</span>
                  <span className="bgp-proto-legend-item"><span className="bgp-proto-dot reserved" />예약 / 기타</span>
                  <span className="bgp-proto-legend-item"><span className="bgp-proto-dot available" />미사용</span>
                </div>
                <p className="bgp-proto-range-hint">드래그로 조회 범위를 선택하고, 범위를 해제하려면 바를 한 번 클릭해 전체로 돌아옵니다.</p>
              </div>
            ) : null}
          </article>

          <article className="bgp-proto-card bgp-proto-table-panel">
            <div className="bgp-proto-table-tools">
              <label className="field">
                <span>검색</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ASN, 장비명, 설명, 서비스 풀로 검색" />
              </label>
              <div className="bgp-proto-toolbar-cluster">
                <div className="bgp-proto-view-toggle">
                  <button className={`bgp-proto-view-button ${viewMode === 'all' ? 'active' : ''}`} type="button" onClick={() => setViewMode('all')}>전체 범위</button>
                  <button className={`bgp-proto-view-button ${viewMode === 'used' ? 'active' : ''}`} type="button" onClick={() => setViewMode('used')}>사용중 ASN</button>
                  <button className={`bgp-proto-view-button ${viewMode === 'reserved' ? 'active' : ''}`} type="button" onClick={() => setViewMode('reserved')}>예약/기타</button>
                </div>
                {rangeFilter ? (
                  <button className="ghost-action compact-action" type="button" onClick={clearRangeFilter}>
                    <span>{rangeFilterLabel}</span>
                    <span>해제</span>
                  </button>
                ) : null}
                <button className="bgp-proto-manual-trigger" type="button" onClick={() => { resetManualForm(); setDrawerTab('form'); setDrawerOpen(true) }}>
                  <Plus size={14} />
                  <span>직접 추가</span>
                </button>
              </div>
            </div>
            <div className="bgp-proto-table-head">
              <span>{selectedPool?.name ?? 'BGP AS 전체 범위'} · 총 {formatCount(filteredRows.length)}건</span>
              <span>
                {availableResult.truncated
                  ? `가용 ASN이 많아 상위 ${formatCount(MAX_AVAILABLE_ROWS)}건만 표시됩니다. 범위를 더 좁혀주세요.`
                  : rangeFilter
                    ? `드래그 범위 필터: ${rangeFilterLabel}`
                    : selectedPool?.locked
                      ? '전체 범위에서는 가용 ASN도 함께 조회됩니다.'
                      : '표 헤더는 스크롤 중에도 상단에 고정됩니다.'}
              </span>
            </div>
            <div className="bgp-proto-table-wrap bgp-table-shell">
              <table className="data-table">
                <thead><tr><th>ASN</th><th>상태</th><th>장비 목록</th><th>상세</th><th>서비스 풀</th></tr></thead>
                <tbody>
                  {filteredRows.length ? filteredRows.map((row) => (
                    <tr key={row.key}>
                      <td className="mono-cell">{row.asn}</td>
                      <td><span className={`bgp-proto-pill ${row.status === 'in_use' ? 'in-use' : row.status === 'reserved' ? 'reserved' : 'available'}`}>{row.statusLabel}</span></td>
                      <td><div className="bgp-proto-line-list">{row.deviceNames.length ? row.deviceNames.map((name) => <span key={`${row.key}-${name}`}>{name}</span>) : <span className="bgp-proto-cell-muted">-</span>}</div></td>
                      <td><div className="bgp-proto-line-list"><span>{row.detailPrimary || '-'}</span><span className="bgp-proto-cell-muted">{row.detailSecondary || '-'}</span></div></td>
                      <td>{row.poolName}</td>
                    </tr>
                  )) : <tr><td className="bgp-proto-empty-cell" colSpan={5}>현재 조건에 맞는 BGP AS 항목이 없습니다.</td></tr>}
                </tbody>
              </table>
            </div>
          </article>
        </div>

        <aside className="bgp-proto-side-stack">
          {message ? <div className="message-banner success">{message}</div> : null}
          <article className="bgp-proto-card bgp-proto-pool-panel">
            <div className="bgp-proto-head">
              <div>
                <h2>서비스 풀</h2>
              </div>
              <button
                aria-label="서비스 풀 추가"
                className={`bgp-proto-icon-button bgp-proto-pool-add-button ${poolFormOpen ? 'active' : ''}`}
                title="서비스 풀 추가"
                type="button"
                onClick={() => { setPoolFormOpen((current) => !current); setEditingPoolId(null); setPoolDraft(emptyPoolDraft); setPoolError('') }}
              >
                <Plus size={18} />
              </button>
            </div>
            {poolError ? <div className="message-banner error">{poolError}</div> : null}
            {poolFormOpen ? (
              <form className="bgp-proto-form-grid" onSubmit={handlePoolSubmit}>
                <label className="field"><span>이름</span><input value={poolDraft.name} onChange={(event) => setPoolDraft((current) => ({ ...current, name: event.target.value }))} placeholder="예: Edge 스위치" /></label>
                <label className="field"><span>톤</span><select value={poolDraft.tone} onChange={(event) => setPoolDraft((current) => ({ ...current, tone: event.target.value as PoolTone }))}>{toneOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field"><span>시작 ASN</span><input value={poolDraft.rangeStart} onChange={(event) => setPoolDraft((current) => ({ ...current, rangeStart: event.target.value }))} inputMode="numeric" /></label>
                <label className="field"><span>종료 ASN</span><input value={poolDraft.rangeEnd} onChange={(event) => setPoolDraft((current) => ({ ...current, rangeEnd: event.target.value }))} inputMode="numeric" /></label>
                <label className="field full"><span>설명</span><input value={poolDraft.description} onChange={(event) => setPoolDraft((current) => ({ ...current, description: event.target.value }))} placeholder="예: Edge 장비 ASN 범위" /></label>
                <div className="bgp-proto-pool-form-actions">
                  <button className="primary-action" type="submit">{editingPoolId ? '수정 저장' : '서비스 풀 추가'}</button>
                  <button className="secondary-action" type="button" onClick={() => { setPoolFormOpen(false); setEditingPoolId(null); setPoolDraft(emptyPoolDraft); setPoolError('') }}>취소</button>
                </div>
              </form>
            ) : null}
            <div className="bgp-proto-pool-list">
              {pools.map((pool) => {
                const usage = buildPoolUsage(pool, allRows)
                return (
                  <article
                    key={pool.id}
                    className={`bgp-proto-pool-item ${selectedPoolId === pool.id ? `active ${pool.tone}` : ''} ${draggedPoolId === pool.id ? 'dragging' : ''} ${dragOverPoolId === pool.id ? 'drag-over' : ''}`}
                    onClick={() => setSelectedPoolId(pool.id)}
                    draggable={!pool.locked}
                    onDragStart={() => setDraggedPoolId(pool.id)}
                    onDragOver={(event) => { if (pool.locked) return; event.preventDefault(); setDragOverPoolId(pool.id) }}
                    onDragLeave={() => setDragOverPoolId((current) => (current === pool.id ? null : current))}
                    onDrop={(event) => { event.preventDefault(); if (!draggedPoolId || pool.locked) return; setCustomPools((current) => reorderPools(current, draggedPoolId, pool.id)); setDraggedPoolId(null); setDragOverPoolId(null) }}
                    onDragEnd={() => { setDraggedPoolId(null); setDragOverPoolId(null) }}
                  >
                    <div className="bgp-proto-pool-item-head">
                      <div className="bgp-proto-pool-item-title">
                        {!pool.locked ? <span className="bgp-proto-drag-handle" title="순서 변경"><GripVertical size={16} /></span> : null}
                        <div><strong>{pool.name}</strong><div className="bgp-proto-range-text">{pool.rangeStart} - {pool.rangeEnd}</div></div>
                      </div>
                      {!pool.locked ? (
                        <div className="bgp-proto-pool-item-actions">
                          <button className="bgp-proto-icon-button" type="button" onClick={(event) => { event.stopPropagation(); handlePoolEdit(pool) }} title="수정"><Pencil size={15} /></button>
                          <button className="bgp-proto-icon-button danger" type="button" onClick={(event) => { event.stopPropagation(); handlePoolDelete(pool) }} title="삭제"><Trash2 size={15} /></button>
                        </div>
                      ) : null}
                    </div>
                    <div className="bgp-proto-pool-bar" aria-hidden="true">
                      <span className={`used ${pool.tone}`} style={{ width: `${usage.usedRatio}%` }} />
                      <span className="reserved" style={{ width: `${usage.reservedRatio}%` }} />
                      <span className="free" style={{ width: `${usage.freeRatio}%` }} />
                    </div>
                    <div className="bgp-proto-pool-meta"><span>사용중 {formatCount(usage.usedCount)}</span><span>예약/기타 {formatCount(usage.reservedCount)}</span></div>
                  </article>
                )
              })}
            </div>
          </article>
        </aside>
      </div>

      {drawerOpen ? (
        <div className="bgp-proto-drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <aside className="bgp-proto-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="bgp-proto-drawer-head">
              <div>
                <p className="section-kicker">직접 등록</p>
                <h3>직접 추가</h3>
                <p>예약 또는 기타 ASN을 직접 등록하고, 기존 항목을 수정·삭제할 수 있습니다.</p>
              </div>
              <button className="secondary-action compact-action" type="button" onClick={() => setDrawerOpen(false)}><X size={16} /><span>닫기</span></button>
            </div>
            {manualError ? <div className="message-banner error">{manualError}</div> : null}
            <div className="bgp-proto-drawer-tabs">
              <button className={`bgp-proto-drawer-tab ${drawerTab === 'form' ? 'active' : ''}`} type="button" onClick={() => setDrawerTab('form')}>추가</button>
              <button className={`bgp-proto-drawer-tab ${drawerTab === 'list' ? 'active' : ''}`} type="button" onClick={() => setDrawerTab('list')}>목록</button>
            </div>
            <div className="bgp-proto-drawer-body">
              {drawerTab === 'form' ? (
                <div className="bgp-proto-drawer-panel">
                  <div className="bgp-proto-entry-toggle">
                    <button className={`bgp-proto-view-button ${manualDraft.entryKind === 'reserved' ? 'active' : ''}`} type="button" onClick={() => setManualDraft((current) => ({ ...current, entryKind: 'reserved' }))}>예약</button>
                    <button className={`bgp-proto-view-button ${manualDraft.entryKind === 'custom' ? 'active' : ''}`} type="button" onClick={() => setManualDraft((current) => ({ ...current, entryKind: 'custom' }))}>기타</button>
                  </div>
                  <form className="bgp-proto-manual-form" onSubmit={handleSubmitEntry}>
                    <div className="bgp-proto-form-grid">
                      <label className="field"><span>ASN</span><input value={manualDraft.asn} onChange={(event) => setManualDraft((current) => ({ ...current, asn: event.target.value }))} inputMode="numeric" placeholder="예: 65123" /></label>
                      <label className="field"><span>서비스 풀</span><input value={resolvePoolForAsn(pools, parseAsn(manualDraft.asn))?.name ?? '-'} readOnly /></label>
                      <label className="field full"><span>장비 목록</span><textarea className="bgp-proto-textarea" value={manualDraft.deviceNames} onChange={(event) => setManualDraft((current) => ({ ...current, deviceNames: event.target.value }))} placeholder={'장비명을 한 줄씩 입력해 주세요.\n예: EDGE-01'} /></label>
                      <label className="field full"><span>설명</span><textarea className="bgp-proto-textarea" value={manualDraft.note} onChange={(event) => setManualDraft((current) => ({ ...current, note: event.target.value }))} placeholder="설명 또는 참고 메모" /></label>
                    </div>
                    <div className="bgp-proto-drawer-actions">
                      <button className="primary-action" type="submit" disabled={submittingEntry}>{submittingEntry ? '저장 중...' : editingEntry ? '수정 저장' : '등록'}</button>
                      <button className="secondary-action" type="button" onClick={() => resetManualForm(manualDraft.entryKind)} disabled={submittingEntry}>초기화</button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="bgp-proto-drawer-panel bgp-proto-drawer-panel-list">
                  <div className="bgp-proto-table-head"><span>직접 등록 항목 {formatCount(manualEntries.length)}건</span><span>예약/기타 항목을 여기서 수정하고 삭제할 수 있습니다.</span></div>
                  <div className="bgp-proto-drawer-table">
                    <table className="data-table">
                      <thead><tr><th>ASN</th><th>구분</th><th>장비 목록</th><th>설명</th><th>관리</th></tr></thead>
                      <tbody>
                        {manualEntries.length ? manualEntries.map((entry) => (
                          <tr key={entry.id}>
                            <td className="mono-cell">{entry.asn}</td>
                            <td><span className={`bgp-proto-pill ${entry.entry_kind === 'reserved' ? 'reserved' : 'available'}`}>{entry.entry_kind === 'reserved' ? '예약' : '기타'}</span></td>
                            <td><div className="bgp-proto-line-list">{entry.device_names.length ? entry.device_names.map((name) => <span key={`${entry.id}-${name}`}>{name}</span>) : <span className="bgp-proto-cell-muted">-</span>}</div></td>
                            <td><div className="bgp-proto-line-list"><span>{entry.note || '-'}</span><span className="bgp-proto-cell-muted">{entry.created_by_name || '미상'} / {formatDate(entry.updated_at || entry.created_at)}</span></div></td>
                            <td><div className="bgp-proto-manual-actions"><button className="ghost-action compact-action" type="button" onClick={() => handleEditEntry(entry)}>수정</button><button className="ghost-action compact-action danger" type="button" onClick={() => void handleDeleteEntry(entry)}>삭제</button></div></td>
                          </tr>
                        )) : <tr><td className="bgp-proto-empty-cell" colSpan={5}>직접 등록 항목이 없습니다.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  )
}
