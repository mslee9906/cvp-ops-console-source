import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Code2, Play, RefreshCcw, Search, ServerCog } from 'lucide-react'
import { api } from '../../api'
import type {
  AutomationApplyResponse,
  AutomationPlanResponse,
  AutomationSource,
  AutomationSourceDevice,
  AutomationTargetMode,
  AutomationToolDetail,
} from '../../types'
import './automation.css'

type Props = {
  toolSlug: string
  sources: AutomationSource[]
  selectedSource: string
  onSelectedSourceChange: (source: string) => void
  selectedDeviceIds: string[]
  onSelectedDeviceIdsChange: (deviceIds: string[]) => void
  canApply: boolean
}

export function AutomationConsole({
  toolSlug,
  sources,
  selectedSource,
  onSelectedSourceChange,
  selectedDeviceIds,
  onSelectedDeviceIdsChange,
  canApply,
}: Props) {
  const [toolDetail, setToolDetail] = useState<AutomationToolDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [devices, setDevices] = useState<AutomationSourceDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const deferredDeviceSearch = useDeferredValue(deviceSearch)

  const [targetMode, setTargetMode] = useState<AutomationTargetMode>('selected')
  const [preview, setPreview] = useState<AutomationPlanResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const [applyResult, setApplyResult] = useState<AutomationApplyResponse | null>(null)
  const [applyLoading, setApplyLoading] = useState(false)
  const [applyError, setApplyError] = useState('')

  const selectedSourceMeta = useMemo(
    () => sources.find((source) => source.name === selectedSource) ?? null,
    [selectedSource, sources],
  )

  const filteredDevices = useMemo(() => {
    const token = deferredDeviceSearch.trim().toLowerCase()
    if (!token) {
      return devices
    }
    return devices.filter((device) =>
      [device.hostname, device.device_id, device.serial, device.mgmt_ip, device.model, device.site]
        .join(' ')
        .toLowerCase()
        .includes(token),
    )
  }, [deferredDeviceSearch, devices])

  useEffect(() => {
    let alive = true
    const loadDetail = async () => {
      try {
        setDetailLoading(true)
        setDetailError('')
        const response = await api.getAutomationToolDetail(toolSlug)
        if (!alive) {
          return
        }
        setToolDetail(response)
      } catch (error) {
        if (!alive) {
          return
        }
        setToolDetail(null)
        setDetailError(error instanceof Error ? error.message : '자동화 툴 설명을 불러오지 못했습니다.')
      } finally {
        if (alive) {
          setDetailLoading(false)
        }
      }
    }
    void loadDetail()
    return () => {
      alive = false
    }
  }, [toolSlug])

  useEffect(() => {
    if (!selectedSource) {
      setDevices([])
      setDevicesError('')
      return
    }
    let alive = true
    const loadDevices = async () => {
      try {
        setDevicesLoading(true)
        setDevicesError('')
        const response = await api.getAutomationSourceDevices(selectedSource)
        if (!alive) {
          return
        }
        setDevices(response)
      } catch (error) {
        if (!alive) {
          return
        }
        setDevices([])
        setDevicesError(error instanceof Error ? error.message : '자동화 대상 장비 목록을 불러오지 못했습니다.')
      } finally {
        if (alive) {
          setDevicesLoading(false)
        }
      }
    }
    void loadDevices()
    return () => {
      alive = false
    }
  }, [selectedSource])

  useEffect(() => {
    const validIds = new Set(devices.map((device) => device.device_id))
    const nextSelectedIds = selectedDeviceIds.filter((deviceId) => validIds.has(deviceId))
    if (nextSelectedIds.length !== selectedDeviceIds.length) {
      onSelectedDeviceIdsChange(nextSelectedIds)
    }
  }, [devices, onSelectedDeviceIdsChange, selectedDeviceIds])

  useEffect(() => {
    setPreview(null)
    setPreviewError('')
    setApplyResult(null)
    setApplyError('')
  }, [toolSlug, selectedSource, selectedDeviceIds, targetMode])

  async function refreshDevices() {
    if (!selectedSource) {
      return
    }
    try {
      setDevicesLoading(true)
      setDevicesError('')
      const response = await api.getAutomationSourceDevices(selectedSource)
      setDevices(response)
    } catch (error) {
      setDevices([])
      setDevicesError(error instanceof Error ? error.message : '자동화 대상 장비 목록을 불러오지 못했습니다.')
    } finally {
      setDevicesLoading(false)
    }
  }

  function toggleDevice(deviceId: string) {
    if (selectedDeviceIds.includes(deviceId)) {
      onSelectedDeviceIdsChange(selectedDeviceIds.filter((item) => item !== deviceId))
      return
    }
    onSelectedDeviceIdsChange([...selectedDeviceIds, deviceId])
  }

  function selectAllVisible() {
    const merged = new Set(selectedDeviceIds)
    for (const device of filteredDevices) {
      merged.add(device.device_id)
    }
    onSelectedDeviceIdsChange(Array.from(merged))
  }

  function clearSelection() {
    onSelectedDeviceIdsChange([])
  }

  async function handlePreview() {
    if (!selectedSource) {
      return
    }
    try {
      setPreviewLoading(true)
      setPreviewError('')
      setApplyResult(null)
      const response = await api.previewAutomationTool(toolSlug, {
        source: selectedSource,
        target_mode: targetMode,
        device_ids: selectedDeviceIds,
      })
      setPreview(response)
    } catch (error) {
      setPreview(null)
      setPreviewError(error instanceof Error ? error.message : '미리보기를 실행하지 못했습니다.')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleApply() {
    if (!selectedSource || !canApply) {
      return
    }
    try {
      setApplyLoading(true)
      setApplyError('')
      const response = await api.applyAutomationTool(toolSlug, {
        source: selectedSource,
        target_mode: targetMode,
        device_ids: selectedDeviceIds,
      })
      setApplyResult(response)
      await handlePreview()
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : '자동화 실행에 실패했습니다.')
    } finally {
      setApplyLoading(false)
    }
  }

  return (
    <section className="content-grid automation-console-grid">
      <div className="main-card automation-console-panel">
        <div className="card-head">
          <div>
            <p className="section-kicker">Automation Controls</p>
            <h3>{toolDetail?.title ?? '자동화 툴'}</h3>
          </div>
          <div className="toolbar-row">
            <button className="secondary-action" type="button" onClick={() => void refreshDevices()} disabled={!selectedSource}>
              <RefreshCcw />
              <span>대상 목록 새로고침</span>
            </button>
          </div>
        </div>

        <div className="automation-form-grid">
          <label className="automation-select-field">
            <span>CVP Source</span>
            <select value={selectedSource} onChange={(event) => onSelectedSourceChange(event.target.value)}>
              {!sources.length ? <option value="">설정된 source 없음</option> : null}
              {sources.map((source) => (
                <option key={source.name} value={source.name}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>

          <div className="automation-target-box">
            <span>대상 범위</span>
            <div className="automation-segmented">
              <button
                className={targetMode === 'selected' ? 'active' : ''}
                type="button"
                onClick={() => setTargetMode('selected')}
              >
                선택 장비
              </button>
              <button
                className={targetMode === 'all' ? 'active' : ''}
                type="button"
                onClick={() => setTargetMode('all')}
              >
                전체 장비
              </button>
            </div>
          </div>
        </div>

        <div className="automation-summary-grid">
          <div className="automation-summary-card">
            <span>Source</span>
            <strong>{selectedSourceMeta?.name ?? '미설정'}</strong>
            <p>{selectedSourceMeta ? `현황 DB 기준 장비 ${selectedSourceMeta.raw_device_count}대` : 'CVP source를 먼저 선택하세요.'}</p>
          </div>
          <div className="automation-summary-card">
            <span>Selected</span>
            <strong>{selectedDeviceIds.length}</strong>
            <p>{targetMode === 'selected' ? '이 탭에서 선택한 장비만 대상으로 계산합니다.' : '원본 스크립트와 같이 전체 장비를 대상으로 계산합니다.'}</p>
          </div>
          <div className="automation-summary-card">
            <span>Workspace</span>
            <strong>{toolDetail?.workspace_name ?? '-'}</strong>
            <p>Apply는 실제 workspace build/submit을 수행합니다.</p>
          </div>
        </div>

        <div className="automation-selector-block">
          <div className="section-headline">
            <h4>대상 장비 선택</h4>
            <div className="automation-pill-row">
              <span className="automation-count-pill">선택 {selectedDeviceIds.length}</span>
              <span className="automation-count-pill">표시 {filteredDevices.length}</span>
            </div>
          </div>

          <div className="automation-toolbar">
            <div className="inline-filter">
              <Search />
              <input
                value={deviceSearch}
                onChange={(event) => setDeviceSearch(event.target.value)}
                placeholder="Hostname, device ID, serial, mgmt IP"
              />
            </div>
            <button className="secondary-action" type="button" onClick={selectAllVisible}>
              표시 장비 전체 선택
            </button>
            <button className="secondary-action" type="button" onClick={clearSelection}>
              선택 해제
            </button>
          </div>

          {devicesLoading ? <div className="automation-empty">자동화 대상 장비 목록을 불러오는 중입니다.</div> : null}
          {devicesError ? <div className="message-banner error">{devicesError}</div> : null}

          {!devicesLoading ? (
            <div className="table-shell">
              <table className="data-table automation-target-table">
                <thead>
                  <tr>
                    <th>선택</th>
                    <th>Hostname</th>
                    <th>Device ID</th>
                    <th>Mgmt IP</th>
                    <th>Model</th>
                    <th>Last Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.map((device) => {
                    const checked = selectedDeviceIds.includes(device.device_id)
                    return (
                      <tr
                        key={device.raw_device_key}
                        className={checked ? 'selected' : ''}
                        onClick={() => toggleDevice(device.device_id)}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDevice(device.device_id)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </td>
                        <td>
                          <div className="primary-cell">
                            <strong>{device.hostname}</strong>
                            <span>{device.site || device.serial}</span>
                          </div>
                        </td>
                        <td className="mono-cell">{device.device_id}</td>
                        <td className="mono-cell">{device.mgmt_ip || '-'}</td>
                        <td>{device.model || '-'}</td>
                        <td>{device.last_collected_at || '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="automation-action-row">
          <button className="primary-action" type="button" onClick={() => void handlePreview()} disabled={previewLoading || !selectedSource}>
            <RefreshCcw className={previewLoading ? 'spin' : ''} />
            <span>{previewLoading ? '미리보기 계산 중' : '미리보기 계산'}</span>
          </button>
          <button className="primary-action warm" type="button" onClick={() => void handleApply()} disabled={applyLoading || !selectedSource || !canApply}>
            <Play size={16} />
            <span>{applyLoading ? '실행 중' : '실제 적용'}</span>
          </button>
          {!canApply ? <span className="automation-inline-note">viewer 권한은 apply를 실행할 수 없습니다.</span> : null}
        </div>

        {previewError ? <div className="message-banner error">{previewError}</div> : null}
        {applyError ? <div className="message-banner error">{applyError}</div> : null}

        {preview ? (
          <div className="automation-preview-stack">
            <div className="result-summary">
              <div>
                <strong>{preview.summary}</strong>
                <p>{preview.source} / {preview.target_mode === 'all' ? '전체 장비' : `선택 장비 ${preview.requested_device_ids.length}대`}</p>
              </div>
            </div>

            <div className="automation-pill-row">
              <span className="automation-count-pill add">추가 {preview.add_count}</span>
              <span className="automation-count-pill remove">삭제 {preview.remove_count}</span>
              <span className="automation-count-pill">실대상 {preview.resolved_device_ids.length}</span>
            </div>

            {preview.notes.length > 0 ? (
              <div className="automation-note-list">
                {preview.notes.map((note) => (
                  <div key={note} className="automation-note-item">
                    {note}
                  </div>
                ))}
              </div>
            ) : null}

            {preview.warnings.length > 0 ? (
              <div className="automation-warning-list">
                {preview.warnings.map((warning) => (
                  <div key={warning} className="message-banner error">
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="table-shell">
              <table className="data-table automation-operation-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Type</th>
                    <th>Display Key</th>
                    <th>Device</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.operations.map((operation) => (
                    <tr key={`${operation.action}-${operation.element_type}-${operation.display_key}`}>
                      <td>
                        <span className={`automation-badge ${operation.action}`}>{operation.action}</span>
                      </td>
                      <td>{operation.element_type}</td>
                      <td className="mono-cell">{operation.display_key}</td>
                      <td className="mono-cell">{operation.interface_id ? `${operation.device_id}/${operation.interface_id}` : operation.device_id}</td>
                      <td className="mono-cell">{operation.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="automation-empty">source와 대상 장비를 고른 뒤 미리보기를 실행하면 추가/삭제 예정 TAG가 표시됩니다.</div>
        )}

        {applyResult ? (
          <div className="automation-apply-result">
            <div className="result-summary compact-summary">
              <div>
                <strong>실행 완료</strong>
                <p>{applyResult.summary}</p>
              </div>
            </div>
            <div className="automation-workspace-list">
              {applyResult.workspaces.map((workspace) => (
                <article key={`${workspace.action}-${workspace.workspace_id}`} className="guide-card">
                  <h4>{workspace.workspace_name}</h4>
                  <p>{workspace.action === 'add' ? '추가 배치' : '삭제 배치'}</p>
                  <strong className="mono-cell">{workspace.workspace_id}</strong>
                  <p className="mono-cell">{workspace.change_control_ids.join(', ') || 'Change Control ID 없음'}</p>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <aside className="side-card automation-code-panel">
        <div className="card-head compact">
          <div>
            <p className="section-kicker">Code & API Flow</p>
            <h3>{toolDetail?.title ?? '툴 설명을 불러오는 중'}</h3>
          </div>
          <div className="automation-code-icons">
            <ServerCog size={16} />
            <Code2 size={16} />
          </div>
        </div>

        {detailLoading ? <div className="automation-empty">툴 설명과 코드 조각을 불러오는 중입니다.</div> : null}
        {detailError ? <div className="message-banner error">{detailError}</div> : null}

        {toolDetail ? (
          <div className="automation-code-stack">
            <div className="guide-card">
              <h4>동작 설명</h4>
              <p>{toolDetail.description}</p>
            </div>

            <div className="guide-card">
              <h4>API 흐름</h4>
              <div className="automation-step-list">
                {toolDetail.api_steps.map((step) => (
                  <div key={`${step.title}-${step.target}`} className="automation-step-item">
                    <strong>{step.title}</strong>
                    <span className="mono-cell">{step.target}</span>
                    <p>{step.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            {toolDetail.notes.length > 0 ? (
              <div className="guide-card">
                <h4>메모</h4>
                <div className="automation-note-list">
                  {toolDetail.notes.map((note) => (
                    <div key={note} className="automation-note-item">
                      {note}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="guide-card">
              <h4>사용 코드</h4>
              <pre className="automation-code-preview">{toolDetail.code_preview}</pre>
            </div>
          </div>
        ) : null}
      </aside>
    </section>
  )
}
