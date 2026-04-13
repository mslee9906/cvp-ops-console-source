import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Copy, RefreshCcw, Search, Unlink2 } from 'lucide-react'

import { api } from '../../api'
import type {
  CardReservationsResponse,
  DeviceSummary,
  KanbanCard,
  KanbanColumnKey,
  KanbanDiffResponse,
  KanbanTargetItem,
  KanbanTargetSnapshotResponse,
  KanbanValidationResponse,
  ResourceReservation,
} from '../../types'
import './workplan.css'

type WorkPlanStepKey = 'planned_config' | 'snapshot' | 'reservation' | 'validation' | 'vmac_validation' | 'diff' | 'report'
type VmacComparison = {
  vlan_id?: string
  vni?: string
  planned_vmac?: string
  status?: string
  reason?: string
  candidate_vnis?: string[]
  peers?: Array<Record<string, unknown>>
}

type VmacDetailBundle = {
  source?: string
  comparisons?: VmacComparison[]
}

const REPORT_STEP_META = {
  key: 'report' as const,
  label: '보고서 생성',
  body: '작업 결과를 보고서 형식으로 정리하는 단계입니다. 현재는 추후 기능 추가를 위한 placeholder입니다.',
}

const WORK_PLAN_STEP_META: Array<{ key: WorkPlanStepKey; label: string; body: string }> = [
  { key: 'planned_config', label: '예정 Config', body: '대상 장비별 예정 Config를 입력하고 저장합니다.' },
  { key: 'snapshot', label: 'Snapshot', body: 'CVP 연결 여부를 정하고, 연결된 장비의 현재 snapshot을 확인합니다.' },
  { key: 'reservation', label: '예약', body: 'BGP AS와 VxLAN VNI 사용 예정 값을 카드 단위로 예약하고 상태를 공유합니다.' },
  { key: 'validation', label: '자동 검증', body: 'BGP ASN, Loopback, 일반 IP 중복 여부를 순차적으로 확인합니다.' },
  { key: 'vmac_validation', label: 'vMAC 검증', body: '같은 VLAN/VNI L2 확장 장비 간 virtual-router MAC 일치 여부를 확인합니다.' },
  { key: 'diff', label: 'Diff', body: '기존 snapshot Config와 예정 Config를 나란히 비교합니다.' },
]

export function WorkPlanBoard() {
  const cardPickerRef = useRef<HTMLDivElement | null>(null)
  const targetPickerRef = useRef<HTMLDivElement | null>(null)
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [showCardPicker, setShowCardPicker] = useState(false)
  const [showTargetPicker, setShowTargetPicker] = useState(false)
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null)
  const [cardFilter, setCardFilter] = useState('')
  const [targetFilter, setTargetFilter] = useState('')
  const [linkFilter, setLinkFilter] = useState('')
  const [activeStep, setActiveStep] = useState<WorkPlanStepKey>('planned_config')
  const [saving, setSaving] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [validationLoading, setValidationLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [reservationLoading, setReservationLoading] = useState(false)
  const [plannedConfigDraft, setPlannedConfigDraft] = useState('')
  const [snapshotData, setSnapshotData] = useState<KanbanTargetSnapshotResponse | null>(null)
  const [validationData, setValidationData] = useState<KanbanValidationResponse | null>(null)
  const [diffData, setDiffData] = useState<KanbanDiffResponse | null>(null)
  const [reservationData, setReservationData] = useState<CardReservationsResponse | null>(null)
  const [bgpReservationDraft, setBgpReservationDraft] = useState('')
  const [vniReservationDraft, setVniReservationDraft] = useState('')
  const [copyFeedback, setCopyFeedback] = useState('')
  const [actionOverlayMessage, setActionOverlayMessage] = useState('')

  const filteredCards = useMemo(() => {
    const token = cardFilter.trim().toLowerCase()
    const sorted = sortCards(cards)
    if (!token) {
      return sorted
    }
    return sorted.filter((card) =>
      [card.card_code, card.title, card.assignee].join(' ').toLowerCase().includes(token),
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
  const filteredTargets = useMemo(() => {
    const token = targetFilter.trim().toLowerCase()
    const targets = selectedCard?.targets ?? []
    if (!token) {
      return targets
    }
    return targets.filter((target) =>
      [target.display_name, target.mgmt_ip, target.model, target.role_hint, renderServiceStatus(target)]
        .join(' ')
        .toLowerCase()
        .includes(token),
    )
  }, [selectedCard, targetFilter])
  const activeStepMeta = useMemo(
    () => [...WORK_PLAN_STEP_META, REPORT_STEP_META].find((step) => step.key === activeStep) ?? WORK_PLAN_STEP_META[0],
    [activeStep],
  )
  const vmacValidationSection = useMemo(
    () => validationData?.sections.find((section) => section.key === 'vmac_consistency') ?? null,
    [validationData],
  )
  const vmacDetailBundle = useMemo(() => {
    const raw = vmacValidationSection?.details as VmacDetailBundle | undefined
    return raw ?? {}
  }, [vmacValidationSection])
  const vmacComparisons = useMemo(() => {
    const raw = vmacDetailBundle?.comparisons as unknown
    if (!Array.isArray(raw)) {
      return [] as VmacComparison[]
    }
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        vlan_id: String(item.vlan_id ?? ''),
        vni: String(item.vni ?? ''),
        planned_vmac: String(item.planned_vmac ?? ''),
        status: String(item.status ?? ''),
        reason: String(item.reason ?? ''),
        candidate_vnis: Array.isArray(item.candidate_vnis) ? item.candidate_vnis.map((value) => String(value)) : [],
        peers: Array.isArray(item.peers)
          ? item.peers.filter((peer): peer is Record<string, unknown> => Boolean(peer) && typeof peer === 'object' && !Array.isArray(peer))
          : [],
      }))
  }, [vmacDetailBundle])
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
    if (!cards.length) {
      setSelectedCardId(null)
      setShowCardPicker(false)
      return
    }
    if (selectedCardId && !cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null)
      setShowCardPicker(false)
    }
  }, [cards, selectedCardId])

  useEffect(() => {
    const targets = selectedCard?.targets ?? []
    if (!targets.length) {
      setSelectedTargetId(null)
      setPlannedConfigDraft('')
      setShowTargetPicker(false)
      setTargetFilter('')
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
    if (!selectedCardId) {
      setReservationData(null)
      return
    }
    void loadReservations(selectedCardId)
  }, [selectedCardId])

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
    if (!showTargetPicker) {
      return
    }

    function handleOutsidePointer(event: MouseEvent) {
      if (!targetPickerRef.current?.contains(event.target as Node)) {
        setShowTargetPicker(false)
      }
    }

    window.addEventListener('mousedown', handleOutsidePointer)
    return () => window.removeEventListener('mousedown', handleOutsidePointer)
  }, [showTargetPicker])

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
    if (selectedCardId) {
      await loadReservations(selectedCardId)
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

  async function loadReservations(cardId: number) {
    try {
      setReservationLoading(true)
      const response = await api.getCardReservations(cardId)
      setReservationData(response)
    } catch (loadError) {
      setReservationData(null)
      setError(loadError instanceof Error ? loadError.message : '예약 정보를 불러오지 못했습니다.')
    } finally {
      setReservationLoading(false)
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

  async function handleValidate(nextStep: WorkPlanStepKey = 'validation') {
    if (!selectedTarget?.id) {
      return
    }
    try {
      setValidationLoading(true)
      setValidationData(await api.validateKanbanConfig(selectedTarget.id, plannedConfigDraft))
      setActiveStep(nextStep)
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

  async function handleCreateBgpReservation() {
    if (!selectedCard) {
      return
    }
    try {
      setSaving(true)
      setError('')
      await api.createBgpAsReservation(selectedCard.id, bgpReservationDraft.trim())
      setBgpReservationDraft('')
      await loadReservations(selectedCard.id)
      setActionOverlayMessage('BGP AS 예약이 저장되었습니다.')
    } catch (reservationError) {
      setError(reservationError instanceof Error ? reservationError.message : 'BGP AS 예약에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateVniReservation() {
    if (!selectedCard) {
      return
    }
    try {
      setSaving(true)
      setError('')
      await api.createVniReservation(selectedCard.id, vniReservationDraft.trim())
      setVniReservationDraft('')
      await loadReservations(selectedCard.id)
      setActionOverlayMessage('VNI 예약이 저장되었습니다.')
    } catch (reservationError) {
      setError(reservationError instanceof Error ? reservationError.message : 'VNI 예약에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCancelReservation(kind: 'bgp_as' | 'vni', reservationId: number) {
    if (!selectedCard) {
      return
    }
    try {
      setSaving(true)
      setError('')
      if (kind === 'bgp_as') {
        await api.cancelBgpAsReservation(selectedCard.id, reservationId)
      } else {
        await api.cancelVniReservation(selectedCard.id, reservationId)
      }
      await loadReservations(selectedCard.id)
      setActionOverlayMessage('예약이 취소되었습니다.')
    } catch (reservationError) {
      setError(reservationError instanceof Error ? reservationError.message : '예약 취소에 실패했습니다.')
    } finally {
      setSaving(false)
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
    setCardFilter('')
  }

  function handleCardFilterChange(value: string) {
    setCardFilter(value)
    setShowCardPicker(true)
  }

  function handleTargetFilterChange(value: string) {
    setTargetFilter(value)
    setShowTargetPicker(true)
  }

  function handleSelectTarget(targetId: number | null) {
    setSelectedTargetId(targetId)
    setShowTargetPicker(false)
    setTargetFilter('')
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
                {selectedCard ? (
                  <>
                    <div className="workplan-selected-hero">
                      <div>
                        <p className="workplan-kicker">Selected Card</p>
                        <h4>{selectedCard.title}</h4>
                        <small>{selectedCard.card_code}</small>
                      </div>
                      <button className="workplan-ghost-button compact" type="button" onClick={() => setShowCardPicker((open) => !open)}>
                        {showCardPicker ? '닫기' : '다른 카드 선택'}
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
                ) : (
                  <div className="workplan-selected-hero">
                    <div>
                      <p className="workplan-kicker">Choose Card</p>
                      <h4>작업 카드 선택</h4>
                      <small>제목, 코드, 담당자로 검색해 작업 카드를 선택합니다.</small>
                    </div>
                  </div>
                )}

                <div ref={cardPickerRef} className="workplan-card-picker">
                  <label className="workplan-filter selector">
                    <Search size={16} />
                    <input value={cardFilter} onFocus={() => setShowCardPicker(true)} onChange={(event) => handleCardFilterChange(event.target.value)} placeholder="카드 제목, 코드, 담당자 검색" />
                  </label>
                  {showCardPicker ? (
                    <div className="workplan-card-list picker dropdown">
                      {filteredCards.length > 0 ? (
                        filteredCards.map((card) => (
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
                        ))
                      ) : (
                        <div className="workplan-empty-state compact">
                          <strong>검색 결과가 없습니다.</strong>
                          <p>제목, 코드, 담당자 기준으로 다시 검색해 주세요.</p>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </article>

              <section className="workplan-step-panel">
                <p className="workplan-kicker">작업 계획 단계</p>
                {[...WORK_PLAN_STEP_META, REPORT_STEP_META].map((step) => (
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

              {selectedCard && selectedCard.targets.length > 0 ? (
                <div className="workplan-target-selector-bar">
                  <div ref={targetPickerRef} className="workplan-target-picker">
                    <label className="workplan-filter selector">
                      <Search size={16} />
                      <input
                        value={targetFilter}
                        onFocus={() => setShowTargetPicker(true)}
                        onChange={(event) => handleTargetFilterChange(event.target.value)}
                        placeholder="대상 장비 검색"
                      />
                    </label>
                    {showTargetPicker ? (
                      <div className="workplan-card-list picker dropdown workplan-target-dropdown">
                        {filteredTargets.length > 0 ? (
                          filteredTargets.map((target) => (
                            <button
                              key={target.id ?? `${target.display_name}-${target.cvp_device_id}`}
                              className={`workplan-target-option ${target.id === selectedTargetId ? 'active' : ''}`}
                              type="button"
                              onClick={() => handleSelectTarget(target.id ?? null)}
                            >
                              <div className="workplan-target-option-head">
                                <strong>{target.display_name || 'Unnamed Target'}</strong>
                                <span>{renderServiceStatus(target)}</span>
                              </div>
                              <p>{target.mgmt_ip || 'Mgmt IP 없음'}</p>
                              <div className="workplan-card-link-meta">
                                <small>{target.target_kind === 'new' ? '신규 장비' : '기존 장비'}</small>
                                <small>{target.model || 'Model 없음'}</small>
                              </div>
                            </button>
                          ))
                        ) : (
                          <div className="workplan-empty-state compact">
                            <strong>검색 결과가 없습니다.</strong>
                            <p>장비명, MGMT IP, 모델 기준으로 다시 검색해 주세요.</p>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>

                  {selectedTarget ? (
                    <button className="workplan-target-summary" type="button" onClick={() => setShowTargetPicker((open) => !open)}>
                      <div className="workplan-target-summary-head">
                        <strong>{selectedTarget.display_name || 'Unnamed Target'}</strong>
                        <span>{renderServiceStatus(selectedTarget)}</span>
                      </div>
                      <div className="workplan-target-summary-meta">
                        <small>{selectedTarget.mgmt_ip || 'Mgmt IP 없음'}</small>
                        <small>{selectedTarget.model || 'Model 없음'}</small>
                        <small>{selectedTarget.target_kind === 'new' ? '신규 장비' : '기존 장비'}</small>
                      </div>
                    </button>
                  ) : null}
                </div>
              ) : selectedCard ? (
                <div className="workplan-empty-state">
                  <strong>작업 대상 장비가 아직 없습니다.</strong>
                  <p>작업 보드 탭의 `작업 대상` 단계에서 장비를 먼저 지정하면, 여기서 Snapshot과 계획서를 이어서 관리할 수 있습니다.</p>
                </div>
              ) : null}

              {!selectedCard ? (
                <div className="workplan-empty-state">
                  <strong>작업 카드를 선택해 주세요.</strong>
                  <p>왼쪽 카드 선택창에서 카드를 고르면, 그 순간부터 오른쪽 작업 계획 화면이 카드 기준으로 열립니다.</p>
                </div>
              ) : null}

              {selectedCard && selectedTarget ? (
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
                          <button className="workplan-ghost-button" type="button" onClick={() => void handleValidate('validation')} disabled={validationLoading}>
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

                  {activeStep === 'reservation' ? (
                    <section className="workplan-two-column">
                      <article className="workplan-stage-card tall workplan-bgp-reservation-card">
                        <div className="workplan-stage-card-head">
                          <strong>BGP AS 예약</strong>
                          <span className="workplan-stage-pill">카드 단위 예약</span>
                        </div>
                        <p className="workplan-reservation-copy">
                          신규 장비 설치나 L2 확장 작업 전에 사용할 BGP AS를 먼저 예약해 두고, 다른 사용자가 조회 시 바로 알 수 있게 합니다.
                        </p>
                        <div className="workplan-reservation-form">
                          <input
                            className="workplan-reservation-input"
                            value={bgpReservationDraft}
                            onChange={(event) => setBgpReservationDraft(event.target.value)}
                            placeholder="예: 65123"
                          />
                          <button
                            className="workplan-primary-button"
                            type="button"
                            onClick={() => void handleCreateBgpReservation()}
                            disabled={saving || !bgpReservationDraft.trim()}
                          >
                            예약 추가
                          </button>
                        </div>
                        <div className="workplan-validation-summary subtle">
                          <strong>동작 규칙</strong>
                          <p>현재 snapshot에 값이 실제로 감지되면 예약은 자동으로 fulfilled 상태로 전환되고, 이후에는 실제 사용 정보가 우선합니다.</p>
                        </div>
                        {reservationLoading ? (
                          <div className="workplan-empty-state compact">
                            <strong>예약 목록을 불러오는 중입니다.</strong>
                            <p>현재 카드에 연결된 BGP AS 예약 상태를 정리하고 있습니다.</p>
                          </div>
                        ) : (
                          <ReservationList
                            title="BGP AS 예약 목록"
                            items={reservationData?.bgp_as ?? []}
                            onCancel={(reservationId) => void handleCancelReservation('bgp_as', reservationId)}
                          />
                        )}
                      </article>

                      <article className="workplan-stage-card tall">
                        <div className="workplan-stage-card-head">
                          <strong>VxLAN VNI 예약</strong>
                          <span className="workplan-stage-pill soft">Overlay Resource</span>
                        </div>
                        <p className="workplan-reservation-copy">
                          실제 VNI가 아직 snapshot에 없더라도, 어떤 카드가 먼저 사용 예정인지 예약 정보로 공유하고 중복 사용을 막습니다.
                        </p>
                        <div className="workplan-reservation-form">
                          <input
                            className="workplan-reservation-input"
                            value={vniReservationDraft}
                            onChange={(event) => setVniReservationDraft(event.target.value)}
                            placeholder="예: 11001"
                          />
                          <button
                            className="workplan-primary-button"
                            type="button"
                            onClick={() => void handleCreateVniReservation()}
                            disabled={saving || !vniReservationDraft.trim()}
                          >
                            예약 추가
                          </button>
                        </div>
                        <div className="workplan-validation-summary subtle">
                          <strong>공유 기준</strong>
                          <p>다른 사용자가 VNI 현황을 조회하면 예약 상태와 작업 카드 정보를 함께 볼 수 있습니다.</p>
                        </div>
                        {reservationLoading ? (
                          <div className="workplan-empty-state compact">
                            <strong>예약 목록을 불러오는 중입니다.</strong>
                            <p>현재 카드에 연결된 VNI 예약 상태를 정리하고 있습니다.</p>
                          </div>
                        ) : (
                          <ReservationList
                            title="VNI 예약 목록"
                            items={reservationData?.vni ?? []}
                            onCancel={(reservationId) => void handleCancelReservation('vni', reservationId)}
                          />
                        )}
                      </article>
                    </section>
                  ) : null}

                  {activeStep === 'validation' ? (
                    <section className="workplan-stage-card tall">
                      <div className="workplan-stage-card-head">
                        <strong>자동 검증 결과</strong>
                        <button className="workplan-ghost-button" type="button" onClick={() => void handleValidate('validation')} disabled={validationLoading}>
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

                  {activeStep === 'vmac_validation' ? (
                    <section className="workplan-stage-card tall">
                      <div className="workplan-stage-card-head">
                        <strong>vMAC 검증 결과</strong>
                        <button className="workplan-ghost-button" type="button" onClick={() => void handleValidate('vmac_validation')} disabled={validationLoading}>
                          {validationLoading ? '검증 중...' : '다시 검증'}
                        </button>
                      </div>
                      <div className="workplan-validation-summary subtle">
                        <strong>검증 기준</strong>
                        <p>같은 VLAN과 같은 VNI로 연결된 장비가 있으면, 상대 장비의 virtual-router MAC과 현재 기준값이 같은지 확인합니다.</p>
                        <p>현재 비교 기준: {formatVmacSourceLabel(vmacDetailBundle.source)}</p>
                      </div>
                      {validationData && validationData.target_id === selectedTarget.id && vmacValidationSection ? (
                        <div className="workplan-validation-grid">
                          <article className="workplan-validation-card">
                            <div className="workplan-validation-head">
                              <strong>{vmacValidationSection.title}</strong>
                              <span>{vmacValidationSection.items.length}건</span>
                            </div>
                            {vmacValidationSection.items.length > 0 ? (
                              vmacValidationSection.items.map((item, index) => (
                                <div key={`vmac-${index}`} className={`workplan-validation-item ${item.severity}`}>
                                  <div className="workplan-validation-item-head">
                                    <span>{severityLabel(item.severity)}</span>
                                    <strong>{item.title}</strong>
                                  </div>
                                  <p>{item.body}</p>
                                  <ValidationMatchSummary item={item} />
                                </div>
                              ))
                            ) : vmacComparisons.length > 0 && !vmacComparisons.every((comparison) => String(comparison.reason ?? '') === 'no_vmac_source') ? (
                              <div className="workplan-validation-item ok">
                                <div className="workplan-validation-item-head">
                                  <CheckCircle2 size={16} />
                                  <strong>문제 없음</strong>
                                </div>
                                <p>같은 VLAN/VNI L2 확장 장비와의 vMAC 불일치가 발견되지 않았습니다.</p>
                              </div>
                            ) : (
                              <div className="workplan-validation-item info">
                                <div className="workplan-validation-item-head">
                                  <strong>검증 불가</strong>
                                </div>
                                <p>예정 Config 또는 현재 snapshot에서 비교 가능한 vMAC 기준값을 찾지 못했습니다.</p>
                              </div>
                            )}
                          </article>
                          <article className="workplan-validation-card">
                            <div className="workplan-validation-head">
                              <strong>검증 근거</strong>
                              <span>{vmacComparisons.length}건</span>
                            </div>
                            {vmacComparisons.length > 0 ? (
                              <div className="table-shell compact-table-shell">
                                <table className="data-table narrow">
                                  <thead>
                                    <tr>
                                      <th>상태</th>
                                      <th>VLAN</th>
                                      <th>VNI</th>
                                      <th>예정 vMAC</th>
                                      <th>비교 근거</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {vmacComparisons.map((comparison, index) => (
                                      <tr key={`${comparison.vlan_id ?? 'none'}-${comparison.vni ?? 'none'}-${index}`}>
                                        <td>{comparisonStatusLabel(comparison.status)}</td>
                                        <td className="mono-cell">{String(comparison.vlan_id ?? '-') || '-'}</td>
                                        <td className="mono-cell">{String(comparison.vni ?? '-') || '-'}</td>
                                        <td className="mono-cell">{String(comparison.planned_vmac ?? '-') || '-'}</td>
                                        <td>{formatVmacComparisonReason(comparison)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="workplan-empty-state compact">
                                <strong>표시할 비교 근거가 없습니다.</strong>
                                <p>예정 Config에 vMAC이 없거나, 비교 가능한 L2 확장 peer가 아직 없습니다.</p>
                              </div>
                            )}
                          </article>
                        </div>
                      ) : (
                        <div className="workplan-empty-state">
                          <strong>vMAC 검증 결과가 아직 없습니다.</strong>
                          <p>예정 Config 단계에서 검증 실행을 누르면 여기에서 virtual-router MAC 비교 결과를 확인할 수 있습니다.</p>
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

                  {activeStep === 'report' ? (
                    <section className="workplan-stage-card tall">
                      <div className="workplan-stage-card-head">
                        <strong>보고서 생성</strong>
                        <span className="workplan-stage-pill soft">준비 중</span>
                      </div>
                      <div className="workplan-validation-summary subtle">
                        <strong>추후 기능 추가 예정</strong>
                        <p>현재 단계는 자리만 준비된 상태입니다. 이후 작업 결과 요약, 검증 결과, Diff, 대상 장비 정보를 묶어 보고서로 생성하는 기능이 들어갈 예정입니다.</p>
                      </div>
                      <div className="workplan-empty-state">
                        <strong>아직 실행 가능한 기능이 없습니다.</strong>
                        <p>현재는 UI 위치만 확보된 placeholder 단계이며, 버튼이나 생성 기능은 추후 별도 요구사항에 맞춰 추가됩니다.</p>
                      </div>
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

function comparisonStatusLabel(status: unknown) {
  const token = String(status ?? '').toLowerCase()
  if (token === 'error') return '불일치'
  if (token === 'warning') return '검토'
  if (token === 'ok') return '정상'
  return '안내'
}

function formatVmacComparisonReason(comparison: Record<string, unknown>) {
  const reason = String(comparison.reason ?? '')
  const peers = Array.isArray(comparison.peers) ? comparison.peers : []
  const candidateVnis = Array.isArray(comparison.candidate_vnis) ? comparison.candidate_vnis.map(String) : []

  if (reason === 'all_peers_match') {
    return peers.length > 0
      ? peers.map((peer) => `${String((peer as Record<string, unknown>).hostname ?? '-')}=${String((peer as Record<string, unknown>).vmac ?? '-')}`).join(', ')
      : '동일 VNI peer와 vMAC이 모두 일치합니다.'
  }
  if (reason === 'peer_mismatch') {
    return peers.map((peer) => `${String((peer as Record<string, unknown>).hostname ?? '-')}=${String((peer as Record<string, unknown>).vmac ?? '-')}`).join(', ')
  }
  if (reason === 'peer_missing_vmac') {
    return peers.map((peer) => `${String((peer as Record<string, unknown>).hostname ?? '-')}=${String((peer as Record<string, unknown>).vmac ?? '미설정')}`).join(', ')
  }
  if (reason === 'multiple_candidate_vni') {
    return candidateVnis.length > 0 ? `비교 후보 VNI: ${candidateVnis.join(', ')}` : '후보 VNI를 자동 확정할 수 없습니다.'
  }
  if (reason === 'no_peer_devices') {
    return '같은 VLAN/VNI에 비교 대상 peer 장비가 없습니다.'
  }
  if (reason === 'no_vni_context') {
    return '예정 Config만으로 비교할 VNI를 확정할 수 없습니다.'
  }
  if (reason === 'no_vmac_source') {
    return '예정 Config와 현재 snapshot 모두에서 비교 가능한 vMAC 값을 찾지 못했습니다.'
  }
  return '-'
}

function formatVmacSourceLabel(source: unknown) {
  const token = String(source ?? '')
  if (token === 'snapshot') {
    return '링크된 장비의 현재 snapshot vMAC'
  }
  return '예정 Config의 vMAC'
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
      vlan_id: String(entry.vlan_id ?? ''),
      vni: String(entry.vni ?? ''),
      vmac: String(entry.vmac ?? ''),
    }))
}

function formatValidationMatchMeta(match: {
  interface_name: string
  vrf: string
  address: string
  network: string
  asn: string
  vlan_id: string
  vni: string
  vmac: string
}) {
  const parts = [
    match.interface_name,
    match.vrf,
    match.address || match.network,
    match.vlan_id ? `VLAN ${match.vlan_id}` : '',
    match.vni ? `VNI ${match.vni}` : '',
    match.vmac ? `vMAC ${match.vmac}` : '',
    match.asn ? `AS ${match.asn}` : '',
  ].filter(Boolean)
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

function ReservationList({
  title,
  items,
  onCancel,
}: {
  title: string
  items: ResourceReservation[]
  onCancel: (reservationId: number) => void
}) {
  return (
    <div className="workplan-reservation-list-shell">
      <div className="workplan-stage-card-head compact">
        <strong>{title}</strong>
        <span className="workplan-stage-pill soft">{items.length}건</span>
      </div>
      {items.length > 0 ? (
        <div className="workplan-reservation-list">
          {items.map((item) => (
            <article key={`${item.kind}-${item.id}`} className={`workplan-reservation-item ${item.status}`}>
              <div className="workplan-reservation-item-head">
                <div>
                  <strong>{item.value}</strong>
                  <p>{item.card_code || item.card_title || '현재 카드'}</p>
                </div>
                <span className={`workplan-reservation-status ${item.status}`}>{reservationStatusLabel(item.status)}</span>
              </div>
              <div className="workplan-reservation-meta">
                <span>예약자 {item.reserved_by_name || '-'}</span>
                <span>등록 {formatReservationTimestamp(item.created_at)}</span>
                {item.status === 'fulfilled' && item.fulfilled_at ? <span>반영 {formatReservationTimestamp(item.fulfilled_at)}</span> : null}
                {item.status === 'cancelled' && item.cancelled_at ? <span>취소 {formatReservationTimestamp(item.cancelled_at)}</span> : null}
              </div>
              {item.status === 'reserved' ? (
                <div className="workplan-inline-actions">
                  <button className="workplan-ghost-button danger" type="button" onClick={() => onCancel(item.id)}>
                    예약 취소
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="workplan-empty-state compact">
          <strong>등록된 예약이 없습니다.</strong>
          <p>이 카드에서 먼저 사용할 값을 예약하면 다른 사용자 조회와 중복 확인에 즉시 반영됩니다.</p>
        </div>
      )}
    </div>
  )
}

function reservationStatusLabel(status: ResourceReservation['status']) {
  if (status === 'fulfilled') {
    return '반영 완료'
  }
  if (status === 'cancelled') {
    return '취소됨'
  }
  return '예약 중'
}

function formatReservationTimestamp(value: string) {
  if (!value) {
    return '-'
  }
  const normalized = value.replace('T', ' ')
  return normalized.slice(0, 16)
}

function sortCards(cards: KanbanCard[]) {
  const orderMap = new Map<KanbanColumnKey, number>([
    ['blocked', 1],
    ['planned', 2],
    ['ready', 3],
    ['in_progress', 4],
    ['verifying', 5],
    ['incident', 6],
    ['done', 7],
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
    incident: '장애',
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
