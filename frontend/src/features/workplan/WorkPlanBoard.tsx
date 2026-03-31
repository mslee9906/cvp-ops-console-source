import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ClipboardList, Copy, RefreshCcw, Search, Unlink2 } from 'lucide-react'

import { api } from '../../api'
import type {
  DeviceSummary,
  KanbanCard,
  KanbanColumnKey,
  KanbanDiffResponse,
  KanbanTargetItem,
  KanbanTargetSnapshotResponse,
  KanbanValidationResponse,
} from '../../types'
import './workplan.css'

type WorkPlanStepKey = 'planned_config' | 'snapshot' | 'diff' | 'validation'

const WORK_PLAN_STEP_META: Array<{ key: WorkPlanStepKey; label: string; body: string }> = [
  { key: 'planned_config', label: '예정 Config', body: '대상 장비별 예정 Config를 입력하고 저장합니다.' },
  { key: 'snapshot', label: 'Snapshot', body: 'CVP 연결 여부를 정하고, 연결된 장비의 현재 snapshot을 확인합니다.' },
  { key: 'diff', label: 'Diff', body: '기존 snapshot Config와 예정 Config를 나란히 비교합니다.' },
  { key: 'validation', label: '자동 검증', body: 'BGP ASN, Loopback, 일반 IP 중복 여부를 순차적으로 확인합니다.' },
]

export function WorkPlanBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [showCardPicker, setShowCardPicker] = useState(true)
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null)
  const [cardFilter, setCardFilter] = useState('')
  const [linkFilter, setLinkFilter] = useState('')
  const [activeStep, setActiveStep] = useState<WorkPlanStepKey>('planned_config')
  const [saving, setSaving] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [validationLoading, setValidationLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [plannedConfigDraft, setPlannedConfigDraft] = useState('')
  const [snapshotData, setSnapshotData] = useState<KanbanTargetSnapshotResponse | null>(null)
  const [validationData, setValidationData] = useState<KanbanValidationResponse | null>(null)
  const [diffData, setDiffData] = useState<KanbanDiffResponse | null>(null)
  const [copyFeedback, setCopyFeedback] = useState('')
  const [actionOverlayMessage, setActionOverlayMessage] = useState('')

  const filteredCards = useMemo(() => {
    const token = cardFilter.trim().toLowerCase()
    const sorted = sortCards(cards)
    if (!token) {
      return sorted
    }
    return sorted.filter((card) =>
      [card.card_code, card.title, card.assignee, columnLabel(card.column_key)].join(' ').toLowerCase().includes(token),
    )
  }, [cardFilter, cards])

  const selectedCard = useMemo(
    () => cards.find((card) => card.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )
  const selectedTarget = useMemo(
    () => selectedCard?.targets.find((target) => target.id === selectedTargetId) ?? null,
    [selectedCard, selectedTargetId],
  )
  const activeStepMeta = useMemo(
    () => WORK_PLAN_STEP_META.find((step) => step.key === activeStep) ?? WORK_PLAN_STEP_META[0],
    [activeStep],
  )
  const linkCandidates = useMemo(() => {
    const token = linkFilter.trim().toLowerCase()
    const currentDeviceId = selectedTarget?.cvp_device_id ?? ''
    return devices
      .filter((device) => {
        if (device.device_id === currentDeviceId) {
          return true
        }
        if (!token) {
          const seed = [selectedTarget?.display_name ?? '', selectedTarget?.mgmt_ip ?? ''].join(' ').trim().toLowerCase()
          if (!seed) {
            return true
          }
          return [device.hostname, device.mgmt_ip].join(' ').toLowerCase().includes(seed)
        }
        return [device.hostname, device.mgmt_ip, device.model, device.serial].join(' ').toLowerCase().includes(token)
      })
      .slice(0, 8)
  }, [devices, linkFilter, selectedTarget])

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    if (!filteredCards.length) {
      setSelectedCardId(null)
      setShowCardPicker(true)
      return
    }
    if (selectedCardId && !filteredCards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null)
      setShowCardPicker(true)
    }
  }, [filteredCards, selectedCardId])

  useEffect(() => {
    const targets = selectedCard?.targets ?? []
    if (!targets.length) {
      setSelectedTargetId(null)
      setPlannedConfigDraft('')
      return
    }
    if (!selectedTargetId || !targets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(targets[0].id ?? null)
    }
  }, [selectedCard, selectedTargetId])

  useEffect(() => {
    if (!selectedCard || !selectedTargetId) {
      setPlannedConfigDraft('')
      return
    }
    setPlannedConfigDraft(getPlannedConfigText(selectedCard, selectedTargetId))
  }, [selectedCard, selectedTargetId])

  useEffect(() => {
    setSnapshotData(null)
    if (activeStep !== 'snapshot' || !selectedTargetId) {
      return
    }
    void loadSnapshot(selectedTargetId)
  }, [activeStep, selectedTargetId])

  useEffect(() => {
    if (!copyFeedback) {
      return
    }
    const timer = window.setTimeout(() => setCopyFeedback(''), 1800)
    return () => window.clearTimeout(timer)
  }, [copyFeedback])

  useEffect(() => {
    if (!actionOverlayMessage) {
      return
    }
    const timer = window.setTimeout(() => setActionOverlayMessage(''), 1100)
    return () => window.clearTimeout(timer)
  }, [actionOverlayMessage])

  async function bootstrap() {
    try {
      setLoading(true)
      setError('')
      const [cardResponse, deviceResponse] = await Promise.all([api.getKanbanCards(), api.getDevices()])
      setCards(sortCards(cardResponse))
      setDevices(deviceResponse)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 계획 데이터를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function reloadAll() {
    await bootstrap()
    if (selectedTargetId && activeStep === 'snapshot') {
      await loadSnapshot(selectedTargetId)
    }
  }

  async function loadSnapshot(targetId: number) {
    try {
      setSnapshotLoading(true)
      const response = await api.getKanbanTargetSnapshot(targetId)
      setSnapshotData(response)
    } catch (loadError) {
      setSnapshotData(null)
      setError(loadError instanceof Error ? loadError.message : 'Snapshot을 불러오지 못했습니다.')
    } finally {
      setSnapshotLoading(false)
    }
  }

  async function persistCardChanges(
    payload: Partial<Pick<KanbanCard, 'targets' | 'planned_configs'>>,
    successMessage?: string,
  ) {
    if (!selectedCard) {
      return
    }
    try {
      setSaving(true)
      setError('')
      const updated = await api.updateKanbanCard(selectedCard.id, payload)
      setCards((current) => sortCards(current.map((card) => (card.id === updated.id ? updated : card))))
      if (successMessage) {
        setActionOverlayMessage(successMessage)
      }
      return updated
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '작업 계획을 저장하지 못했습니다.')
      return undefined
    } finally {
      setSaving(false)
    }
  }

  async function handleLinkDevice(device: DeviceSummary) {
    if (!selectedCard || !selectedTarget) {
      return
    }
    const updatedTargets = selectedCard.targets.map((target) =>
      target.id === selectedTarget.id
        ? {
            ...target,
            cvp_device_id: device.device_id,
            match_status: 'linked_to_cvp' as const,
            mgmt_ip: target.mgmt_ip || device.mgmt_ip,
            model: target.model || device.model,
          }
        : target,
    )
    const updated = await persistCardChanges({ targets: updatedTargets }, 'CVP 장비가 연결되었습니다.')
    if (updated && selectedTarget.id) {
      await loadSnapshot(selectedTarget.id)
    }
  }

  async function handleUnlinkDevice() {
    if (!selectedCard || !selectedTarget) {
      return
    }
    const updatedTargets = selectedCard.targets.map((target) =>
      target.id === selectedTarget.id
        ? {
            ...target,
            cvp_device_id: '',
            match_status: 'manual_only' as const,
          }
        : target,
    )
    const updated = await persistCardChanges({ targets: updatedTargets }, 'CVP 연결이 해제되었습니다.')
    if (updated && selectedTarget.id) {
      await loadSnapshot(selectedTarget.id)
    }
  }

  async function handleSavePlannedConfig() {
    if (!selectedCard || !selectedTarget?.id) {
      return
    }
    const nextConfigs = upsertPlannedConfig(selectedCard, selectedTarget.id, plannedConfigDraft)
    await persistCardChanges({ planned_configs: nextConfigs }, '예정 Config가 저장되었습니다.')
  }

  async function handleValidate() {
    if (!selectedTarget?.id) {
      return
    }
    try {
      setValidationLoading(true)
      setValidationData(await api.validateKanbanConfig(selectedTarget.id, plannedConfigDraft))
      setActiveStep('validation')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '검증에 실패했습니다.')
    } finally {
      setValidationLoading(false)
    }
  }

  async function handleLoadDiff() {
    if (!selectedTarget?.id) {
      return
    }
    try {
      setDiffLoading(true)
      setDiffData(await api.diffKanbanConfig(selectedTarget.id, plannedConfigDraft))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Diff를 불러오지 못했습니다.')
    } finally {
      setDiffLoading(false)
    }
  }

  async function handleCopyConfigBlock(label: string, text: string) {
    try {
      await copyPlainText(text)
      setCopyFeedback(`${label} 복사 완료`)
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : `${label} 복사에 실패했습니다.`)
    }
  }

  function handleSelectCard(cardId: number) {
    setSelectedCardId(cardId)
    setShowCardPicker(false)
  }

  return (
    <section className="workplan-shell">
      <div className="workplan-toolbar">
        <div>
          <p className="workplan-kicker">Work Planning</p>
          <h3>작업 계획 워크스페이스</h3>
          <p className="workplan-copy">칸반 카드와 연결된 작업 대상, Snapshot, 예정 Config, 검증, Diff를 한 화면에서 이어서 관리합니다.</p>
        </div>
        <button className="workplan-ghost-button" type="button" onClick={() => void reloadAll()} disabled={loading || saving}>
          <RefreshCcw size={16} />
          <span>전체 다시 불러오기</span>
        </button>
      </div>

      {error ? <div className="workplan-message error">{error}</div> : null}
      {loading ? <div className="workplan-loading">작업 계획 데이터를 불러오는 중입니다.</div> : null}

      {!loading ? (
        cards.length > 0 ? (
          <div className="workplan-layout">
            <aside className="workplan-sidebar">
              <article className={`workplan-selector-card ${selectedCard && !showCardPicker ? 'compact' : ''}`}>
                {!selectedCard || showCardPicker ? (
                  <>
                    <div className="workplan-selected-hero">
                      <div>
                        <p className="workplan-kicker">Choose Card</p>
                        <h4>작업 카드 선택</h4>
                        <small>작업 계획을 열 칸반 카드를 먼저 고릅니다.</small>
                      </div>
                      <ClipboardList size={18} />
                    </div>
                    <label className="workplan-filter">
                      <Search size={16} />
                      <input value={cardFilter} onChange={(event) => setCardFilter(event.target.value)} placeholder="카드 제목, 코드, 담당자 검색" />
                    </label>
                    <div className="workplan-card-list picker">
                      {filteredCards.map((card) => (
                        <button
                          key={card.id}
                          className={`workplan-card-link ${card.id === selectedCardId ? 'active' : ''}`}
                          type="button"
                          onClick={() => handleSelectCard(card.id)}
                        >
                          <div className="workplan-card-link-head">
                            <strong>{card.title}</strong>
                            <span>{card.card_code}</span>
                          </div>
                          <p>{card.assignee || '담당자 미지정'}</p>
                          <div className="workplan-card-link-meta">
                            <small>{columnLabel(card.column_key)}</small>
                            <small>{card.targets.length} targets</small>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="workplan-selected-hero">
                      <div>
                        <p className="workplan-kicker">Selected Card</p>
                        <h4>{selectedCard.title}</h4>
                        <small>{selectedCard.card_code}</small>
                      </div>
                      <button className="workplan-ghost-button" type="button" onClick={() => setShowCardPicker(true)}>
                        다른 카드 선택
                      </button>
                    </div>
                    <div className="workplan-summary-grid">
                      <div className="workplan-summary-row">
                        <span>담당자</span>
                        <strong>{selectedCard.assignee || '미지정'}</strong>
                      </div>
                      <div className="workplan-summary-row">
                        <span>상태</span>
                        <strong>{columnLabel(selectedCard.column_key)}</strong>
                      </div>
                      <div className="workplan-summary-row">
                        <span>유형</span>
                        <strong>{selectedCard.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</strong>
                      </div>
                      <div className="workplan-summary-row">
                        <span>작업 대상</span>
                        <strong>{selectedCard.targets.length}대</strong>
                      </div>
                    </div>
                  </>
                )}
              </article>

              <section className="workplan-step-panel">
                <p className="workplan-kicker">작업 계획 단계</p>
                {WORK_PLAN_STEP_META.map((step) => (
                  <button
                    key={step.key}
                    className={`workplan-step-link ${activeStep === step.key ? 'active' : ''}`}
                    type="button"
                    onClick={() => setActiveStep(step.key)}
                  >
                    <div>
                      <strong>{step.label}</strong>
                      <p>{step.body}</p>
                    </div>
                  </button>
                ))}
              </section>
            </aside>

            <section className="workplan-main">
              <div className="workplan-main-head">
                <div>
                  <p className="workplan-kicker">Plan Workspace</p>
                  <h3>{activeStepMeta.label}</h3>
                  <p>{activeStepMeta.body}</p>
                </div>
              </div>

              {selectedCard && !showCardPicker && selectedCard.targets.length > 0 ? (
                <div className="workplan-target-switcher">
                  {selectedCard.targets.map((target) => (
                    <button
                      key={target.id ?? `${target.display_name}-${target.cvp_device_id}`}
                      className={`workplan-target-pill ${target.id === selectedTargetId ? 'active' : ''}`}
                      type="button"
                      onClick={() => setSelectedTargetId(target.id ?? null)}
                    >
                      <strong>{target.display_name || 'Unnamed Target'}</strong>
                      <span>{renderServiceStatus(target)}</span>
                    </button>
                  ))}
                </div>
              ) : selectedCard && !showCardPicker ? (
                <div className="workplan-empty-state">
                  <strong>작업 대상 장비가 아직 없습니다.</strong>
                  <p>작업 보드 탭의 `작업 대상` 단계에서 장비를 먼저 지정하면, 여기서 Snapshot과 계획서를 이어서 관리할 수 있습니다.</p>
                </div>
              ) : null}

              {!selectedCard || showCardPicker ? (
                <div className="workplan-empty-state">
                  <strong>작업 카드를 선택해 주세요.</strong>
                  <p>왼쪽 카드 선택창에서 카드를 고르면, 그 순간부터 오른쪽 작업 계획 화면이 카드 기준으로 열립니다.</p>
                </div>
              ) : null}

              {selectedCard && !showCardPicker && selectedTarget ? (
                <div className="workplan-stage-body">
                  {activeStep === 'planned_config' ? (
                    <section className="workplan-two-column">
                      <article className="workplan-stage-card tall">
                        <div className="workplan-stage-card-head">
                          <strong>{selectedTarget.display_name} 예정 Config</strong>
                          <span className="workplan-stage-pill">{selectedTarget.cvp_device_id ? 'CVP 연결됨' : '수기 대상'}</span>
                        </div>
                        <textarea
                          className="workplan-config-textarea"
                          value={plannedConfigDraft}
                          onChange={(event) => setPlannedConfigDraft(event.target.value)}
                          placeholder="장비별 예정 Config를 붙여 넣거나 작성합니다."
                        />
                        <div className="workplan-inline-actions">
                          <button className="workplan-primary-button" type="button" onClick={() => void handleSavePlannedConfig()} disabled={saving}>
                            저장
                          </button>
                          <button className="workplan-ghost-button" type="button" onClick={() => void handleValidate()} disabled={validationLoading}>
                            {validationLoading ? '검증 중...' : '검증 실행'}
                          </button>
                        </div>
                      </article>
                      <article className="workplan-stage-card tall">
                        <div className="workplan-stage-card-head">
                          <strong>대상 장비 메모</strong>
                          <span className="workplan-stage-pill soft">{selectedTarget.target_kind === 'new' ? '신규 대상' : '기존 장비'}</span>
                        </div>
                        <dl className="workplan-info-list">
                          <div><dt>Hostname</dt><dd>{selectedTarget.display_name || '-'}</dd></div>
                          <div><dt>Mgmt IP</dt><dd>{selectedTarget.mgmt_ip || '-'}</dd></div>
                          <div><dt>Model</dt><dd>{selectedTarget.model || '-'}</dd></div>
                          <div><dt>역할 메모</dt><dd>{selectedTarget.role_hint || '-'}</dd></div>
                        </dl>
                        {validationData && validationData.target_id === selectedTarget.id ? (
                          <div className="workplan-validation-summary">
                            <strong>{validationData.has_conflict ? '검토 필요 항목이 있습니다.' : '중복 항목이 발견되지 않았습니다.'}</strong>
                            <p>자동 검증 단계에서 세부 결과를 계속 확인할 수 있습니다.</p>
                          </div>
                        ) : (
                          <div className="workplan-validation-summary">
                            <strong>빠른 안내</strong>
                            <p>예정 Config 저장 후 검증 실행을 누르면 BGP ASN, Loopback, 일반 IP 중복 여부가 단계별로 정리됩니다.</p>
                          </div>
                        )}
                      </article>
                    </section>
                  ) : null}

                  {activeStep === 'snapshot' ? (
                    <section className="workplan-two-column">
                      <article className="workplan-stage-card tall">
                        <div className="workplan-stage-card-head">
                          <strong>CVP 연결 결정</strong>
                          <span className="workplan-stage-pill">{renderServiceStatus(selectedTarget)}</span>
                        </div>
                        <label className="workplan-filter compact">
                          <Search size={16} />
                          <input value={linkFilter} onChange={(event) => setLinkFilter(event.target.value)} placeholder="CVP 장비 검색" />
                        </label>
                        <div className="workplan-link-candidates">
                          {linkCandidates.map((device) => (
                            <button key={device.device_id} className="workplan-link-row" type="button" onClick={() => void handleLinkDevice(device)}>
                              <div>
                                <strong>{device.hostname}</strong>
                                <p>{device.mgmt_ip || 'Mgmt IP 없음'}</p>
                              </div>
                              <span>{device.model || 'Model 없음'}</span>
                            </button>
                          ))}
                        </div>
                        <div className="workplan-inline-actions">
                          <button className="workplan-primary-button" type="button" onClick={() => selectedTarget.id && void loadSnapshot(selectedTarget.id)} disabled={snapshotLoading}>
                            {snapshotLoading ? '불러오는 중...' : 'Snapshot 새로고침'}
                          </button>
                          <button className="workplan-ghost-button danger" type="button" onClick={() => void handleUnlinkDevice()} disabled={!selectedTarget.cvp_device_id || saving}>
                            <Unlink2 size={16} />
                            <span>CVP 연결 해제</span>
                          </button>
                        </div>
                      </article>

                      <article className="workplan-stage-card tall">
                        <div className="workplan-stage-card-head">
                          <strong>현재 Snapshot</strong>
                          <span className="workplan-stage-pill soft">{selectedTarget.cvp_device_id ? '연결됨' : '미연결'}</span>
                        </div>
                        {snapshotLoading ? (
                          <p>Snapshot을 불러오는 중입니다.</p>
                        ) : snapshotData?.linked_device && 'device_id' in snapshotData.linked_device ? (
                          <>
                            <dl className="workplan-info-list">
                              <div><dt>Hostname</dt><dd>{String(snapshotData.linked_device.hostname)}</dd></div>
                              <div><dt>Mgmt IP</dt><dd>{String(snapshotData.linked_device.mgmt_ip || '-')}</dd></div>
                              <div><dt>Model</dt><dd>{String(snapshotData.linked_device.model || '-')}</dd></div>
                              <div><dt>Serial</dt><dd>{String(snapshotData.linked_device.serial || '-')}</dd></div>
                            </dl>
                            <div className="workplan-stat-grid">
                              <StatCard label="BGP" value={snapshotData.bgp_entries.length} />
                              <StatCard label="VRF" value={snapshotData.vrfs.length} />
                              <StatCard label="VLAN" value={snapshotData.vlans.length} />
                              <StatCard label="VNI" value={snapshotData.vnis.length} />
                              <StatCard label="IP" value={snapshotData.ip_records.length} />
                            </div>
                            {!snapshotData.bgp_entries.length &&
                            !snapshotData.vrfs.length &&
                            !snapshotData.vlans.length &&
                            !snapshotData.vnis.length &&
                            !snapshotData.ip_records.length ? (
                              <div className="workplan-validation-summary">
                                <strong>MGMT 연결만 된 장비로 보입니다.</strong>
                                <p>CVP에는 등록되어 있지만 서비스 구성 정보는 아직 비어 있을 수 있습니다.</p>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="workplan-empty-state">
                            <strong>연결된 Snapshot이 없습니다.</strong>
                            <p>신규 장비라면 이 상태가 정상일 수 있고, CVP 장비와 연결하면 현재 스냅샷과 구성 정보를 확인할 수 있습니다.</p>
                          </div>
                        )}
                      </article>
                    </section>
                  ) : null}

                  {activeStep === 'validation' ? (
                    <section className="workplan-stage-card tall">
                      <div className="workplan-stage-card-head">
                        <strong>자동 검증 결과</strong>
                        <button className="workplan-ghost-button" type="button" onClick={() => void handleValidate()} disabled={validationLoading}>
                          {validationLoading ? '검증 중...' : '다시 검증'}
                        </button>
                      </div>
                      <div className="workplan-validation-summary subtle">
                        <strong>검증 기준</strong>
                        <p>CVP에 연결된 현재 대상 장비의 기존 snapshot 값은 제외하고, 나머지 장비와의 중복만 검사합니다.</p>
                      </div>
                      {validationData && validationData.target_id === selectedTarget.id ? (
                        <div className="workplan-validation-grid">
                          {validationData.sections.map((section) => (
                            <article key={section.key} className="workplan-validation-card">
                              <div className="workplan-validation-head">
                                <strong>{section.title}</strong>
                                <span>{section.items.length}건</span>
                              </div>
                              {section.items.length > 0 ? (
                                section.items.map((item, index) => (
                                  <div key={`${section.key}-${index}`} className={`workplan-validation-item ${item.severity}`}>
                                    <div className="workplan-validation-item-head">
                                      <span>{severityLabel(item.severity)}</span>
                                      <strong>{item.title}</strong>
                                    </div>
                                    <p>{item.body}</p>
                                    <ValidationMatchSummary item={item} />
                                  </div>
                                ))
                              ) : (
                                <div className="workplan-validation-item ok">
                                  <div className="workplan-validation-item-head">
                                    <CheckCircle2 size={16} />
                                    <strong>문제 없음</strong>
                                  </div>
                                  <p>현재 섹션에서는 중복이 발견되지 않았습니다.</p>
                                </div>
                              )}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="workplan-empty-state">
                          <strong>검증 결과가 아직 없습니다.</strong>
                          <p>예정 Config 단계에서 검증 실행을 누르면 여기에서 단계별 결과를 확인할 수 있습니다.</p>
                        </div>
                      )}
                    </section>
                  ) : null}

                  {activeStep === 'diff' ? (
                    <section className="workplan-stage-card tall">
                      <div className="workplan-stage-card-head">
                        <strong>Snapshot vs 예정 Config Diff</strong>
                        <div className="workplan-inline-actions">
                          {diffData && diffData.target_id === selectedTarget.id && diffData.snapshot_available ? (
                            <>
                              <button
                                className="workplan-ghost-button"
                                type="button"
                                onClick={() =>
                                  void handleCopyConfigBlock('Snapshot Config', buildDiffColumnText(diffData.lines, 'left'))
                                }
                              >
                                <Copy size={16} />
                                <span>Snapshot 복사</span>
                              </button>
                              <button
                                className="workplan-ghost-button"
                                type="button"
                                onClick={() =>
                                  void handleCopyConfigBlock('Planned Config', buildDiffColumnText(diffData.lines, 'right'))
                                }
                              >
                                <Copy size={16} />
                                <span>Planned 복사</span>
                              </button>
                            </>
                          ) : null}
                          <button className="workplan-ghost-button" type="button" onClick={() => void handleLoadDiff()} disabled={diffLoading}>
                            {diffLoading ? '비교 중...' : 'Diff 불러오기'}
                          </button>
                        </div>
                      </div>
                      {copyFeedback ? <div className="workplan-copy-toast">{copyFeedback}</div> : null}
                      {diffData && diffData.target_id === selectedTarget.id ? (
                        diffData.snapshot_available ? (
                          <div className="workplan-diff-table">
                            <div className="workplan-diff-row header">
                              <span>Old #</span>
                              <span>Snapshot Config</span>
                              <span>New #</span>
                              <span>Planned Config</span>
                            </div>
                            {diffData.lines.map((line, index) => (
                              <div key={`${line.left_line_number}-${line.right_line_number}-${index}`} className={`workplan-diff-row ${line.kind}`}>
                                <span className="mono">{line.left_line_number ?? ''}</span>
                                <code>{line.left_text || ' '}</code>
                                <span className="mono">{line.right_line_number ?? ''}</span>
                                <code>{line.right_text || ' '}</code>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="workplan-empty-state">
                            <strong>해당 장비에 Snapshot이 없습니다.</strong>
                            <p>신규 장비 작업이거나 아직 CVP Snapshot과 연결되지 않은 장비는 Diff를 만들 수 없습니다.</p>
                          </div>
                        )
                      ) : (
                        <div className="workplan-empty-state">
                          <strong>Diff 결과가 아직 없습니다.</strong>
                          <p>Diff 불러오기를 누르면 기존 Snapshot Config와 예정 Config를 나란히 비교합니다.</p>
                        </div>
                      )}
                    </section>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        ) : (
          <div className="workplan-empty-state">
            <strong>작업 카드를 선택해 주세요.</strong>
            <p>왼쪽 카드 선택창에서 카드를 고르면, 그 순간부터 작업 계획 화면이 카드 기준으로 전환됩니다.</p>
          </div>
        )
      ) : null}

      {actionOverlayMessage ? (
        <div className="workplan-action-overlay" aria-live="polite" aria-atomic="true">
          <div className="workplan-action-overlay-card">
            <CheckCircle2 size={22} />
            <strong>{actionOverlayMessage}</strong>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function upsertPlannedConfig(card: KanbanCard, targetId: number, configText: string) {
  const existing = card.planned_configs.find((item) => item.target_id === targetId)
  if (existing) {
    return card.planned_configs.map((item) => (item.target_id === targetId ? { ...item, config_text: configText } : item))
  }
  return [...card.planned_configs, { target_id: targetId, config_text: configText }]
}

function getPlannedConfigText(card: KanbanCard, targetId: number) {
  return card.planned_configs.find((item) => item.target_id === targetId)?.config_text ?? ''
}

function renderServiceStatus(target: KanbanTargetItem) {
  if (!target.cvp_device_id) {
    return '수기 대상'
  }
  if (target.service_status === 'mgmt_only') {
    return 'MGMT only'
  }
  if (target.service_status === 'service_partial') {
    return '부분 구성'
  }
  if (target.service_status === 'service_ready') {
    return '서비스 확인'
  }
  return 'CVP 연결'
}

function severityLabel(severity: string) {
  if (severity === 'error') return '중복'
  if (severity === 'warning') return '검토'
  return '안내'
}

function ValidationMatchSummary({ item }: { item: KanbanValidationResponse['sections'][number]['items'][number] }) {
  const matches = extractValidationMatches(item.details)
  if (!matches.length) {
    return null
  }

  return (
    <div className="workplan-validation-match-summary">
      <strong>중복 대상 장비</strong>
      <div className="workplan-validation-match-list">
        {matches.map((match, index) => (
          <div key={`${match.hostname}-${match.device_id}-${index}`} className="workplan-validation-match-chip">
            <span>{match.hostname || match.device_id}</span>
            <small>{formatValidationMatchMeta(match)}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function extractValidationMatches(details: Record<string, unknown> | undefined) {
  const rawMatches = details?.matches
  if (!Array.isArray(rawMatches)) {
    return []
  }

  return rawMatches
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      device_id: String(entry.device_id ?? ''),
      hostname: String(entry.hostname ?? ''),
      interface_name: String(entry.interface_name ?? ''),
      vrf: String(entry.vrf ?? ''),
      address: String(entry.address ?? ''),
      network: String(entry.network ?? ''),
      asn: String(entry.asn ?? ''),
    }))
}

function formatValidationMatchMeta(match: {
  interface_name: string
  vrf: string
  address: string
  network: string
  asn: string
}) {
  const parts = [match.interface_name, match.vrf, match.address || match.network, match.asn ? `AS ${match.asn}` : ''].filter(Boolean)
  return parts.join(' · ')
}

function buildDiffColumnText(lines: KanbanDiffResponse['lines'], side: 'left' | 'right') {
  return lines
    .map((line) => {
      const raw = side === 'left' ? line.left_text : line.right_text
      return raw.replace(/\t/g, '    ')
    })
    .join('\n')
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

function sortCards(cards: KanbanCard[]) {
  const orderMap = new Map<KanbanColumnKey, number>([
    ['blocked', 1],
    ['planned', 2],
    ['ready', 3],
    ['in_progress', 4],
    ['verifying', 5],
    ['done', 6],
  ])

  return [...cards].sort((left, right) => {
    const columnDiff = (orderMap.get(left.column_key) ?? 99) - (orderMap.get(right.column_key) ?? 99)
    if (columnDiff !== 0) {
      return columnDiff
    }
    if (left.sort_order !== right.sort_order) {
      return left.sort_order - right.sort_order
    }
    return left.id - right.id
  })
}

function columnLabel(columnKey: KanbanColumnKey) {
  const labels: Record<KanbanColumnKey, string> = {
    blocked: '보류',
    planned: '작업 예정',
    ready: '준비 완료',
    in_progress: '작업 중',
    verifying: '검증 중',
    done: '완료',
  }
  return labels[columnKey]
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="workplan-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
