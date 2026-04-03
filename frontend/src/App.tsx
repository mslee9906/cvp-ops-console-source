import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useRef } from 'react'
import {
  Activity,
  ClipboardList,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  FileSearch,
  FileText,
  GitBranchPlus,
  House,
  Layers3,
  Link2,
  LogOut,
  Network,
  Radar,
  RefreshCcw,
  Search,
  Server,
  ShieldAlert,
  UserCog,
  Wrench,
} from 'lucide-react'
import { Copy, X } from 'lucide-react'
import './App.css'
import { ApiError, api } from './api'
import { LoginScreen } from './features/auth/LoginScreen'
import { UserSettingsModal } from './features/auth/UserSettingsModal'
import { AutomationConsole } from './features/automation/AutomationConsole'
import { EdmLinkManager } from './features/edm-links/EdmLinkManager'
import { KanbanBoard } from './features/kanban/KanbanBoard'
import { WorkflowBoard } from './features/workflow/WorkflowBoard'
import { WorkPlanBoard } from './features/workplan/WorkPlanBoard'
import type {
  AutomationSource,
  CollectionProgressResponse,
  ConfigPreviewResponse,
  ConfigSearchMatch,
  ConfigSearchResponse,
  DeviceSummary,
  LookupMatch,
  LookupResponse,
  LookupStatus,
  OverviewResponse,
  RecordListResponse,
  RecordScope,
  UserCreateInput,
  UserSummary,
  VniGroupListResponse,
  VrfGroupListResponse,
} from './types'

type ViewId =
  | 'home'
  | 'ip'
  | 'bgp'
  | 'vlan'
  | 'vni'
  | 'vrf'
  | 'devices'
  | 'config'
  | 'edm_link'
  | 'automation_ip_tags'
  | 'automation_lldp_tags'
  | 'kanban'
  | 'work_tool'
  | 'work_plan'
type ViewMeta = {
  label: string
  eyebrow: string
  title: string
  description: string
  icon: typeof Search
}

type ConfigSearchOverlayState = {
  open: boolean
  loading: boolean
  error: string
  match: ConfigSearchMatch | null
  preview: ConfigPreviewResponse | null
}

const DEFAULT_PAGE_SIZE = 200
const LOAD_MORE_STEP = 200
const recordViews: RecordScope[] = ['ip', 'bgp', 'vlan']

const viewMeta: Record<ViewId, ViewMeta> = {
  home: {
    label: '홈',
    eyebrow: 'Snapshot Overview',
    title: 'CVP 현황 대시보드',
    description: '현재 스냅샷의 장비, IP, BGP, VLAN, VNI, VRF, Config 상태를 한 화면에서 확인합니다.',
    icon: House,
  },
  ip: {
    label: 'IP 조회',
    eyebrow: 'Address Readiness',
    title: 'IP 현황 및 사용 가능성 조회',
    description: 'IP 또는 대역을 조회하고, 현재 스냅샷에 있는 주소 목록을 함께 확인합니다.',
    icon: Network,
  },
  bgp: {
    label: 'BGP AS',
    eyebrow: 'Routing Context',
    title: 'BGP AS 사용 현황 조회',
    description: 'ASN이 현재 어디에서 사용 중인지 조회하고, 전체 BGP 목록도 함께 확인합니다.',
    icon: GitBranchPlus,
  },
  vlan: {
    label: 'VLAN',
    eyebrow: 'Layer 2 Inventory',
    title: 'VLAN 현황 조회',
    description: 'VLAN ID 또는 이름 기준으로 조회하고, 현재 스냅샷 기준 VLAN 목록을 확인합니다.',
    icon: Layers3,
  },
  vni: {
    label: 'VxLAN VNI',
    eyebrow: 'Overlay Extension',
    title: 'VxLAN VNI 현황 조회',
    description: 'VNI별 장비 설정 여부와, 같은 VNI에 연결된 VLAN 확장 관계를 함께 확인합니다.',
    icon: Layers3,
  },
  vrf: {
    label: 'VRF',
    eyebrow: 'Segmentation Map',
    title: 'VRF 현황 조회',
    description: 'VRF 이름 중심으로 장비 소속 현황을 정리해서 확인합니다.',
    icon: Radar,
  },
  devices: {
    label: '장비',
    eyebrow: 'Snapshot Inventory',
    title: '장비 및 Config 확인',
    description: '현재 스냅샷 장비 목록과 최신 Config 백업을 함께 확인합니다.',
    icon: Server,
  },
  config: {
    label: 'Config 검색',
    eyebrow: 'Cross Snapshot Search',
    title: '전체 Config 본문 검색',
    description: '현재 최신 스냅샷 Config 전체를 대상으로 문자열을 검색하고, 어떤 장비에서 매칭되는지 확인합니다.',
    icon: FileSearch,
  },
  edm_link: {
    label: 'EDM LINK',
    eyebrow: 'Link Directory',
    title: '사내 링크 바로가기 관리',
    description: '업무 문서함, NAS, 제출 포털 링크를 버튼 형태로 등록하고 색상별로 정리합니다.',
    icon: Link2,
  },
  automation_ip_tags: {
    label: 'IP TAG',
    eyebrow: 'Automation Tools',
    title: 'IP TAG 자동화',
    description: '실제 running-config의 인터페이스 IP와 CVP IP TAG를 비교해 추가/삭제 대상을 계산하고 workspace submit까지 실행합니다.',
    icon: Wrench,
  },
  automation_lldp_tags: {
    label: 'LLDP TAG',
    eyebrow: 'Automation Tools',
    title: 'LLDP TAG 자동화',
    description: '실제 LLDP neighbor와 CVP LLDP device/interface TAG를 비교해 추가/삭제 대상을 계산하고 workspace submit까지 실행합니다.',
    icon: Wrench,
  },
  kanban: {
    label: '작업 보드',
    eyebrow: 'Kanban Workflow',
    title: '작업 보드',
    description: '작업 카드를 생성하고, 수정하고, 삭제하고, 드래그로 상태를 이동하는 보드입니다.',
    icon: Layers3,
  },
  work_tool: {
    label: '작업 툴',
    eyebrow: 'Tool Workspace',
    title: '작업 카드 연계 작업 툴',
    description: '기존 작업 카드와 연결된 작업 대상, Snapshot, 예정 Config, 검증, Diff를 한 화면에서 이어서 관리합니다.',
    icon: ClipboardList,
  },
  work_plan: {
    label: '워크플로우',
    eyebrow: 'Execution Workflow',
    title: '작업 워크플로우',
    description: '작업 카드와 연결된 실행 절차, 단계 진행률, 템플릿, 블록 기반 작업 문서를 관리합니다.',
    icon: ClipboardList,
  },
}

const managementViews: ViewId[] = ['ip', 'bgp', 'vlan', 'vni', 'vrf', 'devices', 'config', 'edm_link']
const automationViews: ViewId[] = ['automation_ip_tags', 'automation_lldp_tags']
const kanbanViews: ViewId[] = ['kanban', 'work_tool', 'work_plan']

const initialLookupState = {
  loading: false,
  error: '',
  result: null as LookupResponse | null,
}

const initialConfigSearchState = {
  loading: false,
  error: '',
  result: null as ConfigSearchResponse | null,
}

const initialConfigSearchOverlayState: ConfigSearchOverlayState = {
  open: false,
  loading: false,
  error: '',
  match: null,
  preview: null,
}

const emptyRecordLists: Record<RecordScope, RecordListResponse> = {
  ip: { scope: 'ip', total_count: 0, items: [] },
  bgp: { scope: 'bgp', total_count: 0, items: [] },
  vlan: { scope: 'vlan', total_count: 0, items: [] },
}

const emptyRecordLoading: Record<RecordScope, boolean> = {
  ip: false,
  bgp: false,
  vlan: false,
}

const emptyRecordErrors: Record<RecordScope, string> = {
  ip: '',
  bgp: '',
  vlan: '',
}

const emptyRecordLimits: Record<RecordScope, number> = {
  ip: DEFAULT_PAGE_SIZE,
  bgp: DEFAULT_PAGE_SIZE,
  vlan: DEFAULT_PAGE_SIZE,
}

function isRecordScope(view: ViewId): view is RecordScope {
  return recordViews.includes(view as RecordScope)
}

function App() {
  const [authReady, setAuthReady] = useState(false)
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [currentUser, setCurrentUser] = useState<UserSummary | null>(null)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const [accountActionBusy, setAccountActionBusy] = useState(false)
  const [accountActionError, setAccountActionError] = useState('')
  const [accountActionSuccess, setAccountActionSuccess] = useState('')
  const [activeView, setActiveView] = useState<ViewId>('home')
  const [managementOpen, setManagementOpen] = useState(true)
  const [automationOpen, setAutomationOpen] = useState(true)
  const [kanbanOpen, setKanbanOpen] = useState(true)
  const [railNavScrollable, setRailNavScrollable] = useState(false)
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [collectionProgress, setCollectionProgress] = useState<CollectionProgressResponse | null>(null)
  const [refreshError, setRefreshError] = useState('')

  const [records, setRecords] = useState<Record<RecordScope, RecordListResponse>>(emptyRecordLists)
  const [recordLoading, setRecordLoading] = useState<Record<RecordScope, boolean>>(emptyRecordLoading)
  const [recordErrors, setRecordErrors] = useState<Record<RecordScope, string>>(emptyRecordErrors)
  const [recordLimits, setRecordLimits] = useState<Record<RecordScope, number>>(emptyRecordLimits)
  const [lookup, setLookup] = useState(initialLookupState)

  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState('')
  const [automationSources, setAutomationSources] = useState<AutomationSource[]>([])
  const [automationSourcesError, setAutomationSourcesError] = useState('')
  const [selectedIpAutomationSource, setSelectedIpAutomationSource] = useState('')
  const [selectedIpAutomationDeviceIds, setSelectedIpAutomationDeviceIds] = useState<string[]>([])
  const [selectedLldpAutomationSource, setSelectedLldpAutomationSource] = useState('')
  const [selectedLldpAutomationDeviceIds, setSelectedLldpAutomationDeviceIds] = useState<string[]>([])
  const [deviceSearch, setDeviceSearch] = useState('')
  const [deviceVisibleCount, setDeviceVisibleCount] = useState(DEFAULT_PAGE_SIZE)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [configPreview, setConfigPreview] = useState<ConfigPreviewResponse | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState('')

  const [vrfGroups, setVrfGroups] = useState<VrfGroupListResponse>({ scope: 'vrf', total_count: 0, items: [] })
  const [vrfLoading, setVrfLoading] = useState(false)
  const [vrfError, setVrfError] = useState('')
  const [vrfLimit, setVrfLimit] = useState(DEFAULT_PAGE_SIZE)
  const [vrfFilter, setVrfFilter] = useState('')
  const [excludeDefaultVrf, setExcludeDefaultVrf] = useState(true)
  const [selectedVrfName, setSelectedVrfName] = useState('')
  const [vrfMemberFilter, setVrfMemberFilter] = useState('')

  const [vniGroups, setVniGroups] = useState<VniGroupListResponse>({ scope: 'vni', total_count: 0, items: [] })
  const [vniLoading, setVniLoading] = useState(false)
  const [vniError, setVniError] = useState('')
  const [vniLimit, setVniLimit] = useState(DEFAULT_PAGE_SIZE)
  const [vniFilter, setVniFilter] = useState('')
  const [selectedVni, setSelectedVni] = useState('')
  const [vniMemberFilter, setVniMemberFilter] = useState('')

  const [configSearchQuery, setConfigSearchQuery] = useState('')
  const [configSearchLimit, setConfigSearchLimit] = useState(DEFAULT_PAGE_SIZE)
  const [configSearchState, setConfigSearchState] = useState(initialConfigSearchState)
  const [configSearchOverlay, setConfigSearchOverlay] = useState(initialConfigSearchOverlayState)
  const [showConfigGuide, setShowConfigGuide] = useState(false)

  const [ipQuery, setIpQuery] = useState('')
  const [ipVrf, setIpVrf] = useState('')
  const [bgpAsn, setBgpAsn] = useState('')
  const [vlanId, setVlanId] = useState('')
  const [vlanName, setVlanName] = useState('')

  const deferredDeviceSearch = useDeferredValue(deviceSearch)
  const currentView = viewMeta[activeView]
  const currentScope = isRecordScope(activeView) ? activeView : null
  const activeConfigDevice = devices.find((item) => item.device_id === selectedDeviceId)
  const showSnapshotRefreshPanels = !['kanban', 'work_tool', 'work_plan', 'edm_link'].includes(activeView)

  const filteredDevices = useMemo(() => {
    const token = deferredDeviceSearch.trim().toLowerCase()
    if (!token) {
      return devices
    }

    return devices.filter((device) =>
      [device.hostname, device.mgmt_ip, device.model, device.site, device.serial].join(' ').toLowerCase().includes(token),
    )
  }, [deferredDeviceSearch, devices])

  const visibleDevices = useMemo(
    () => filteredDevices.slice(0, deviceVisibleCount),
    [filteredDevices, deviceVisibleCount],
  )

  const selectedVrfGroup = useMemo(
    () => vrfGroups.items.find((item) => item.vrf_name === selectedVrfName) ?? null,
    [selectedVrfName, vrfGroups.items],
  )
  const filteredVrfDevices = useMemo(() => {
    if (!selectedVrfGroup) {
      return []
    }
    const token = vrfMemberFilter.trim().toLowerCase()
    if (!token) {
      return selectedVrfGroup.devices
    }
    return selectedVrfGroup.devices.filter((device) => device.hostname.toLowerCase().includes(token))
  }, [selectedVrfGroup, vrfMemberFilter])
  const selectedVniGroup = useMemo(
    () => vniGroups.items.find((item) => item.vni === selectedVni) ?? null,
    [selectedVni, vniGroups.items],
  )
  const filteredVniDevices = useMemo(() => {
    if (!selectedVniGroup) {
      return []
    }
    const token = vniMemberFilter.trim().toLowerCase()
    if (!token) {
      return selectedVniGroup.devices
    }
    return selectedVniGroup.devices.filter((device) => device.hostname.toLowerCase().includes(token))
  }, [selectedVniGroup, vniMemberFilter])

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void initializeSession()
  }, [])

  useEffect(() => {
    if (collectionProgress?.status !== 'running') {
      return undefined
    }

    const timer = window.setInterval(() => {
      void pollCollectionStatus()
    }, 1000)

    return () => window.clearInterval(timer)
  }, [collectionProgress?.status])
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    setDeviceVisibleCount(DEFAULT_PAGE_SIZE)
  }, [deferredDeviceSearch])

  useEffect(() => {
    if (!vrfGroups.items.length) {
      setSelectedVrfName('')
      return
    }

    if (!selectedVrfName || !vrfGroups.items.some((item) => item.vrf_name === selectedVrfName)) {
      setSelectedVrfName(vrfGroups.items[0].vrf_name)
    }
  }, [selectedVrfName, vrfGroups.items])

  useEffect(() => {
    setVrfMemberFilter('')
  }, [selectedVrfName])

  useEffect(() => {
    if (!vniGroups.items.length) {
      setSelectedVni('')
      return
    }

    if (!selectedVni || !vniGroups.items.some((item) => item.vni === selectedVni)) {
      setSelectedVni(vniGroups.items[0].vni)
    }
  }, [selectedVni, vniGroups.items])

  useEffect(() => {
    setVniMemberFilter('')
  }, [selectedVni])

  useEffect(() => {
    if (!automationSources.length) {
      setSelectedIpAutomationSource('')
      setSelectedIpAutomationDeviceIds([])
      setSelectedLldpAutomationSource('')
      setSelectedLldpAutomationDeviceIds([])
      return
    }

    if (!selectedIpAutomationSource || !automationSources.some((source) => source.name === selectedIpAutomationSource)) {
      setSelectedIpAutomationSource(automationSources[0].name)
      setSelectedIpAutomationDeviceIds([])
    }

    if (!selectedLldpAutomationSource || !automationSources.some((source) => source.name === selectedLldpAutomationSource)) {
      setSelectedLldpAutomationSource(automationSources[0].name)
      setSelectedLldpAutomationDeviceIds([])
    }
  }, [automationSources, selectedIpAutomationSource, selectedLldpAutomationSource])

  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('.rail-nav.grouped')
    if (!nav) {
      return
    }

    const measureOverflow = () => {
      const nextScrollable = nav.scrollHeight > nav.clientHeight + 2
      setRailNavScrollable((current) => (current === nextScrollable ? current : nextScrollable))
    }

    measureOverflow()
    const frameId = window.requestAnimationFrame(measureOverflow)
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureOverflow) : null
    resizeObserver?.observe(nav)
    window.addEventListener('resize', measureOverflow)

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', measureOverflow)
    }
  }, [managementOpen, automationOpen, kanbanOpen, showSnapshotRefreshPanels])

  useEffect(() => {
    if (!configSearchOverlay.open && !showConfigGuide) {
      return
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      if (configSearchOverlay.open) {
        setConfigSearchOverlay(initialConfigSearchOverlayState)
      }
      if (showConfigGuide) {
        setShowConfigGuide(false)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [configSearchOverlay.open, showConfigGuide])

  async function initializeSession() {
    try {
      setAuthError('')
      const user = await api.getCurrentUser()
      setCurrentUser(user)
      await Promise.all([loadUsers(), bootstrap()])
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null)
        setUsers([])
        return
      }
      setAuthError(error instanceof Error ? error.message : '세션을 확인하지 못했습니다.')
    } finally {
      setAuthReady(true)
    }
  }

  async function loadUsers() {
    const loadedUsers = await api.getUsers()
    setUsers(loadedUsers)
    return loadedUsers
  }

  async function handleLogin(username: string, password: string) {
    try {
      setAuthSubmitting(true)
      setAuthError('')
      const response = await api.login(username, password)
      setCurrentUser(response.user)
      await Promise.all([loadUsers(), bootstrap()])
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '로그인하지 못했습니다.')
    } finally {
      setAuthSubmitting(false)
      setAuthReady(true)
    }
  }

  async function handleLogout() {
    try {
      await api.logout()
    } catch {
      // Ignore logout failures and force local sign-out.
    } finally {
      setCurrentUser(null)
      setUsers([])
      setAccountModalOpen(false)
      setAuthError('')
      setAutomationSources([])
      setAutomationSourcesError('')
      setSelectedIpAutomationSource('')
      setSelectedIpAutomationDeviceIds([])
      setSelectedLldpAutomationSource('')
      setSelectedLldpAutomationDeviceIds([])
    }
  }

  async function handleCreateUser(payload: UserCreateInput) {
    try {
      setAccountActionBusy(true)
      setAccountActionError('')
      setAccountActionSuccess('')
      await api.createUser(payload)
      await loadUsers()
      setAccountActionSuccess('사용자를 생성했습니다.')
    } catch (error) {
      setAccountActionError(error instanceof Error ? error.message : '사용자를 생성하지 못했습니다.')
    } finally {
      setAccountActionBusy(false)
    }
  }

  async function handleDeleteUser(userId: number) {
    try {
      setAccountActionBusy(true)
      setAccountActionError('')
      setAccountActionSuccess('')
      await api.deleteUser(userId)
      await loadUsers()
      setAccountActionSuccess('사용자를 삭제했습니다.')
    } catch (error) {
      setAccountActionError(error instanceof Error ? error.message : '사용자를 삭제하지 못했습니다.')
    } finally {
      setAccountActionBusy(false)
    }
  }

  async function handleChangePassword(currentPassword: string, newPassword: string) {
    try {
      setAccountActionBusy(true)
      setAccountActionError('')
      setAccountActionSuccess('')
      const updatedUser = await api.changePassword(currentPassword, newPassword)
      setCurrentUser(updatedUser)
      setAccountActionSuccess('비밀번호를 변경했습니다.')
    } catch (error) {
      setAccountActionError(error instanceof Error ? error.message : '비밀번호를 변경하지 못했습니다.')
    } finally {
      setAccountActionBusy(false)
    }
  }

  async function bootstrap() {
    await Promise.all([
      loadOverview(),
      loadCollectionStatus(),
      loadDevices(),
      loadAutomationSources(),
      loadRecord('ip', DEFAULT_PAGE_SIZE),
      loadRecord('bgp', DEFAULT_PAGE_SIZE),
      loadRecord('vlan', DEFAULT_PAGE_SIZE),
      loadVniGroups(DEFAULT_PAGE_SIZE),
      loadVrfGroups(DEFAULT_PAGE_SIZE),
    ])
  }

  async function pollCollectionStatus() {
    try {
      const status = await api.getCollectionStatus()
      setCollectionProgress(status)
      if (status.status !== 'running') {
        await Promise.all([
          loadOverview(),
          loadDevices(),
          loadAutomationSources(),
          loadRecord('ip', recordLimits.ip),
          loadRecord('bgp', recordLimits.bgp),
          loadRecord('vlan', recordLimits.vlan),
          loadVniGroups(vniLimit),
          loadVrfGroups(vrfLimit),
        ])
        if (selectedDeviceId) {
          await loadConfigPreview(selectedDeviceId)
        }
        if (configSearchState.result?.query) {
          await performConfigSearch(configSearchState.result.query, configSearchLimit)
        }
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '수집 상태를 확인하지 못했습니다.')
    }
  }

  async function loadAutomationSources() {
    try {
      setAutomationSourcesError('')
      const response = await api.getAutomationSources()
      setAutomationSources(response)
    } catch (error) {
      setAutomationSources([])
      setAutomationSourcesError(error instanceof Error ? error.message : '자동화용 CVP source 목록을 불러오지 못했습니다.')
    }
  }

  async function loadOverview() {
    try {
      setOverviewError('')
      const response = await api.getOverview()
      setOverview(response)
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : '개요를 불러오지 못했습니다.')
    }
  }

  async function loadCollectionStatus() {
    try {
      const response = await api.getCollectionStatus()
      setCollectionProgress(response)
    } catch {
      setCollectionProgress(null)
    }
  }

  async function loadDevices() {
    try {
      setDevicesLoading(true)
      setDevicesError('')
      const response = await api.getDevices()
      setDevices(response)
    } catch (error) {
      setDevicesError(error instanceof Error ? error.message : '장비 목록을 불러오지 못했습니다.')
    } finally {
      setDevicesLoading(false)
    }
  }

  async function loadRecord(scope: RecordScope, limit = DEFAULT_PAGE_SIZE) {
    try {
      setRecordLimits((current) => ({ ...current, [scope]: limit }))
      setRecordLoading((current) => ({ ...current, [scope]: true }))
      setRecordErrors((current) => ({ ...current, [scope]: '' }))
      const extraQuery = scope === 'ip' && ipVrf.trim() ? `&vrf=${encodeURIComponent(ipVrf.trim())}` : ''
      const response = await api.getRecords(scope, limit, extraQuery)
      setRecords((current) => ({ ...current, [scope]: response }))
    } catch (error) {
      setRecordErrors((current) => ({
        ...current,
        [scope]: error instanceof Error ? error.message : '목록을 불러오지 못했습니다.',
      }))
    } finally {
      setRecordLoading((current) => ({ ...current, [scope]: false }))
    }
  }

  async function loadVrfGroups(limit = DEFAULT_PAGE_SIZE) {
    try {
      setVrfLimit(limit)
      setVrfLoading(true)
      setVrfError('')
      const response = await api.getVrfGroups(limit, excludeDefaultVrf, vrfFilter.trim())
      setVrfGroups(response)
    } catch (error) {
      setVrfError(error instanceof Error ? error.message : 'VRF 목록을 불러오지 못했습니다.')
    } finally {
      setVrfLoading(false)
    }
  }

  async function loadVniGroups(limit = DEFAULT_PAGE_SIZE) {
    try {
      setVniLimit(limit)
      setVniLoading(true)
      setVniError('')
      const response = await api.getVniGroups(limit, vniFilter.trim())
      setVniGroups(response)
    } catch (error) {
      setVniError(error instanceof Error ? error.message : 'VNI 목록을 불러오지 못했습니다.')
    } finally {
      setVniLoading(false)
    }
  }

  async function loadConfigPreview(deviceId: string) {
    try {
      setConfigLoading(true)
      setConfigError('')
      const response = await api.getConfig(deviceId)
      setConfigPreview(response)
    } catch (error) {
      setConfigPreview(null)
      setConfigError(error instanceof Error ? error.message : 'Config를 불러오지 못했습니다.')
    } finally {
      setConfigLoading(false)
    }
  }

  async function performConfigSearch(query: string, limit = DEFAULT_PAGE_SIZE) {
    const token = query.trim()
    if (!token) {
      setConfigSearchState(initialConfigSearchState)
      return
    }

    try {
      setConfigSearchLimit(limit)
      setConfigSearchState({ loading: true, error: '', result: null })
      const response = await api.searchConfig(token, limit)
      setConfigSearchState({ loading: false, error: '', result: response })
    } catch (error) {
      setConfigSearchState({
        loading: false,
        error: error instanceof Error ? error.message : 'Config 검색에 실패했습니다.',
        result: null,
      })
    }
  }

  async function handleStartRefresh() {
    try {
      setRefreshError('')
      const response = await api.startRefresh()
      setCollectionProgress(response)
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '스냅샷 갱신을 시작하지 못했습니다.')
    }
  }

  async function handleLookupSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLookup({ loading: true, error: '', result: null })

    try {
      let result: LookupResponse
      switch (activeView) {
        case 'ip':
          result = await api.lookupIp(ipQuery, ipVrf || undefined)
          break
        case 'bgp':
          result = await api.lookupBgp(bgpAsn)
          break
        case 'vlan':
          result = await api.lookupVlan(vlanId || undefined, vlanName || undefined)
          break
        default:
          throw new Error('이 화면에서는 조회를 실행할 수 없습니다.')
      }

      setLookup({ loading: false, error: '', result })
    } catch (error) {
      setLookup({
        loading: false,
        error: error instanceof Error ? error.message : '조회에 실패했습니다.',
        result: null,
      })
    }
  }

  function resetLookup() {
    setLookup(initialLookupState)
  }

  async function handleDeviceSelect(deviceId: string) {
    setSelectedDeviceId(deviceId)
    await loadConfigPreview(deviceId)
  }

  function handleIpAutomationSourceChange(source: string) {
    setSelectedIpAutomationSource(source)
    setSelectedIpAutomationDeviceIds([])
  }

  function handleLldpAutomationSourceChange(source: string) {
    setSelectedLldpAutomationSource(source)
    setSelectedLldpAutomationDeviceIds([])
  }

  async function handleConfigSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await performConfigSearch(configSearchQuery, DEFAULT_PAGE_SIZE)
  }

  function resetConfigSearch() {
    setConfigSearchQuery('')
    setConfigSearchLimit(DEFAULT_PAGE_SIZE)
    setConfigSearchState(initialConfigSearchState)
    setConfigSearchOverlay(initialConfigSearchOverlayState)
  }

  function changeView(view: ViewId) {
    startTransition(() => {
      setActiveView(view)
      setLookup(initialLookupState)
      setConfigError('')
      setShowConfigGuide(false)
      setConfigSearchOverlay(initialConfigSearchOverlayState)
      if (view !== 'devices') {
        setConfigPreview(null)
      }
    })
  }

  async function handleCopyConfigPreview() {
    if (!configPreview) {
      return
    }
    try {
      await copyPlainText(configPreview.content)
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Config 복사에 실패했습니다.')
    }
  }

  async function handleCopyOverlayConfig() {
    if (!configSearchOverlay.preview) {
      return
    }
    try {
      await copyPlainText(configSearchOverlay.preview.content)
    } catch (error) {
      setConfigSearchOverlay((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Config 복사에 실패했습니다.',
      }))
    }
  }

  async function openConfigSearchOverlay(match: ConfigSearchMatch) {
    setConfigSearchOverlay({
      open: true,
      loading: true,
      error: '',
      match,
      preview: null,
    })

    try {
      const preview = await api.getConfig(match.device_id)
      setConfigSearchOverlay({
        open: true,
        loading: false,
        error: '',
        match,
        preview,
      })
    } catch (error) {
      setConfigSearchOverlay({
        open: true,
        loading: false,
        error: error instanceof Error ? error.message : '전체 Config를 불러오지 못했습니다.',
        match,
        preview: null,
      })
    }
  }

  function closeConfigSearchOverlay() {
    setConfigSearchOverlay(initialConfigSearchOverlayState)
  }

  async function reloadCurrentViewList() {
    if (activeView === 'devices') {
      await loadDevices()
      if (selectedDeviceId) {
        await loadConfigPreview(selectedDeviceId)
      }
      return
    }

    if (activeView === 'automation_ip_tags' || activeView === 'automation_lldp_tags') {
      await loadAutomationSources()
      return
    }

    if (activeView === 'vrf') {
      await loadVrfGroups(vrfLimit)
      return
    }

    if (activeView === 'vni') {
      await loadVniGroups(vniLimit)
      return
    }

    if (activeView === 'config') {
      if (configSearchQuery.trim()) {
        await performConfigSearch(configSearchQuery, configSearchLimit)
      }
      return
    }

    if (currentScope) {
      await loadRecord(currentScope, recordLimits[currentScope])
    }
  }

  if (!authReady) {
    return (
      <div className="auth-screen">
        <div className="auth-panel auth-panel-compact">
          <p className="eyebrow">Access Control</p>
          <h1>세션 확인 중</h1>
          <p>현재 로그인 상태를 확인하고 있습니다.</p>
        </div>
      </div>
    )
  }

  if (!currentUser) {
    return <LoginScreen submitting={authSubmitting} error={authError} onSubmit={handleLogin} />
  }

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-block">
          <div className="brand-mark">
            <Database />
          </div>
          <div>
            <p className="brand-kicker">CVP Snapshot Console</p>
            <h1>현황 관리 포털</h1>
          </div>
        </div>

        <div className="rail-copy">
          <p>CVP 등록 장비의 현황과 사용 여부를 조회하는 읽기 전용 운영 포털입니다.</p>
        </div>

        <nav className={`rail-nav grouped ${railNavScrollable ? 'scrollable' : 'static'}`}>
          <button className={`rail-home-link ${activeView === 'home' ? 'active' : ''}`} onClick={() => changeView('home')}>
            <House />
            <div>
              <span>{viewMeta.home.label}</span>
              <small>{viewMeta.home.eyebrow}</small>
            </div>
          </button>

          <SidebarSection
            title="작업 보드"
            open={kanbanOpen}
            onToggle={() => setKanbanOpen((value) => !value)}
            items={kanbanViews}
            activeView={activeView}
            onSelect={changeView}
          />

          <SidebarSection
            title="현황 관리"
            open={managementOpen}
            onToggle={() => setManagementOpen((value) => !value)}
            items={managementViews}
            activeView={activeView}
            onSelect={changeView}
          />

          <SidebarSection
            title="자동화 툴"
            open={automationOpen}
            onToggle={() => setAutomationOpen((value) => !value)}
            items={automationViews}
            activeView={activeView}
            onSelect={changeView}
          />

        </nav>

        <div className="rail-footer">
          <div className="user-panel">
            <div className="user-panel-head">
              <div className="user-panel-copy">
                <strong>{currentUser.display_name}</strong>
                <span>@{currentUser.username}</span>
              </div>
              <span className={`user-role-chip ${currentUser.role}`}>{currentUser.role}</span>
            </div>
            <div className="user-panel-actions">
              <button
                className="user-panel-button"
                type="button"
                onClick={() => {
                  setAccountActionError('')
                  setAccountActionSuccess('')
                  setAccountModalOpen(true)
                }}
              >
                <UserCog size={14} />
                <span>계정</span>
              </button>
              <button className="user-panel-button" type="button" onClick={() => void handleLogout()}>
                <LogOut size={14} />
                <span>로그아웃</span>
              </button>
            </div>
          </div>
          <button className="refresh-button" onClick={() => void handleStartRefresh()} disabled={collectionProgress?.status === 'running'}>
            <RefreshCcw className={collectionProgress?.status === 'running' ? 'spin' : ''} />
            <span>{collectionProgress?.status === 'running' ? '스냅샷 갱신 중' : '스냅샷 갱신'}</span>
          </button>
        </div>
      </aside>
      <main className="workspace">
        {!kanbanViews.includes(activeView) ? (
          <section className="hero-panel compact">
            <div className="hero-copy">
              <p className="eyebrow">{currentView.eyebrow}</p>
              <h2>{currentView.title}</h2>
              <p>{currentView.description}</p>
            </div>

            <div className="hero-meta">
              <div className="hero-chip">
                <Clock3 />
                <span>{overview?.latest_collection_at ? formatDateTime(overview.latest_collection_at) : '수집 기록 없음'}</span>
              </div>
              <div className={`hero-chip ${collectionProgress?.status === 'running' ? 'accent' : ''}`}>
                <Activity />
                <span>{translateCollectionStatus(collectionProgress, overview?.latest_job?.status)}</span>
              </div>
            </div>
          </section>
        ) : null}

        {showSnapshotRefreshPanels && collectionProgress ? <CollectionProgressCard progress={collectionProgress} /> : null}
        {overviewError ? <div className="message-banner error">{overviewError}</div> : null}
        {showSnapshotRefreshPanels && refreshError ? <div className="message-banner error">{refreshError}</div> : null}

        {activeView === 'home' ? renderHome(overview) : null}

        {activeView === 'devices' ? (
          <section className="content-grid devices-mode">
            <div className="main-card">
              <div className="card-head">
                <div>
                  <p className="section-kicker">Device Inventory</p>
                  <h3>장비 목록</h3>
                </div>
                <div className="toolbar-row">
                  <div className="inline-filter">
                    <Search />
                    <input
                      value={deviceSearch}
                      onChange={(event) => setDeviceSearch(event.target.value)}
                      placeholder="Hostname, serial, model, site"
                    />
                  </div>
                  <button className="secondary-action" onClick={() => void reloadCurrentViewList()}>
                    <RefreshCcw />
                    <span>목록 다시 불러오기</span>
                  </button>
                </div>
              </div>

              <DisplayCount visible={visibleDevices.length} total={filteredDevices.length} />
              {devicesLoading ? <PanelState title="장비 목록을 불러오는 중입니다." body="최신 스냅샷 장비 정보를 조회하고 있습니다." /> : null}
              {devicesError ? <div className="message-banner error">{devicesError}</div> : null}

              {!devicesLoading ? (
                <>
                  <div className="table-shell">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Hostname</th>
                          <th>Mgmt IP</th>
                          <th>Model</th>
                          <th>Site</th>
                          <th>Config</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDevices.map((device) => (
                          <tr
                            key={device.device_id}
                            className={device.device_id === selectedDeviceId ? 'selected' : ''}
                            onClick={() => void handleDeviceSelect(device.device_id)}
                          >
                            <td>
                              <div className="primary-cell">
                                <strong>{device.hostname}</strong>
                                <span>{device.serial}</span>
                              </div>
                            </td>
                            <td className="mono-cell">{device.mgmt_ip || '-'}</td>
                            <td>{device.model || '-'}</td>
                            <td>{device.site || '-'}</td>
                            <td>
                              <button
                                className="ghost-action"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleDeviceSelect(device.device_id)
                                }}
                              >
                                <FileSearch />
                                <span>미리보기</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <LoadMoreBar
                    visible={visibleDevices.length}
                    total={filteredDevices.length}
                    onMore={() => setDeviceVisibleCount((value) => value + LOAD_MORE_STEP)}
                  />
                </>
              ) : null}
            </div>

            <aside className="side-card">
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">Config Backup</p>
                  <h3>{activeConfigDevice?.hostname ?? '장비를 선택하세요'}</h3>
                </div>
                {configPreview ? (
                  <button
                    className="ghost-action icon-action"
                    type="button"
                    onClick={() => void handleCopyConfigPreview()}
                    title="전체 Config 복사"
                    aria-label="전체 Config 복사"
                  >
                    <Copy size={15} />
                  </button>
                ) : null}
              </div>

              {!selectedDeviceId ? <PanelState title="Config 미리보기" body="왼쪽 장비를 선택하면 최신 Config 백업을 확인할 수 있습니다." /> : null}
              {configLoading ? <PanelState title="Config를 불러오는 중입니다." body="최신 백업 파일을 여는 중입니다." /> : null}
              {configError ? <div className="message-banner error">{configError}</div> : null}
              {configPreview ? (
                <div className="config-preview">
                  <div className="config-meta">
                    <div>
                      <span>Collected</span>
                      <strong>{formatDateTime(configPreview.collected_at)}</strong>
                    </div>
                    <div>
                      <span>Lines</span>
                      <strong>{configPreview.line_count}</strong>
                    </div>
                    <div>
                      <span>Hash</span>
                      <strong className="mono-cell">{configPreview.config_hash.slice(0, 12)}</strong>
                    </div>
                  </div>
                  <pre>{configPreview.content}</pre>
                </div>
              ) : null}
            </aside>
          </section>
        ) : null}

        {currentScope ? (
          <section className="stack-layout">
            <div className="main-card">
              <div className="card-head">
                <div>
                  <p className="section-kicker">Lookup</p>
                  <h3>검색 및 현황 확인</h3>
                </div>
                <div className="toolbar-row">
                  <button className="secondary-action" onClick={() => void reloadCurrentViewList()}>
                    <RefreshCcw />
                    <span>목록 다시 불러오기</span>
                  </button>
                  <button className="secondary-action" onClick={resetLookup}>
                    <ShieldAlert />
                    <span>검색 초기화</span>
                  </button>
                </div>
              </div>

              <form className="lookup-form" onSubmit={handleLookupSubmit}>
                {activeView === 'ip' ? (
                  <>
                    <Field label="IP 또는 대역" value={ipQuery} onChange={setIpQuery} placeholder="예: 10.10.100.10 또는 10.10.100.0/24" />
                    <Field label="VRF (선택)" value={ipVrf} onChange={setIpVrf} placeholder="예: default, MGMT, Tenant_A" />
                  </>
                ) : null}

                {activeView === 'bgp' ? <Field label="AS 번호" value={bgpAsn} onChange={setBgpAsn} placeholder="예: 65101" /> : null}

                {activeView === 'vlan' ? (
                  <>
                    <Field label="VLAN ID" value={vlanId} onChange={setVlanId} placeholder="예: 100" />
                    <Field label="VLAN 이름" value={vlanName} onChange={setVlanName} placeholder="예: WEB_MGMT" />
                  </>
                ) : null}

                <div className="lookup-actions">
                  <button className="primary-action" disabled={lookup.loading}>
                    <RefreshCcw className={lookup.loading ? 'spin' : ''} />
                    <span>{lookup.loading ? '조회 중...' : '조회 실행'}</span>
                  </button>
                </div>
              </form>

              {lookup.error ? <div className="message-banner error">{lookup.error}</div> : null}

              {lookup.result ? (
                <div className="result-block">
                  <SectionHeader title="검색 결과" note={`Exact ${lookup.result.exact_match_count} / Related ${lookup.result.related_match_count}`} />
                  <div className="result-summary">
                    <StatusPill status={lookup.result.status} />
                    <div>
                      <strong>{lookup.result.summary}</strong>
                      <p>검색 결과는 운영 판단 보조를 위한 참고 정보입니다.</p>
                    </div>
                  </div>
                  {lookup.result.matches.length > 0 ? (
                    <div className="table-shell">{renderRecordTable(currentScope, lookup.result.matches, true)}</div>
                  ) : (
                    <PanelState title="일치하는 항목이 없습니다." body="현재 검색 조건과 정확히 일치하는 데이터가 스냅샷에 없습니다." />
                  )}
                </div>
              ) : null}

              <div className="result-block compact-top">
                <SectionHeader title="현재 스냅샷 목록" note="목록은 200건 단위로 더 보기 할 수 있습니다." />
                <DisplayCount visible={records[currentScope].items.length} total={records[currentScope].total_count} />
                {recordErrors[currentScope] ? <div className="message-banner error">{recordErrors[currentScope]}</div> : null}
                {recordLoading[currentScope] ? (
                  <PanelState title="목록을 불러오는 중입니다." body="현재 스냅샷 데이터를 읽고 있습니다." />
                ) : records[currentScope].items.length > 0 ? (
                  <>
                    <div className="table-shell">{renderRecordTable(currentScope, records[currentScope].items, false)}</div>
                    <LoadMoreBar
                      visible={records[currentScope].items.length}
                      total={records[currentScope].total_count}
                      onMore={() => void loadRecord(currentScope, recordLimits[currentScope] + LOAD_MORE_STEP)}
                    />
                  </>
                ) : (
                  <PanelState title="표시할 목록이 없습니다." body="현재 스냅샷에 해당 항목이 없거나 아직 수집되지 않았습니다." />
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeView === 'vni' ? (
          <section className="content-grid">
            <div className="main-card">
              <div className="card-head">
                <div>
                  <p className="section-kicker">VNI Summary</p>
                  <h3>VNI 기준 확장 현황</h3>
                </div>
                <div className="toolbar-row">
                  <div className="inline-filter">
                    <Search />
                    <input
                      value={vniFilter}
                      onChange={(event) => setVniFilter(event.target.value)}
                      placeholder="VNI 검색"
                    />
                  </div>
                  <button className="secondary-action" onClick={() => void loadVniGroups(DEFAULT_PAGE_SIZE)}>
                    <RefreshCcw />
                    <span>목록 다시 불러오기</span>
                  </button>
                </div>
              </div>

              <DisplayCount visible={vniGroups.items.length} total={vniGroups.total_count} />
              {vniError ? <div className="message-banner error">{vniError}</div> : null}
              {vniLoading ? (
                <PanelState title="VNI 목록을 불러오는 중입니다." body="장비별 VNI와 VLAN 확장 관계를 정리하고 있습니다." />
              ) : vniGroups.items.length > 0 ? (
                <>
                  <div className="table-shell compact-table-shell">
                    <table className="data-table narrow">
                      <thead>
                        <tr>
                          <th>VNI</th>
                          <th>장비 수</th>
                          <th>VLAN</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vniGroups.items.map((item) => (
                          <tr
                            key={item.vni}
                            className={item.vni === selectedVni ? 'selected' : ''}
                            onClick={() => setSelectedVni(item.vni)}
                          >
                            <td className="mono-cell">{item.vni}</td>
                            <td>{item.device_count}</td>
                            <td>{item.vlan_ids.join(', ') || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <LoadMoreBar
                    visible={vniGroups.items.length}
                    total={vniGroups.total_count}
                    onMore={() => void loadVniGroups(vniLimit + LOAD_MORE_STEP)}
                  />
                </>
              ) : (
                <PanelState title="표시할 VNI가 없습니다." body="필터 조건에 맞는 VNI가 없거나 아직 수집되지 않았습니다." />
              )}
            </div>

            <aside className="side-card">
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">VNI Device Members</p>
                  <h3>{selectedVniGroup?.vni ?? 'VNI를 선택하세요'}</h3>
                </div>
              </div>

              {!selectedVniGroup ? (
                <PanelState title="장비 목록 대기 중" body="왼쪽 표에서 VNI를 선택하면 연결된 장비와 VLAN을 확인할 수 있습니다." />
              ) : (
                <>
                  <div className="inline-filter member-filter">
                    <Search />
                    <input
                      value={vniMemberFilter}
                      onChange={(event) => setVniMemberFilter(event.target.value)}
                      placeholder="Hostname 검색"
                    />
                  </div>
                  <div className="result-summary compact-summary">
                    <div>
                      <strong>동일 L2 확장 VLAN</strong>
                      <p>{selectedVniGroup.vlan_ids.join(', ') || '-'}</p>
                    </div>
                    <StatusPill status={selectedVniGroup.device_count > 1 ? 'in_use' : 'available'} />
                  </div>
                  <DisplayCount visible={filteredVniDevices.length} total={selectedVniGroup.device_count} />
                  <div className="table-shell compact-table-shell">
                    <table className="data-table narrow">
                      <thead>
                        <tr>
                          <th>Hostname</th>
                          <th>Mgmt IP</th>
                          <th>VLAN ID</th>
                          <th>VLAN Name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredVniDevices.map((device) => (
                          <tr key={`${selectedVniGroup.vni}-${device.device_id}-${device.vlan_id}`}>
                            <td>{device.hostname}</td>
                            <td className="mono-cell">{device.mgmt_ip || '-'}</td>
                            <td className="mono-cell">{device.vlan_id || '-'}</td>
                            <td>{device.vlan_name || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </aside>
          </section>
        ) : null}

        {activeView === 'vrf' ? (
          <section className="content-grid">
            <div className="main-card">
              <div className="card-head">
                <div>
                  <p className="section-kicker">VRF Summary</p>
                  <h3>VRF 이름 기준 현황</h3>
                </div>
                <div className="toolbar-row">
                  <div className="inline-filter">
                    <Search />
                    <input
                      value={vrfFilter}
                      onChange={(event) => setVrfFilter(event.target.value)}
                      placeholder="VRF 이름 검색"
                    />
                  </div>
                  <label className="toggle-field">
                    <input
                      type="checkbox"
                      checked={excludeDefaultVrf}
                      onChange={(event) => setExcludeDefaultVrf(event.target.checked)}
                    />
                    <span>default VRF 제외</span>
                  </label>
                  <button className="secondary-action" onClick={() => void loadVrfGroups(DEFAULT_PAGE_SIZE)}>
                    <RefreshCcw />
                    <span>목록 다시 불러오기</span>
                  </button>
                </div>
              </div>

              <DisplayCount visible={vrfGroups.items.length} total={vrfGroups.total_count} />
              {vrfError ? <div className="message-banner error">{vrfError}</div> : null}
              {vrfLoading ? (
                <PanelState title="VRF 목록을 불러오는 중입니다." body="VRF 이름별 장비 현황을 정리하고 있습니다." />
              ) : vrfGroups.items.length > 0 ? (
                <>
                  <div className="table-shell compact-table-shell">
                    <table className="data-table narrow">
                      <thead>
                        <tr>
                          <th>VRF 이름</th>
                          <th>장비 수</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vrfGroups.items.map((item) => (
                          <tr
                            key={item.vrf_name}
                            className={item.vrf_name === selectedVrfName ? 'selected' : ''}
                            onClick={() => setSelectedVrfName(item.vrf_name)}
                          >
                            <td>{item.vrf_name}</td>
                            <td>{item.device_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <LoadMoreBar
                    visible={vrfGroups.items.length}
                    total={vrfGroups.total_count}
                    onMore={() => void loadVrfGroups(vrfLimit + LOAD_MORE_STEP)}
                  />
                </>
              ) : (
                <PanelState title="표시할 VRF가 없습니다." body="필터 조건에 맞는 VRF가 없거나 아직 수집되지 않았습니다." />
              )}
            </div>

            <aside className="side-card">
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">VRF Device Members</p>
                  <h3>{selectedVrfGroup?.vrf_name ?? 'VRF를 선택하세요'}</h3>
                </div>
              </div>

              {!selectedVrfGroup ? (
                <PanelState title="장비 목록 대기 중" body="왼쪽 표에서 VRF를 선택하면 포함 장비를 확인할 수 있습니다." />
              ) : (
                <>
                  <div className="inline-filter member-filter">
                    <Search />
                    <input
                      value={vrfMemberFilter}
                      onChange={(event) => setVrfMemberFilter(event.target.value)}
                      placeholder="Hostname 검색"
                    />
                  </div>
                  <DisplayCount visible={filteredVrfDevices.length} total={selectedVrfGroup.device_count} />
                  <div className="table-shell compact-table-shell">
                    <table className="data-table narrow">
                      <thead>
                        <tr>
                          <th>Hostname</th>
                          <th>Mgmt IP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredVrfDevices.map((device) => (
                          <tr key={`${selectedVrfGroup.vrf_name}-${device.device_id}`}>
                            <td>{device.hostname}</td>
                            <td className="mono-cell">{device.mgmt_ip || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </aside>
          </section>
        ) : null}

        {activeView === 'config' ? (
          <section className="stack-layout">
            <div className="main-card">
              <div className="card-head">
                <div>
                  <p className="section-kicker">Global Config Search</p>
                  <h3>전체 Config 본문 검색</h3>
                </div>
                <div className="toolbar-row">
                  <button className="secondary-action" onClick={() => void reloadCurrentViewList()} disabled={!configSearchQuery.trim()}>
                    <RefreshCcw />
                    <span>현재 검색 다시 불러오기</span>
                  </button>
                  <button className="secondary-action" onClick={resetConfigSearch}>
                    <ShieldAlert />
                    <span>검색 초기화</span>
                  </button>
                </div>
              </div>

              <div className="section-headline">
                <h4>검색 입력</h4>
                <button className="secondary-action" onClick={() => setShowConfigGuide(true)} type="button">
                  검색 기준 보기
                </button>
              </div>

              <form className="lookup-form single-line" onSubmit={handleConfigSearchSubmit}>
                <Field
                  label="검색 문자열"
                  value={configSearchQuery}
                  onChange={setConfigSearchQuery}
                  placeholder="예: router bgp, ip route, vlan 200, description UPLINK"
                />
                <div className="lookup-actions inline-actions">
                  <button className="primary-action" disabled={configSearchState.loading || !configSearchQuery.trim()}>
                    <Search />
                    <span>{configSearchState.loading ? '검색 중...' : 'Config 검색'}</span>
                  </button>
                </div>
              </form>

              {configSearchState.error ? <div className="message-banner error">{configSearchState.error}</div> : null}

              {configSearchState.result ? (
                <div className="result-block">
                  <SectionHeader
                    title="검색 결과"
                    note={`장비 ${configSearchState.result.total_count}대 / 매칭 라인 ${configSearchState.result.total_line_matches}건`}
                  />
                  <DisplayCount visible={configSearchState.result.items.length} total={configSearchState.result.total_count} />
                  {configSearchState.result.items.length > 0 ? (
                    <>
                      <div className="config-hit-grid">
                        {configSearchState.result.items.map((item) => (
                          <ConfigSearchCard key={item.device_id} match={item} onPreview={openConfigSearchOverlay} />
                        ))}
                      </div>
                      <LoadMoreBar
                        visible={configSearchState.result.items.length}
                        total={configSearchState.result.total_count}
                        onMore={() => void performConfigSearch(configSearchState.result?.query ?? configSearchQuery, configSearchLimit + LOAD_MORE_STEP)}
                      />
                    </>
                  ) : (
                    <PanelState title="매칭된 Config가 없습니다." body="현재 문자열이 포함된 최신 Config가 스냅샷에 없습니다." />
                  )}
                </div>
              ) : (
                <PanelState title="Config 검색 준비" body="문자열을 입력하면 현재 최신 Config 스냅샷 전체에서 매칭 장비와 줄 번호를 찾아드립니다." />
              )}
            </div>
          </section>
        ) : null}

        {activeView === 'automation_ip_tags' ? (
          <section className="stack-layout">
            {automationSourcesError ? <div className="message-banner error">{automationSourcesError}</div> : null}
            <AutomationConsole
              toolSlug="ip_interface_tags"
              sources={automationSources}
              selectedSource={selectedIpAutomationSource}
              onSelectedSourceChange={handleIpAutomationSourceChange}
              selectedDeviceIds={selectedIpAutomationDeviceIds}
              onSelectedDeviceIdsChange={setSelectedIpAutomationDeviceIds}
              canApply={currentUser.role !== 'viewer'}
            />
          </section>
        ) : null}

        {activeView === 'automation_lldp_tags' ? (
          <section className="stack-layout">
            {automationSourcesError ? <div className="message-banner error">{automationSourcesError}</div> : null}
            <AutomationConsole
              toolSlug="lldp_tags"
              sources={automationSources}
              selectedSource={selectedLldpAutomationSource}
              onSelectedSourceChange={handleLldpAutomationSourceChange}
              selectedDeviceIds={selectedLldpAutomationDeviceIds}
              onSelectedDeviceIdsChange={setSelectedLldpAutomationDeviceIds}
              canApply={currentUser.role !== 'viewer'}
            />
          </section>
        ) : null}

        {activeView === 'edm_link' ? (
          <section className="stack-layout">
            <EdmLinkManager />
          </section>
        ) : null}

        {activeView === 'kanban' ? (
          <section className="stack-layout">
            <KanbanBoard users={users} />
          </section>
        ) : null}

        {activeView === 'work_tool' ? (
          <section className="stack-layout">
            <WorkPlanBoard />
          </section>
        ) : null}

        {activeView === 'work_plan' ? (
          <WorkflowBoard currentUser={currentUser} />
        ) : null}

        {showConfigGuide ? (
          <div className="modal-backdrop" onClick={() => setShowConfigGuide(false)}>
            <div className="modal-card" onClick={(event) => event.stopPropagation()}>
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">Search Guide</p>
                  <h3>Config 검색 기준</h3>
                </div>
                <button className="secondary-action" onClick={() => setShowConfigGuide(false)} type="button">
                  닫기
                </button>
              </div>
              <div className="guide-grid">
                <GuideCard title="검색 범위" body="현재 최신 snapshot에 저장된 장비별 running-config 파일만 검색합니다." />
                <GuideCard title="검색 방식" body="대소문자 구분 없이 문자열 포함 여부로 검색합니다. 정규식 검색은 아직 사용하지 않습니다." />
                <GuideCard title="결과 표시" body="장비별 총 매칭 수와, 앞쪽 3개 매칭 줄을 함께 표시합니다." />
                <GuideCard title="검색 예시" body="router bgp, interface Vlan200, ip route, description UPLINK 같은 문자열을 그대로 넣어 확인할 수 있습니다." />
              </div>
            </div>
          </div>
        ) : null}

        {configSearchOverlay.open ? (
          <div className="modal-backdrop" onClick={closeConfigSearchOverlay}>
            <div className="modal-card config-overlay-card" onClick={(event) => event.stopPropagation()}>
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">Config Overlay</p>
                  <h3>{configSearchOverlay.match?.hostname ?? '전체 Config 보기'}</h3>
                </div>
                <div className="toolbar-row">
                  {configSearchOverlay.preview ? (
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => void handleCopyOverlayConfig()}
                    >
                      <Copy />
                      <span>Config 복사</span>
                    </button>
                  ) : null}
                  <button className="secondary-action icon-action" type="button" onClick={closeConfigSearchOverlay} aria-label="오버레이 닫기">
                    <X />
                  </button>
                </div>
              </div>

              {configSearchOverlay.loading ? (
                <PanelState title="전체 Config를 불러오는 중입니다." body="선택한 장비의 최신 스냅샷 Config를 열고 있습니다." />
              ) : null}
              {configSearchOverlay.error ? <div className="message-banner error">{configSearchOverlay.error}</div> : null}
              {configSearchOverlay.preview && configSearchOverlay.match ? (
                <ConfigSearchOverlayPreview
                  preview={configSearchOverlay.preview}
                  match={configSearchOverlay.match}
                  query={configSearchState.result?.query ?? configSearchQuery}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {accountModalOpen ? (
          <UserSettingsModal
            currentUser={currentUser}
            users={users}
            busy={accountActionBusy}
            error={accountActionError}
            success={accountActionSuccess}
            onClose={() => setAccountModalOpen(false)}
            onCreateUser={handleCreateUser}
            onDeleteUser={handleDeleteUser}
            onChangePassword={handleChangePassword}
          />
        ) : null}
      </main>
    </div>
  )
}

function renderHome(overview: OverviewResponse | null) {
  return (
    <section className="home-stack">
      <section className="overview-grid full-width">
        <MetricCard icon={Server} label="장비" value={overview?.device_count ?? 0} tone="teal" />
        <MetricCard icon={Network} label="IP" value={overview?.ip_count ?? 0} tone="amber" />
        <MetricCard icon={GitBranchPlus} label="BGP" value={overview?.bgp_count ?? 0} tone="sky" />
        <MetricCard icon={Layers3} label="VLAN" value={overview?.vlan_count ?? 0} tone="plum" />
        <MetricCard icon={Layers3} label="VNI" value={overview?.vni_count ?? 0} tone="aqua" />
        <MetricCard icon={Radar} label="VRF" value={overview?.vrf_count ?? 0} tone="forest" />
        <MetricCard icon={FileText} label="Config" value={overview?.config_snapshot_count ?? 0} tone="sunset" />
      </section>

      <section className="home-grid">
        <article className="main-card">
          <SectionHeader title="홈 화면 안내" note="홈에서는 전체 상태만 보고, 각 메뉴에서 세부 조회를 진행합니다." />
          <div className="guide-grid">
            <GuideCard title="장비" body="현재 스냅샷에 등록된 장비 수입니다. 장비 탭에서 목록과 Config를 확인할 수 있습니다." />
            <GuideCard title="IP" body="Config에서 추출한 주소 현황입니다. Loopback과 관리망 중복은 강하게 차단 대상으로 표시합니다." />
            <GuideCard title="BGP / VLAN / VNI / VRF" body="신규 할당 전 조회용 기준 데이터입니다. 특히 VLAN과 VNI는 같은 L2 확장 관계까지 함께 확인할 수 있습니다." />
            <GuideCard title="Config 검색" body="최신 snapshot의 running-config 본문 전체에서 문자열을 검색해 어떤 장비에서 보이는지 빠르게 찾을 수 있습니다." />
          </div>
        </article>

        <aside className="side-card">
          <div className="card-head compact">
            <div>
              <p className="section-kicker">Reading Guide</p>
              <h3>결과 읽는 기준</h3>
            </div>
          </div>
          <div className="legend-stack">
            <LegendItem status="available" title="사용 후보" body="현재 스냅샷에서 직접 보이지 않는 값입니다. 다음 검토 단계로 넘길 수 있습니다." />
            <LegendItem status="in_use" title="이미 사용 중" body="동일 값이 현재 환경에 존재합니다. 신규 할당 전 추가 검토가 필요합니다." />
            <LegendItem status="review" title="검토 필요" body="정확히 같지는 않지만, 대역 또는 문맥이 겹칩니다. 운영 판단이 필요합니다." />
            <LegendItem status="not_available" title="사용 불가" body="Loopback 또는 관리망처럼 재사용을 막아야 하는 경우에 사용합니다." />
          </div>
        </aside>
      </section>
    </section>
  )
}
function renderRecordTable(scope: RecordScope, items: LookupMatch[], isLookupResult: boolean) {
  return (
    <table className="data-table">
      <thead>{renderTableHeader(scope, isLookupResult)}</thead>
      <tbody>{items.map((item, index) => renderTableRow(scope, item, isLookupResult, index))}</tbody>
    </table>
  )
}

function renderTableHeader(scope: RecordScope, isLookupResult: boolean) {
  if (scope === 'ip') {
    return (
      <tr>
        <th>Hostname</th>
        <th>Interface</th>
        <th>{isLookupResult ? 'IP / Prefix' : 'IP'}</th>
        <th>Network</th>
        <th>VRF</th>
        <th>{isLookupResult ? 'Match' : 'Kind'}</th>
      </tr>
    )
  }

  if (scope === 'bgp') {
    return (
      <tr>
        <th>Hostname</th>
        <th>VRF</th>
        <th>ASN</th>
        <th>Router ID</th>
        <th>상태</th>
      </tr>
    )
  }

  return (
    <tr>
      <th>Hostname</th>
      <th>VLAN ID</th>
      <th>VLAN Name</th>
      <th>SVI</th>
      <th>VNI</th>
      <th>L2 확장 VLAN</th>
      <th>Description</th>
    </tr>
  )
}

function renderTableRow(scope: RecordScope, match: LookupMatch, isLookupResult: boolean, index: number) {
  const identity =
    match.details.ip ??
    match.details.asn ??
    match.details.vlan_id ??
    match.interface_name ??
    match.hostname ??
    index
  const key = `${match.device_id}-${String(identity)}-${index}`

  if (scope === 'ip') {
    return (
      <tr key={key}>
        <td>{match.hostname}</td>
        <td>{match.interface_name ?? '-'}</td>
        <td className="mono-cell">{stringifyValue(match.details.ip) || '-'}</td>
        <td className="mono-cell">{stringifyValue(match.details.network) || '-'}</td>
        <td>{match.vrf ?? stringifyValue(match.details.vrf) ?? '-'}</td>
        <td>{isLookupResult ? match.match_type ?? match.label ?? '-' : match.label ?? '-'}</td>
      </tr>
    )
  }

  if (scope === 'bgp') {
    return (
      <tr key={key}>
        <td>{match.hostname}</td>
        <td>{match.vrf ?? '-'}</td>
        <td className="mono-cell">{stringifyValue(match.details.asn) || '-'}</td>
        <td className="mono-cell">{stringifyValue(match.details.router_id) || '-'}</td>
        <td>{match.details.shutdown ? 'shutdown' : 'active'}</td>
      </tr>
    )
  }

  return (
    <tr key={key}>
      <td>{match.hostname}</td>
      <td className="mono-cell">{stringifyValue(match.details.vlan_id) || '-'}</td>
      <td>{stringifyValue(match.details.vlan_name) || '-'}</td>
      <td>{stringifyValue(match.details.svi_name) || '-'}</td>
      <td className="mono-cell">{stringifyValue(match.details.vni) || '-'}</td>
      <td>{stringifyValue(match.details.l2_extension_summary) || '-'}</td>
      <td>{stringifyValue(match.details.description) || '-'}</td>
    </tr>
  )
}

function stringifyValue(value: unknown) {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function translateCollectionStatus(progress: CollectionProgressResponse | null, latestStatus?: string) {
  if (!progress) {
    return latestStatus === 'success' ? '최근 수집 정상' : '수집 상태 확인 필요'
  }

  if (progress.status === 'running') {
    return `스냅샷 갱신 중 (${progress.progress_percent}%)`
  }
  if (progress.status === 'success') {
    return '최근 스냅샷 정상'
  }
  if (progress.status === 'failed') {
    return '최근 스냅샷 실패'
  }
  return '대기 중'
}

function translateProgressStep(step: string) {
  const labels: Record<string, string> = {
    idle: '대기',
    queued: '대기열 등록',
    starting: '수집 시작',
    connect: 'CVP 연결',
    device_inventory: '장비 목록 수집',
    vrf: 'VRF 수집',
    bgp: 'BGP 수집',
    vlan: 'VLAN 수집',
    vni: 'VNI 수집',
    config: 'Config 수집',
    device_details: '장비 세부 수집',
    snapshot_ready: '수집 결과 정리',
    config_files: 'Config 파일 저장',
    database: 'DB 반영',
    completed: '완료',
    failed: '실패',
    load_sample: '샘플 로드',
    prepare_sample: '샘플 준비',
  }

  return labels[step] ?? step
}

function CollectionProgressCard({ progress }: { progress: CollectionProgressResponse }) {
  return (
    <section className="progress-card">
      <div className="progress-head">
        <div>
          <p className="section-kicker">Snapshot Refresh</p>
          <h3>{translateProgressStep(progress.step)}</h3>
        </div>
        <strong>{progress.progress_percent}%</strong>
      </div>
      <p>{progress.detail || '현재 수집 상태를 표시합니다.'}</p>
      <div className="progress-bar">
        <span style={{ width: `${progress.progress_percent}%` }} />
      </div>
    </section>
  )
}

function SidebarSection({
  title,
  open,
  onToggle,
  items,
  activeView,
  onSelect,
}: {
  title: string
  open: boolean
  onToggle: () => void
  items: ViewId[]
  activeView: ViewId
  onSelect: (view: ViewId) => void
}) {
  return (
    <section className="nav-section">
      <button className="section-toggle" onClick={onToggle}>
        <span className="section-title">{title}</span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open ? (
        <div className="section-body">
          {items.map((item) => {
            const meta = viewMeta[item]
            const Icon = meta.icon
            return (
              <button
                key={item}
                className={`rail-sublink ${item === activeView ? 'active' : ''}`}
                onClick={() => onSelect(item)}
              >
                <Icon size={16} />
                <div>
                  <span>{meta.label}</span>
                  <small>{meta.eyebrow}</small>
                </div>
              </button>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function StatusPill({ status }: { status: LookupStatus }) {
  const meta: Record<LookupStatus, { label: string; className: string }> = {
    available: { label: '사용 후보', className: 'status-pill available' },
    in_use: { label: '이미 사용 중', className: 'status-pill in-use' },
    review: { label: '검토 필요', className: 'status-pill review' },
    not_available: { label: '사용 불가', className: 'status-pill blocked' },
    error: { label: '입력 오류', className: 'status-pill error' },
  }

  return <span className={meta[status].className}>{meta[status].label}</span>
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Server
  label: string
  value: number
  tone: string
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon">
        <Icon />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  )
}

function PanelState({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel-state">
      <Database />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function LegendItem({ status, title, body }: { status: LookupStatus; title: string; body: string }) {
  return (
    <div className="legend-item">
      <StatusPill status={status} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  )
}

function GuideCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="guide-card">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function SectionHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="section-headline">
      <h4>{title}</h4>
      <p>{note}</p>
    </div>
  )
}

function DisplayCount({ visible, total }: { visible: number; total: number }) {
  return <p className="list-hint">현재 {visible} / 전체 {total} 표시 중</p>
}

function LoadMoreBar({ visible, total, onMore }: { visible: number; total: number; onMore: () => void }) {
  if (visible >= total || total === 0) {
    return null
  }

  return (
    <div className="load-more-bar">
      <span>{visible}개까지 확인했습니다.</span>
      <button className="secondary-action" onClick={onMore}>
        더 보기 (+200)
      </button>
    </div>
  )
}

function ConfigSearchCard({
  match,
  onPreview,
}: {
  match: ConfigSearchMatch
  onPreview: (match: ConfigSearchMatch) => void
}) {
  return (
    <article className="config-hit-card">
      <div className="config-hit-head">
        <div>
          <strong>{match.hostname}</strong>
          <p>{match.mgmt_ip || 'Mgmt IP 없음'}</p>
        </div>
        <div className="config-hit-actions">
          <span className="config-match-pill">{match.match_count}건 매칭</span>
          <button className="ghost-action compact-action" type="button" onClick={() => onPreview(match)}>
            <FileText />
            <span>전체 Config</span>
          </button>
        </div>
      </div>
      <div className="config-meta compact-meta">
        <div>
          <span>Collected</span>
          <strong>{formatDateTime(match.collected_at)}</strong>
        </div>
      </div>
      <div className="config-line-stack">
        {match.matched_lines.map((line) => (
          <div key={`${match.device_id}-${line.line_number}`} className="config-line-item">
            <span className="mono-cell">Line {line.line_number}</span>
            <code>{line.text || '(blank line)'}</code>
          </div>
        ))}
      </div>
    </article>
  )
}

function ConfigSearchOverlayPreview({
  preview,
  match,
  query,
}: {
  preview: ConfigPreviewResponse
  match: ConfigSearchMatch
  query: string
}) {
  const firstMatchedRowRef = useRef<HTMLDivElement | null>(null)
  const normalizedLines = useMemo(() => normalizeConfigLines(preview.content), [preview.content])
  const normalizedQuery = query.trim().toLowerCase()
  const matchedLineNumbers = useMemo(() => {
    if (!normalizedQuery) {
      return new Set(match.matched_lines.map((line) => line.line_number))
    }

    const next = new Set<number>()
    normalizedLines.forEach((line, index) => {
      if (line.toLowerCase().includes(normalizedQuery)) {
        next.add(index + 1)
      }
    })
    return next
  }, [match.matched_lines, normalizedLines, normalizedQuery])
  const firstMatchedLineNumber = useMemo(() => {
    const values = Array.from(matchedLineNumbers.values())
    return values.length > 0 ? Math.min(...values) : null
  }, [matchedLineNumbers])

  useEffect(() => {
    firstMatchedRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [preview.device_id, normalizedQuery, match.device_id, firstMatchedLineNumber])

  return (
    <div className="config-overlay-shell">
      <div className="config-meta">
        <div>
          <span>Device</span>
          <strong>{preview.hostname}</strong>
        </div>
        <div>
          <span>Collected</span>
          <strong>{formatDateTime(preview.collected_at)}</strong>
        </div>
        <div>
          <span>Match Lines</span>
          <strong>{matchedLineNumbers.size}</strong>
        </div>
      </div>
      <div className="config-overlay-content">
        {normalizedLines.map((line, index) => {
          const lineNumber = index + 1
          const isMatched = matchedLineNumbers.has(lineNumber)
          const ref = lineNumber === firstMatchedLineNumber ? firstMatchedRowRef : undefined

          return (
            <div
              key={`${preview.device_id}-${lineNumber}`}
              ref={ref}
              className={`config-overlay-row ${isMatched ? 'hit' : ''}`}
            >
              <span className="config-overlay-line-number mono-cell">{lineNumber}</span>
              <code className="config-overlay-line-text">
                {renderConfigHighlight(line || ' ', normalizedQuery)}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function normalizeConfigLines(content: string) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function renderConfigHighlight(line: string, normalizedQuery: string) {
  if (!normalizedQuery) {
    return line
  }

  const source = line || ' '
  const lowered = source.toLowerCase()
  const segments: Array<string | ReactNode> = []
  let cursor = 0

  while (cursor < source.length) {
    const foundAt = lowered.indexOf(normalizedQuery, cursor)
    if (foundAt === -1) {
      segments.push(source.slice(cursor))
      break
    }

    if (foundAt > cursor) {
      segments.push(source.slice(cursor, foundAt))
    }

    const end = foundAt + normalizedQuery.length
    segments.push(
      <mark key={`${foundAt}-${end}`} className="config-inline-mark">
        {source.slice(foundAt, end)}
      </mark>,
    )
    cursor = end
  }

  return segments.length > 0 ? segments : source
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

export default App
