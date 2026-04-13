import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  ExternalLink,
  Globe,
  Info,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Server,
  Settings2,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

import { ApiError, api } from '../../api'
import type {
  MonitoringDashboardResponse,
  MonitoringHistoryResponse,
  MonitoringSeverity,
  MonitoringSourceConfig,
  MonitoringSourceConfigInput,
} from '../../types'
import './MonitoringPrototype.css'

type MonitoringTab = 'live' | 'history'

type AlarmWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
    __cvpAlarmAudioCtx?: AudioContext
  }

const EMPTY_DASHBOARD: MonitoringDashboardResponse = {
  last_updated: '',
  overlay_count: 0,
  maintenance_count: 0,
  source_count: 0,
  sources: [],
}

const EMPTY_HISTORY: MonitoringHistoryResponse = {
  items: [],
  total_count: 0,
}

const EMPTY_SOURCE_DRAFT: MonitoringSourceConfigInput = {
  name: '',
  host: '',
  port: 443,
  username: '',
  password: '',
  enabled: true,
}

const severityMeta = {
  critical: { icon: XCircle, tone: 'critical', panel: 'monitoring-detail-panel critical' },
  warning: { icon: AlertTriangle, tone: 'warning', panel: 'monitoring-detail-panel warning' },
  info: { icon: Info, tone: 'info', panel: 'monitoring-detail-panel info' },
} satisfies Record<MonitoringSeverity, { icon: typeof XCircle; tone: string; panel: string }>

export function MonitoringPrototype({ mode }: { mode: MonitoringTab }) {
  const HISTORY_PAGE_SIZE = 100
  const [dashboard, setDashboard] = useState<MonitoringDashboardResponse>(EMPTY_DASHBOARD)
  const [history, setHistory] = useState<MonitoringHistoryResponse>(EMPTY_HISTORY)
  const [sources, setSources] = useState<MonitoringSourceConfig[]>([])
  const [sourceDrafts, setSourceDrafts] = useState<MonitoringSourceConfigInput[]>([{ ...EMPTY_SOURCE_DRAFT }])
  const [selectedLiveEventId, setSelectedLiveEventId] = useState<number | null>(null)
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historySeverity, setHistorySeverity] = useState<'all' | MonitoringSeverity>('all')
  const [historyStartDate, setHistoryStartDate] = useState('')
  const [historyEndDate, setHistoryEndDate] = useState('')
  const [historyPage, setHistoryPage] = useState(1)
  const [loadingLive, setLoadingLive] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [savingSources, setSavingSources] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [liveError, setLiveError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [settingsSuccess, setSettingsSuccess] = useState('')
  const [sourceAttention, setSourceAttention] = useState<Record<number, 'overlay' | 'activity'>>({})
  const knownLiveEventIdsRef = useRef<Set<number>>(new Set())
  const liveBootstrapRef = useRef(false)
  const activityTimersRef = useRef<Map<number, number>>(new Map())

  const liveEvents = useMemo(() => dashboard.sources.flatMap((source) => source.events), [dashboard.sources])
  const liveSelectedEvent = liveEvents.find((event) => event.id === selectedLiveEventId) ?? null
  const selectedHistoryEvent = history.items.find((event) => event.id === selectedHistoryId) ?? history.items[0] ?? null

  useEffect(() => {
    void loadSources()
  }, [])

  useEffect(() => installAlarmAudioUnlockHandlers(), [])

  useEffect(() => {
    return () => {
      for (const timer of activityTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      activityTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (mode !== 'live') {
      return
    }
    liveBootstrapRef.current = false
    knownLiveEventIdsRef.current = new Set()
    void loadLive(true, true)
    const timer = window.setInterval(() => {
      void loadLive(false)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [mode])

  useEffect(() => {
    if (mode !== 'history') {
      return
    }
    void loadHistory()
  }, [mode, historyQuery, historySeverity, historyStartDate, historyEndDate, historyPage])

  useEffect(() => {
    setHistoryPage(1)
  }, [historyQuery, historySeverity, historyStartDate, historyEndDate])

  useEffect(() => {
    if (selectedHistoryId === null && history.items[0]) {
      setSelectedHistoryId(history.items[0].id)
    }
  }, [history.items, selectedHistoryId])

  useEffect(() => {
    if (!settingsSuccess) {
      return
    }
    const timer = window.setTimeout(() => {
      setSettingsSuccess('')
    }, 3200)
    return () => window.clearTimeout(timer)
  }, [settingsSuccess])

  useEffect(() => {
    if (!liveSelectedEvent) {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [liveSelectedEvent])

  async function loadSources() {
    try {
      const response = await api.getMonitoringSources()
      setSources(response)
      setSourceDrafts(response.length > 0 ? response.map(toDraft) : [{ ...EMPTY_SOURCE_DRAFT }])
      setSettingsError('')
    } catch (error) {
      setSettingsError(asMessage(error))
    }
  }

  async function loadLive(withSpinner: boolean, replayExistingAlerts = false) {
    if (withSpinner) {
      setLoadingLive(true)
    }
    try {
      const response = await api.getMonitoringLive()
      applyLiveAttentionFromResponse(response, false, replayExistingAlerts)
      setDashboard(response)
      setLiveError('')
    } catch (error) {
      setLiveError(asMessage(error))
    } finally {
      if (withSpinner) {
        setLoadingLive(false)
      }
    }
  }

  async function handleRefreshAll() {
    setLoadingLive(true)
    setSelectedLiveEventId(null)
    setSourceAttention({})
    try {
      const response = await api.refreshMonitoringLive()
      applyLiveAttentionFromResponse(response, true)
      setDashboard(response)
      setLiveError('')
    } catch (error) {
      setLiveError(asMessage(error))
      await loadLive(false)
    } finally {
      setLoadingLive(false)
    }
  }

  async function loadHistory() {
    setLoadingHistory(true)
    try {
      const response = await api.getMonitoringHistory(
        historyQuery,
        historySeverity === 'all' ? '' : historySeverity,
        historyStartDate,
        historyEndDate,
        HISTORY_PAGE_SIZE,
        (historyPage - 1) * HISTORY_PAGE_SIZE,
      )
      setHistory(response)
      setHistoryError('')
      if (response.items.length > 0 && !response.items.some((item) => item.id === selectedHistoryId)) {
        setSelectedHistoryId(response.items[0].id)
      }
    } catch (error) {
      setHistoryError(asMessage(error))
    } finally {
      setLoadingHistory(false)
    }
  }

  async function handleSaveSources() {
    setSavingSources(true)
    setSettingsError('')
    setSettingsSuccess('')
    try {
      const payload = sourceDrafts.map((draft) => ({
        ...draft,
        name: draft.name.trim(),
        host: draft.host.trim(),
        username: draft.username.trim(),
        password: draft.password,
        port: Number.isFinite(draft.port) ? draft.port : 443,
      }))
      const response = await api.saveMonitoringSources(payload)
      setSources(response)
      setSourceDrafts(response.length > 0 ? response.map(toDraft) : [{ ...EMPTY_SOURCE_DRAFT }])
      setSettingsSuccess('CVP 설정을 저장했습니다.')
      setSettingsOpen(false)
      await Promise.all([loadLive(false), loadHistory()])
    } catch (error) {
      setSettingsError(asMessage(error))
    } finally {
      setSavingSources(false)
    }
  }

  function handleOpenSettings() {
    setSettingsOpen(true)
    setSettingsSuccess('')
    setSettingsError('')
    setSourceDrafts(sources.length > 0 ? sources.map(toDraft) : [{ ...EMPTY_SOURCE_DRAFT }])
  }

  function updateDraft(index: number, key: keyof MonitoringSourceConfigInput, value: string | number | boolean) {
    setSourceDrafts((current) =>
      current.map((draft, draftIndex) => {
        if (draftIndex !== index) {
          return draft
        }
        return { ...draft, [key]: value }
      }),
    )
  }

  function addDraft() {
    setSourceDrafts((current) => [...current, { ...EMPTY_SOURCE_DRAFT, name: `MON-CVP-${String(current.length + 1).padStart(2, '0')}` }])
  }

  function removeDraft(index: number) {
    setSourceDrafts((current) => {
      if (current.length === 1) {
        return [{ ...EMPTY_SOURCE_DRAFT }]
      }
      return current.filter((_, draftIndex) => draftIndex !== index)
    })
  }

  function applyLiveAttentionFromResponse(
    response: MonitoringDashboardResponse,
    forceBootstrap = false,
    replayExistingAlerts = false,
  ) {
    const fetchedEvents = response.sources.flatMap((source) => source.events)
    const fetchedIds = new Set(fetchedEvents.map((event) => event.id))
    const alertEvents = fetchedEvents.filter(
      (event) => event.status === 'active' && !event.acknowledged_at && event.overlay && !event.bootstrap_suppressed,
    )

    if (forceBootstrap || !liveBootstrapRef.current) {
      if (replayExistingAlerts) {
        triggerSourceAttention(alertEvents)
      }
      knownLiveEventIdsRef.current = fetchedIds
      liveBootstrapRef.current = true
      return
    }

    const newActiveEvents = fetchedEvents.filter(
      (event) =>
        event.status === 'active' &&
        !event.acknowledged_at &&
        !event.bootstrap_suppressed &&
        !knownLiveEventIdsRef.current.has(event.id),
    )
    knownLiveEventIdsRef.current = fetchedIds
    if (newActiveEvents.length === 0) {
      return
    }

    triggerSourceAttention(newActiveEvents)
  }

  function triggerSourceAttention(events: typeof liveEvents) {
    if (events.length === 0) {
      return
    }

    const overlaySourceIds = new Set(events.filter((event) => event.overlay).map((event) => event.source_id))
    const activitySourceIds = new Set(
      events.filter((event) => !event.overlay).map((event) => event.source_id).filter((sourceId) => !overlaySourceIds.has(sourceId)),
    )

    if (overlaySourceIds.size > 0) {
      setSourceAttention((current) => {
        const next = { ...current }
        for (const sourceId of overlaySourceIds) {
          next[sourceId] = 'overlay'
        }
        return next
      })
      void playAlarmTone()
    }

    if (activitySourceIds.size > 0) {
      setSourceAttention((current) => {
        const next = { ...current }
        for (const sourceId of activitySourceIds) {
          if (next[sourceId] !== 'overlay') {
            next[sourceId] = 'activity'
          }
        }
        return next
      })

      for (const sourceId of activitySourceIds) {
        const existing = activityTimersRef.current.get(sourceId)
        if (existing) {
          window.clearTimeout(existing)
        }
        const timer = window.setTimeout(() => {
          setSourceAttention((current) => {
            if (current[sourceId] !== 'activity') {
              return current
            }
            const next = { ...current }
            delete next[sourceId]
            return next
          })
          activityTimersRef.current.delete(sourceId)
        }, 8000)
        activityTimersRef.current.set(sourceId, timer)
      }
    }
  }

  function clearSourceAttention(sourceId: number) {
    const timer = activityTimersRef.current.get(sourceId)
    if (timer) {
      window.clearTimeout(timer)
      activityTimersRef.current.delete(sourceId)
    }
    setSourceAttention((current) => {
      if (!(sourceId in current)) {
        return current
      }
      const next = { ...current }
      delete next[sourceId]
      return next
    })
  }

  async function acknowledgeSourceAlerts(sourceId: number) {
    clearSourceAttention(sourceId)
    try {
      const response = await api.acknowledgeMonitoringSourceAlerts(sourceId)
      applyLiveAttentionFromResponse(response, true)
      setDashboard(response)
      setLiveError('')
    } catch (error) {
      setLiveError(asMessage(error))
      await loadLive(false)
    }
  }

  if (mode === 'history') {
    const totalPages = Math.max(1, Math.ceil(history.total_count / HISTORY_PAGE_SIZE))
    return (
      <section className="monitoring-prototype">
        <div className="monitoring-history-shell">
          <header className="monitoring-history-header">
            <div>
              <p className="section-kicker">Stored Event Search</p>
              <h3>이벤트 DB 조회</h3>
            </div>
            <div className="monitoring-history-summary">
              {history.total_count} events
              <span>
                page {historyPage} / {totalPages}
              </span>
            </div>
          </header>

          <div className="monitoring-history-toolbar">
            <label className="monitoring-search-field">
              <Search size={15} />
              <input
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="hostname, interface, event_type, source 검색"
              />
            </label>
            <label className="monitoring-select-field">
              <span>Severity</span>
              <select value={historySeverity} onChange={(event) => setHistorySeverity(event.target.value as 'all' | MonitoringSeverity)}>
                <option value="all">All</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </label>
            <label className="monitoring-select-field">
              <span>From</span>
              <input type="date" value={historyStartDate} onChange={(event) => setHistoryStartDate(event.target.value)} />
            </label>
            <label className="monitoring-select-field">
              <span>To</span>
              <input type="date" value={historyEndDate} onChange={(event) => setHistoryEndDate(event.target.value)} />
            </label>
            <div className="monitoring-history-page-tools">
              <button
                type="button"
                className="monitoring-outline-button"
                onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
                disabled={historyPage <= 1}
              >
                Prev 100
              </button>
              <button
                type="button"
                className="monitoring-outline-button"
                onClick={() => setHistoryPage((page) => Math.min(totalPages, page + 1))}
                disabled={historyPage >= totalPages}
              >
                Next 100
              </button>
            </div>
          </div>

          {historyError ? <div className="monitoring-inline-error">{historyError}</div> : null}

          <div className="monitoring-history-content">
            <div className="monitoring-history-table-shell">
              <div className="monitoring-history-table-scroll">
                <table className="monitoring-history-table">
                  <thead>
                    <tr>
                      <th>Stored</th>
                      <th>Source</th>
                      <th>Event</th>
                      <th>Hostname</th>
                      <th>Interface</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.items.map((row) => (
                      <tr
                        key={row.id}
                        className={row.id === selectedHistoryEvent?.id ? 'selected' : ''}
                        onClick={() => setSelectedHistoryId(row.id)}
                      >
                        <td>
                          <div className="monitoring-history-time">
                            <strong>{formatDatePart(row.stored_at)}</strong>
                            <span>{formatTimePart(row.stored_at)}</span>
                          </div>
                        </td>
                        <td>{row.source_name}</td>
                        <td>
                          <div className="monitoring-history-title">
                            <strong>{row.title}</strong>
                            <span>{row.description || row.message || row.event_type}</span>
                          </div>
                        </td>
                        <td>{row.hostname || '-'}</td>
                        <td>{row.interface_name || '-'}</td>
                      </tr>
                    ))}
                    {!loadingHistory && history.items.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="monitoring-empty-row">저장된 이벤트가 없습니다.</div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <aside className="monitoring-history-detail">
              {selectedHistoryEvent ? (
                <>
                  <div className="monitoring-history-detail-head">
                    <div>
                      <p className="section-kicker">Selected Event</p>
                      <h4>{selectedHistoryEvent.title}</h4>
                    </div>
                    {selectedHistoryEvent.cvp_link ? (
                      <a href={selectedHistoryEvent.cvp_link} target="_blank" rel="noreferrer" className="monitoring-inline-link">
                        CVP link
                        <ExternalLink size={13} />
                      </a>
                    ) : null}
                  </div>

                  <div className="monitoring-history-meta">
                    <DetailBox label="Source" value={selectedHistoryEvent.source_name} />
                    <DetailBox label="Status" value={selectedHistoryEvent.status.toUpperCase()} />
                    <DetailBox label="Hostname" value={selectedHistoryEvent.hostname || '-'} />
                    <DetailBox label="Interface" value={selectedHistoryEvent.interface_name || '-'} />
                    <DetailBox label="event_type" value={selectedHistoryEvent.event_type} />
                    <DetailBox label="Time" value={formatDateTime(selectedHistoryEvent.occurred_at)} />
                    <DetailBox label="deviceId" value={selectedHistoryEvent.device_id || '-'} mono />
                    <DetailBox label="deviceId2" value={selectedHistoryEvent.device_id2 || '-'} mono />
                    <DetailBox label="compName" value={selectedHistoryEvent.comp_name || '-'} />
                    <DetailBox label="hostname1 / hostname2" value={`${selectedHistoryEvent.hostname1 || '-'} / ${selectedHistoryEvent.hostname2 || '-'}`} />
                  </div>

                  <div className="monitoring-history-note">
                    <Database size={16} />
                    <p>{selectedHistoryEvent.message}</p>
                  </div>

                  <section className="monitoring-raw-panel">
                    <div className="monitoring-raw-head">
                      <Terminal size={14} />
                      <span>Raw Log Data</span>
                    </div>
                    <pre>{JSON.stringify(selectedHistoryEvent.raw_json, null, 2)}</pre>
                  </section>
                </>
              ) : (
                <div className="monitoring-empty-panel history">
                  <Database size={24} />
                  <span>이벤트를 선택하면 상세가 표시됩니다.</span>
                </div>
              )}
            </aside>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="monitoring-prototype">
      <div className="monitoring-live-shell">
        <div className="monitoring-live-main">
          <header className="monitoring-live-header">
            <div className="monitoring-live-title">
              <div className="monitoring-live-brand">
                <div className="monitoring-live-brand-mark">
                  <Activity size={18} />
                </div>
                <div>
                  <h3>CVP Monitoring</h3>
                </div>
              </div>
            </div>

            <div className="monitoring-live-actions">
              <button type="button" className="monitoring-live-chip action" onClick={handleOpenSettings}>
                <Settings2 size={14} />
                <span>CVP 설정</span>
              </button>
              <button type="button" className="monitoring-header-button" onClick={() => void handleRefreshAll()}>
                <RefreshCcw size={14} />
                <span>{loadingLive ? 'Refreshing...' : 'Refresh All'}</span>
              </button>
            </div>
          </header>

          {liveError ? <div className="monitoring-inline-error">{liveError}</div> : null}
          {settingsSuccess ? <div className="monitoring-inline-success">{settingsSuccess}</div> : null}

          <div className="monitoring-source-grid">
            {dashboard.sources.map((source) => {
              const visibleIssueEvents = source.events.filter(
                (event) => event.status === 'active' && event.overlay && !event.acknowledged_at && !event.bootstrap_suppressed,
              )
              const criticalCount = visibleIssueEvents.filter((event) => event.severity === 'critical').length
              const warningCount = visibleIssueEvents.filter((event) => event.severity !== 'critical').length
              const attention = sourceAttention[source.id] ?? ''
              return (
                <article
                  key={source.id}
                  className={`monitoring-source-panel ${criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : ''} ${attention ? `attention-${attention}` : ''}`}
                >
                  <div className="monitoring-source-panel-head">
                    <div>
                      <div className="monitoring-source-label">
                        <Globe size={14} />
                        <h4>{source.name}</h4>
                      </div>
                      <span>{source.host}:{source.port}</span>
                    </div>

                    <div className="monitoring-source-badges">
                      {criticalCount > 0 ? (
                        <button
                          type="button"
                          className={`monitoring-count-badge monitoring-count-badge-button critical ${attention === 'overlay' ? 'attention-overlay' : ''}`}
                          onClick={() => acknowledgeSourceAlerts(source.id)}
                        >
                          <XCircle size={14} />
                          {criticalCount}
                        </button>
                      ) : null}
                      {warningCount > 0 ? (
                        <button
                          type="button"
                          className={`monitoring-count-badge monitoring-count-badge-button warning ${attention === 'overlay' ? 'attention-overlay' : ''}`}
                          onClick={() => acknowledgeSourceAlerts(source.id)}
                        >
                          <AlertTriangle size={14} />
                          {warningCount}
                        </button>
                      ) : null}
                      {criticalCount === 0 && warningCount === 0 ? (
                        <button
                          type="button"
                          className={`monitoring-count-badge monitoring-count-badge-button neutral ${attention ? `attention-${attention}` : ''}`}
                          onClick={() => clearSourceAttention(source.id)}
                        >
                          {source.events.length} Events
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="monitoring-source-events">
                    {source.events.length > 0 ? (
                      source.events.map((event) => {
                        const meta = severityMeta[event.severity]
                        const Icon = meta.icon
                        const selected = liveSelectedEvent?.id === event.id
                        const eventHost = event.hostname || event.comp_name || source.name
                        return (
                          <button
                            key={event.id}
                            type="button"
                            className={`monitoring-event-row ${selected ? 'selected' : ''}`}
                            onClick={() => {
                              clearSourceAttention(source.id)
                              setSelectedLiveEventId(event.id)
                            }}
                          >
                            <Icon size={18} className={`monitoring-event-icon ${meta.tone}`} />
                            <div className="monitoring-event-row-copy">
                              <strong className="monitoring-event-row-title" title={event.title}>
                                {event.title}
                              </strong>
                              <div className="monitoring-event-row-sub">
                                <span>{eventHost}</span>
                              </div>
                              <div className="monitoring-event-row-tags">
                                <span className="monitoring-event-tag">{event.event_type}</span>
                              </div>
                            </div>
                          </button>
                        )
                      })
                    ) : (
                      <div className="monitoring-empty-panel">
                        <CheckCircle2 size={26} />
                        <span>No recent events</span>
                      </div>
                    )}
                  </div>

                  <div className="monitoring-source-footer">
                    <span className={`monitoring-source-status ${source.status}`}>
                      <span className="dot" />
                      {source.status_label}
                    </span>
                    {source.host ? (
                      <a href={buildCvpEventsListLink(source.host, source.port)} target="_blank" rel="noreferrer" className="monitoring-inline-link">
                        View All in CVP
                        <ExternalLink size={13} />
                      </a>
                    ) : (
                      <span className="monitoring-inline-link disabled">CVP link unavailable</span>
                    )}
                  </div>
                </article>
              )
            })}

            {!loadingLive && dashboard.sources.length === 0 ? (
              <div className="monitoring-empty-state">
                <Server size={26} />
                <strong>등록된 CVP가 없습니다.</strong>
                <p>우측 상단의 CVP 설정 버튼에서 테스트 CVP를 먼저 추가해주십시오.</p>
              </div>
            ) : null}
          </div>
        </div>

        {liveSelectedEvent ? (
          <div className="monitoring-live-drawer-backdrop" onClick={() => setSelectedLiveEventId(null)}>
          <aside className="monitoring-live-drawer open" onClick={(event) => event.stopPropagation()}>
            <div className="monitoring-live-drawer-head">
              <div className="monitoring-drawer-title">
                {(() => {
                  const meta = severityMeta[liveSelectedEvent.severity]
                  const Icon = meta.icon
                  return <Icon size={18} className={`monitoring-event-icon ${meta.tone}`} />
                })()}
                <span>Event Detail</span>
              </div>
              <button type="button" className="monitoring-close-button" onClick={() => setSelectedLiveEventId(null)}>
                <X size={18} />
              </button>
            </div>

            <div className="monitoring-live-drawer-body">
              <section className={severityMeta[liveSelectedEvent.severity].panel}>
                <p className="section-kicker">Message</p>
                <strong>{liveSelectedEvent.title}</strong>
                <p>{liveSelectedEvent.description || liveSelectedEvent.message}</p>
              </section>

              <div className="monitoring-detail-grid">
                <DetailBox label="Status" value={liveSelectedEvent.status.toUpperCase()} />
                <DetailBox label="Time" value={formatDateTime(liveSelectedEvent.occurred_at)} />
                <DetailBox label="Source CVP" value={liveSelectedEvent.source_name} />
                <DetailBox label="Hostname" value={liveSelectedEvent.hostname || '-'} />
                <DetailBox label="event_type" value={liveSelectedEvent.event_type} />
                <DetailBox label="Interface" value={liveSelectedEvent.interface_name || '-'} />
                <DetailBox label="compName" value={liveSelectedEvent.comp_name || '-'} />
                <DetailBox label="hostname1 / hostname2" value={`${liveSelectedEvent.hostname1 || '-'} / ${liveSelectedEvent.hostname2 || '-'}`} />
                <DetailBox label="deviceId" value={liveSelectedEvent.device_id || '-'} mono />
                <DetailBox label="deviceId2" value={liveSelectedEvent.device_id2 || '-'} mono />
                <DetailBox label="Maintenance" value={liveSelectedEvent.maintenance_name || 'none'} />
                <DetailBox label="Overlay" value={liveSelectedEvent.overlay ? 'triggered' : 'no'} />
              </div>

              <section className="monitoring-raw-panel">
                <div className="monitoring-raw-head">
                  <span>Raw Log Data</span>
                  {liveSelectedEvent.cvp_link ? (
                    <a href={liveSelectedEvent.cvp_link} target="_blank" rel="noreferrer" className="monitoring-inline-link">
                      Open in CVP
                    </a>
                  ) : null}
                </div>
                <pre>{JSON.stringify(liveSelectedEvent.raw_json, null, 2)}</pre>
              </section>
            </div>
          </aside>
          </div>
        ) : null}
      </div>

      {settingsOpen ? (
        <div className="monitoring-settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="monitoring-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="monitoring-settings-head">
              <div>
                <p className="section-kicker">Monitoring Source Settings</p>
                <h3>CVP 설정</h3>
              </div>
              <button type="button" className="monitoring-close-button" onClick={() => setSettingsOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="monitoring-settings-tools">
              <button type="button" className="monitoring-outline-button" onClick={addDraft}>
                <Plus size={14} />
                <span>CVP 추가</span>
              </button>
            </div>

            {settingsError ? <div className="monitoring-inline-error">{settingsError}</div> : null}

            <div className="monitoring-settings-list">
              {sourceDrafts.map((draft, index) => (
                <article key={`source-draft-${index}`} className="monitoring-settings-card">
                  <div className="monitoring-settings-card-head">
                    <strong>{draft.name || `MON-CVP-${String(index + 1).padStart(2, '0')}`}</strong>
                    <div className="monitoring-settings-card-actions">
                      <label className="monitoring-toggle">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(event) => updateDraft(index, 'enabled', event.target.checked)}
                        />
                        <span>활성</span>
                      </label>
                      <button type="button" className="monitoring-icon-button" onClick={() => removeDraft(index)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="monitoring-settings-grid">
                    <label className="monitoring-settings-field">
                      <span>표시 이름</span>
                      <input
                        value={draft.name}
                        onChange={(event) => updateDraft(index, 'name', event.target.value)}
                        placeholder="MON-CVP-01"
                      />
                    </label>
                    <label className="monitoring-settings-field">
                      <span>CVP IP</span>
                      <input
                        value={draft.host}
                        onChange={(event) => updateDraft(index, 'host', event.target.value)}
                        placeholder="192.168.237.78"
                      />
                    </label>
                    <label className="monitoring-settings-field">
                      <span>Port</span>
                      <input
                        type="number"
                        value={draft.port}
                        onChange={(event) => updateDraft(index, 'port', Number(event.target.value || 443))}
                      />
                    </label>
                    <label className="monitoring-settings-field">
                      <span>ID</span>
                      <input
                        value={draft.username}
                        onChange={(event) => updateDraft(index, 'username', event.target.value)}
                        placeholder="cvpadmin"
                      />
                    </label>
                    <label className="monitoring-settings-field full">
                      <span>PASS</span>
                      <input
                        type="password"
                        value={draft.password}
                        onChange={(event) => updateDraft(index, 'password', event.target.value)}
                        placeholder="password"
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>

            <div className="monitoring-settings-footer">
              <button type="button" className="monitoring-outline-button" onClick={() => setSettingsOpen(false)}>
                취소
              </button>
              <button type="button" className="monitoring-header-button" onClick={() => void handleSaveSources()} disabled={savingSources}>
                <Save size={14} />
                <span>{savingSources ? 'Saving...' : '저장'}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function DetailBox({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <article className="monitoring-detail-box">
      <small>{label}</small>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </article>
  )
}

function toDraft(source: MonitoringSourceConfig): MonitoringSourceConfigInput {
  return {
    name: source.name,
    host: source.host,
    port: source.port,
    username: source.username,
    password: source.password,
    enabled: source.enabled,
  }
}

function formatDateTime(value: string): string {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatDatePart(value: string): string {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTimePart(value: string): string {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }
  const hour = String(parsed.getHours()).padStart(2, '0')
  const minute = String(parsed.getMinutes()).padStart(2, '0')
  const second = String(parsed.getSeconds()).padStart(2, '0')
  return `${hour}:${minute}:${second}`
}

function buildCvpEventsListLink(host: string, port: number): string {
  const normalizedHost = host.trim()
  if (!normalizedHost) {
    return ''
  }
  if (!port || port === 443) {
    return `https://${normalizedHost}/cv/events/`
  }
  return `https://${normalizedHost}:${port}/cv/events/`
}

async function playAlarmTone(): Promise<void> {
  const ctx = await ensureAlarmAudioUnlocked()
  if (!ctx) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([160, 90, 160])
    }
    return
  }

  const now = ctx.currentTime
  const tones = [
    { start: 0.0, frequency: 980, duration: 0.11, gain: 0.22, type: 'triangle' as const },
    { start: 0.05, frequency: 720, duration: 0.22, gain: 0.16, type: 'sine' as const },
    { start: 0.3, frequency: 980, duration: 0.11, gain: 0.22, type: 'triangle' as const },
    { start: 0.35, frequency: 720, duration: 0.22, gain: 0.16, type: 'sine' as const },
  ]

  try {
    for (const tone of tones) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = tone.type
      oscillator.frequency.setValueAtTime(tone.frequency, now + tone.start)
      gain.gain.setValueAtTime(0.0001, now + tone.start)
      gain.gain.linearRampToValueAtTime(tone.gain, now + tone.start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(now + tone.start)
      oscillator.stop(now + tone.start + tone.duration)
    }
  } catch {}
}

let alarmAudioUnlockPromise: Promise<AudioContext | null> | null = null

function installAlarmAudioUnlockHandlers(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined
  }

  const unlock = () => {
    void ensureAlarmAudioUnlocked()
  }

  const events: Array<keyof DocumentEventMap> = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']
  for (const eventName of events) {
    document.addEventListener(eventName, unlock, { once: true, capture: true })
  }

  return () => {
    for (const eventName of events) {
      document.removeEventListener(eventName, unlock, { capture: true })
    }
  }
}

async function ensureAlarmAudioUnlocked(): Promise<AudioContext | null> {
  if (typeof window === 'undefined') {
    return null
  }

  const alarmWindow = window as AlarmWindow
  const AudioCtor = alarmWindow.AudioContext ?? alarmWindow.webkitAudioContext
  if (!AudioCtor) {
    return null
  }

  if (!alarmAudioUnlockPromise) {
    alarmAudioUnlockPromise = (async () => {
      const context = alarmWindow.__cvpAlarmAudioCtx ?? new AudioCtor()
      alarmWindow.__cvpAlarmAudioCtx = context
      if (context.state === 'suspended' && typeof context.resume === 'function') {
        try {
          await context.resume()
        } catch {
          return null
        }
      }
      return context
    })()
  }

  const context = await alarmAudioUnlockPromise
  if (!context || context.state === 'closed') {
    alarmAudioUnlockPromise = null
    return null
  }
  return context
}

function asMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return '요청 처리 중 오류가 발생했습니다.'
}
