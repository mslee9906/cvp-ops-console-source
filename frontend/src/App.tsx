import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Clock3,
  Database,
  FileSearch,
  FileText,
  GitBranchPlus,
  House,
  Layers3,
  Network,
  Radar,
  RefreshCcw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import './App.css'
import { api } from './api'
import type {
  CollectionProgressResponse,
  ConfigPreviewResponse,
  DeviceSummary,
  LookupMatch,
  LookupResponse,
  LookupStatus,
  OverviewResponse,
  RecordListResponse,
  RecordScope,
} from './types'

type ViewId = 'home' | 'ip' | 'bgp' | 'vlan' | 'vrf' | 'devices'

const recordViews: RecordScope[] = ['ip', 'bgp', 'vlan', 'vrf']

const views: Array<{
  id: ViewId
  label: string
  eyebrow: string
  title: string
  description: string
  icon: typeof Search
}> = [
  {
    id: 'home',
    label: '홈',
    eyebrow: 'Snapshot Overview',
    title: 'CVP 현황 대시보드',
    description: '현재 스냅샷의 장비, IP, BGP, VLAN, VRF, Config 현황을 한 번에 확인합니다.',
    icon: House,
  },
  {
    id: 'ip',
    label: 'IP 조회',
    eyebrow: 'Address Readiness',
    title: 'IP 현황 및 사용 가능성 조회',
    description: 'IP 또는 대역을 조회하고, 현재 스냅샷에 있는 주소 목록도 함께 확인합니다.',
    icon: Network,
  },
  {
    id: 'bgp',
    label: 'BGP AS',
    eyebrow: 'Routing Context',
    title: 'BGP AS 사용 현황 조회',
    description: 'ASN이 어디에서 사용 중인지 확인하고, 현재 BGP 목록을 함께 볼 수 있습니다.',
    icon: GitBranchPlus,
  },
  {
    id: 'vlan',
    label: 'VLAN',
    eyebrow: 'Layer 2 Inventory',
    title: 'VLAN 현황 조회',
    description: 'VLAN ID 또는 이름을 확인하고, 현재 스냅샷에 수집된 VLAN 목록을 봅니다.',
    icon: Layers3,
  },
  {
    id: 'vrf',
    label: 'VRF',
    eyebrow: 'Segmentation Map',
    title: 'VRF 현황 조회',
    description: 'VRF 이름을 조회하고, 현재 장비별 VRF 목록을 확인합니다.',
    icon: Radar,
  },
  {
    id: 'devices',
    label: '장비',
    eyebrow: 'Snapshot Inventory',
    title: '장비 및 Config 확인',
    description: '현재 스냅샷 장비 목록과 최신 Config 백업을 확인합니다.',
    icon: Server,
  },
]

const initialLookupState = {
  loading: false,
  error: '',
  result: null as LookupResponse | null,
}

const emptyRecordLists: Record<RecordScope, RecordListResponse> = {
  ip: { scope: 'ip', total_count: 0, items: [] },
  bgp: { scope: 'bgp', total_count: 0, items: [] },
  vlan: { scope: 'vlan', total_count: 0, items: [] },
  vrf: { scope: 'vrf', total_count: 0, items: [] },
}

const emptyRecordLoading: Record<RecordScope, boolean> = {
  ip: false,
  bgp: false,
  vlan: false,
  vrf: false,
}

const emptyRecordErrors: Record<RecordScope, string> = {
  ip: '',
  bgp: '',
  vlan: '',
  vrf: '',
}

function App() {
  const [activeView, setActiveView] = useState<ViewId>('home')
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [collectionProgress, setCollectionProgress] = useState<CollectionProgressResponse | null>(null)
  const [records, setRecords] = useState<Record<RecordScope, RecordListResponse>>(emptyRecordLists)
  const [recordLoading, setRecordLoading] = useState<Record<RecordScope, boolean>>(emptyRecordLoading)
  const [recordErrors, setRecordErrors] = useState<Record<RecordScope, string>>(emptyRecordErrors)
  const [lookup, setLookup] = useState(initialLookupState)
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [configPreview, setConfigPreview] = useState<ConfigPreviewResponse | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState('')
  const [refreshError, setRefreshError] = useState('')

  const [ipQuery, setIpQuery] = useState('')
  const [ipVrf, setIpVrf] = useState('')
  const [bgpAsn, setBgpAsn] = useState('')
  const [vlanId, setVlanId] = useState('')
  const [vlanName, setVlanName] = useState('')
  const [vrfName, setVrfName] = useState('')

  const deferredDeviceSearch = useDeferredValue(deviceSearch)
  const currentView = views.find((view) => view.id === activeView) ?? views[0]
  const currentScope = recordViews.includes(activeView as RecordScope) ? (activeView as RecordScope) : null
  const activeConfigDevice = devices.find((item) => item.device_id === selectedDeviceId)

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void bootstrap()
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

  const filteredDevices = useMemo(() => {
    const token = deferredDeviceSearch.trim().toLowerCase()
    if (!token) {
      return devices
    }

    return devices.filter((device) =>
      [device.hostname, device.mgmt_ip, device.model, device.site, device.serial].join(' ').toLowerCase().includes(token),
    )
  }, [deferredDeviceSearch, devices])

  async function bootstrap() {
    await Promise.all([
      loadOverview(),
      loadCollectionStatus(),
      loadDevices(),
      loadRecord('ip'),
      loadRecord('bgp'),
      loadRecord('vlan'),
      loadRecord('vrf'),
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
          loadRecord('ip'),
          loadRecord('bgp'),
          loadRecord('vlan'),
          loadRecord('vrf'),
        ])
        if (selectedDeviceId) {
          await loadConfigPreview(selectedDeviceId)
        }
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '수집 상태를 확인하지 못했습니다.')
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

  async function loadRecord(scope: RecordScope) {
    try {
      setRecordLoading((current) => ({ ...current, [scope]: true }))
      setRecordErrors((current) => ({ ...current, [scope]: '' }))
      const extraQuery = scope === 'ip' && ipVrf.trim() ? `&vrf=${encodeURIComponent(ipVrf.trim())}` : ''
      const response = await api.getRecords(scope, 200, extraQuery)
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

  async function handleStartRefresh() {
    try {
      setRefreshError('')
      const response = await api.startRefresh()
      setCollectionProgress(response)
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '스냅샷 갱신을 시작하지 못했습니다.')
    }
  }

  async function handleLookupSubmit(event: React.FormEvent<HTMLFormElement>) {
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
        case 'vrf':
          result = await api.lookupVrf(vrfName)
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

  async function handleDeviceSelect(deviceId: string) {
    setSelectedDeviceId(deviceId)
    await loadConfigPreview(deviceId)
  }

  function changeView(view: ViewId) {
    startTransition(() => {
      setActiveView(view)
      setLookup(initialLookupState)
      setConfigError('')
      if (view !== 'devices') {
        setConfigPreview(null)
      }
    })
  }

  async function reloadCurrentViewList() {
    if (activeView === 'devices') {
      await loadDevices()
      if (selectedDeviceId) {
        await loadConfigPreview(selectedDeviceId)
      }
      return
    }

    if (currentScope) {
      await loadRecord(currentScope)
    }
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

        <nav className="rail-nav">
          {views.map((view) => {
            const Icon = view.icon
            return (
              <button
                key={view.id}
                className={`rail-link ${view.id === activeView ? 'active' : ''}`}
                onClick={() => changeView(view.id)}
              >
                <Icon />
                <div>
                  <span>{view.label}</span>
                  <small>{view.eyebrow}</small>
                </div>
              </button>
            )
          })}
        </nav>

        <div className="rail-footer">
          <div className="source-badge">
            <Sparkles />
            <span>{overview?.source_mode === 'cvp' ? '실CVP 연결 모드' : '데모 스냅샷 모드'}</span>
          </div>
          <button className="refresh-button" onClick={() => void handleStartRefresh()} disabled={collectionProgress?.status === 'running'}>
            <RefreshCcw className={collectionProgress?.status === 'running' ? 'spin' : ''} />
            <span>{collectionProgress?.status === 'running' ? '스냅샷 갱신 중' : '스냅샷 갱신'}</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
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

        {collectionProgress ? <CollectionProgressCard progress={collectionProgress} /> : null}
        {overviewError ? <div className="message-banner error">{overviewError}</div> : null}
        {refreshError ? <div className="message-banner error">{refreshError}</div> : null}

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

              <ListHint total={filteredDevices.length} />
              {devicesLoading ? <PanelState title="장비 목록을 불러오는 중입니다." body="최신 스냅샷 장비 정보를 조회하고 있습니다." /> : null}
              {devicesError ? <div className="message-banner error">{devicesError}</div> : null}
              {!devicesLoading ? (
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
                      {filteredDevices.map((device) => (
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
              ) : null}
            </div>

            <aside className="side-card">
              <div className="card-head compact">
                <div>
                  <p className="section-kicker">Config Backup</p>
                  <h3>{activeConfigDevice?.hostname ?? '장비를 선택하세요'}</h3>
                </div>
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

                {activeView === 'vrf' ? <Field label="VRF 이름" value={vrfName} onChange={setVrfName} placeholder="예: Tenant_A" /> : null}

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
                    <div className="table-shell">{renderRecordTable(activeView, lookup.result.matches, true)}</div>
                  ) : (
                    <PanelState title="일치하는 항목이 없습니다." body="현재 검색 조건과 정확히 일치하는 데이터가 스냅샷에 없습니다." />
                  )}
                </div>
              ) : null}

              <div className="result-block compact-top">
                <SectionHeader title="현재 스냅샷 목록" note="기본 목록은 최대 200건까지 표시합니다." />
                {recordErrors[currentScope] ? <div className="message-banner error">{recordErrors[currentScope]}</div> : null}
                {recordLoading[currentScope] ? (
                  <PanelState title="목록을 불러오는 중입니다." body="현재 스냅샷 데이터를 읽고 있습니다." />
                ) : records[currentScope].items.length > 0 ? (
                  <div className="table-shell">{renderRecordTable(activeView, records[currentScope].items, false)}</div>
                ) : (
                  <PanelState title="표시할 목록이 없습니다." body="현재 스냅샷에 해당 항목이 없거나 아직 수집되지 않았습니다." />
                )}
              </div>
            </div>
          </section>
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
        <MetricCard icon={Radar} label="VRF" value={overview?.vrf_count ?? 0} tone="forest" />
        <MetricCard icon={FileText} label="Config" value={overview?.config_snapshot_count ?? 0} tone="sunset" />
      </section>

      <section className="home-grid">
        <article className="main-card">
          <SectionHeader title="홈 화면 안내" note="이 화면에서는 전체 상태만 확인합니다." />
          <div className="guide-grid">
            <GuideCard title="장비" body="현재 스냅샷에 등록된 장비 수입니다. 장비 탭에서 목록과 Config를 확인할 수 있습니다." />
            <GuideCard title="IP" body="Config에서 추출한 주소 현황입니다. Loopback과 관리망 중복은 강하게 차단 대상으로 표시합니다." />
            <GuideCard title="BGP / VLAN / VRF" body="신규 할당 전 조회용 기준 데이터입니다. 운영 오류 확정보다 사용 현황 확인에 초점을 둡니다." />
            <GuideCard title="Config" body="실제 본문은 파일로 저장하고, 목록과 조회는 최신 스냅샷 메타데이터를 기준으로 제공합니다." />
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

function renderRecordTable(view: ViewId, items: LookupMatch[], isLookupResult: boolean) {
  return (
    <table className="data-table">
      <thead>{renderTableHeader(view, isLookupResult)}</thead>
      <tbody>{items.map((item, index) => renderTableRow(view, item, isLookupResult, index))}</tbody>
    </table>
  )
}

function renderTableHeader(view: ViewId, isLookupResult: boolean) {
  if (view === 'ip') {
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

  if (view === 'bgp') {
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

  if (view === 'vlan') {
    return (
      <tr>
        <th>Hostname</th>
        <th>VLAN ID</th>
        <th>VLAN Name</th>
        <th>SVI</th>
        <th>Description</th>
      </tr>
    )
  }

  return (
    <tr>
      <th>Hostname</th>
      <th>VRF</th>
      <th>VRF ID</th>
      <th>비고</th>
    </tr>
  )
}

function renderTableRow(view: ViewId, match: LookupMatch, isLookupResult: boolean, index: number) {
  const key = `${match.device_id}-${match.interface_name ?? ''}-${match.details.ip ?? match.details.asn ?? match.details.vlan_id ?? match.details.vrf_name ?? index}`

  if (view === 'ip') {
    return (
      <tr key={key}>
        <td>{match.hostname}</td>
        <td>{match.interface_name ?? '-'}</td>
        <td className="mono-cell">{String(match.details.ip ?? '-')}</td>
        <td className="mono-cell">{String(match.details.network ?? '-')}</td>
        <td>{match.vrf ?? String(match.details.vrf ?? '-')}</td>
        <td>{isLookupResult ? match.match_type ?? match.label ?? '-' : match.label ?? '-'}</td>
      </tr>
    )
  }

  if (view === 'bgp') {
    return (
      <tr key={key}>
        <td>{match.hostname}</td>
        <td>{match.vrf ?? '-'}</td>
        <td className="mono-cell">{String(match.details.asn ?? '-')}</td>
        <td className="mono-cell">{String(match.details.router_id ?? '-')}</td>
        <td>{String(match.details.shutdown ? 'shutdown' : 'active')}</td>
      </tr>
    )
  }

  if (view === 'vlan') {
    return (
      <tr key={key}>
        <td>{match.hostname}</td>
        <td className="mono-cell">{String(match.details.vlan_id ?? '-')}</td>
        <td>{String(match.details.vlan_name ?? '-')}</td>
        <td>{String(match.details.svi_name ?? '-')}</td>
        <td>{String(match.details.description ?? '-')}</td>
      </tr>
    )
  }

  return (
    <tr key={key}>
      <td>{match.hostname}</td>
      <td>{String(match.details.vrf_name ?? '-')}</td>
      <td className="mono-cell">{String(match.details.vrf_id ?? '-')}</td>
      <td>{match.label ?? '-'}</td>
    </tr>
  )
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

function LegendItem({
  status,
  title,
  body,
}: {
  status: LookupStatus
  title: string
  body: string
}) {
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

function ListHint({ total }: { total: number }) {
  return <p className="list-hint">현재 화면에 표시되는 항목 수: {total}</p>
}

function SectionHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="section-headline">
      <h4>{title}</h4>
      <p>{note}</p>
    </div>
  )
}

export default App

