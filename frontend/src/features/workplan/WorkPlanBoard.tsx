import { useEffect, useMemo, useState } from 'react'
import { ClipboardList, RefreshCcw, Search } from 'lucide-react'

import { api } from '../../api'
import type { KanbanCard, KanbanColumnKey } from '../../types'
import './workplan.css'

type WorkPlanStepKey = 'planned_config' | 'snapshot' | 'diff' | 'validation'

const WORK_PLAN_STEP_META: Array<{ key: WorkPlanStepKey; label: string; body: string }> = [
  { key: 'planned_config', label: '예정 Config', body: '작업 계획서에 들어갈 예정 설정과 작업 개요를 정리합니다.' },
  { key: 'snapshot', label: 'Snapshot', body: '작업 전 현황 캡처와 증적 수집 기준을 정리합니다.' },
  { key: 'diff', label: 'Diff', body: '변경 전후 비교 포인트와 검토 기준을 정리합니다.' },
  { key: 'validation', label: '자동 검증', body: '현황 관리와 자동화 툴 연계 가능성을 열어 둔 검증 영역입니다.' },
]

export function WorkPlanBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [cardFilter, setCardFilter] = useState('')
  const [activeStep, setActiveStep] = useState<WorkPlanStepKey>('planned_config')

  const filteredCards = useMemo(() => {
    const token = cardFilter.trim().toLowerCase()
    if (!token) {
      return sortCards(cards)
    }

    return sortCards(
      cards.filter((card) =>
        [card.card_code, card.title, card.assignee, columnLabel(card.column_key)].join(' ').toLowerCase().includes(token),
      ),
    )
  }, [cardFilter, cards])

  const selectedCard = useMemo(
    () => cards.find((card) => card.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  )
  const activeStepMeta = useMemo(
    () => WORK_PLAN_STEP_META.find((step) => step.key === activeStep) ?? WORK_PLAN_STEP_META[0],
    [activeStep],
  )

  useEffect(() => {
    void loadCards()
  }, [])

  useEffect(() => {
    if (!cards.length) {
      setSelectedCardId(null)
      return
    }

    if (!selectedCardId || !cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(cards[0].id)
    }
  }, [cards, selectedCardId])

  async function loadCards() {
    try {
      setLoading(true)
      setError('')
      const response = await api.getKanbanCards()
      setCards(sortCards(response))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 카드 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="workplan-shell">
      <div className="workplan-toolbar">
        <div>
          <p className="workplan-kicker">Work Planning</p>
          <h3>작업 계획 캔버스</h3>
          <p className="workplan-copy">기존 작업 카드와 연결된 계획서 틀입니다. 향후 현황 관리와 자동화 툴 결과를 이 화면에 연결할 수 있게 구조를 열어 둡니다.</p>
        </div>
        <button className="workplan-ghost-button" type="button" onClick={() => void loadCards()} disabled={loading}>
          <RefreshCcw size={16} />
          <span>카드 다시 불러오기</span>
        </button>
      </div>

      {error ? <div className="workplan-message error">{error}</div> : null}
      {loading ? <div className="workplan-loading">작업 카드 목록을 불러오는 중입니다.</div> : null}

      {!loading ? (
        cards.length > 0 ? (
          <div className="workplan-layout">
            <aside className="workplan-sidebar">
              <article className="workplan-card-picker">
                <div className="workplan-panel-head">
                  <div>
                    <p className="workplan-kicker">Linked Kanban Cards</p>
                    <h4>작업 카드 선택</h4>
                  </div>
                  <span>{filteredCards.length}개</span>
                </div>
                <div className="workplan-filter">
                  <Search size={16} />
                  <input value={cardFilter} onChange={(event) => setCardFilter(event.target.value)} placeholder="카드 제목, 코드, 담당자 검색" />
                </div>
                <div className="workplan-card-list">
                  {filteredCards.map((card) => (
                    <button
                      key={card.id}
                      className={`workplan-card-link ${card.id === selectedCardId ? 'active' : ''}`}
                      type="button"
                      onClick={() => setSelectedCardId(card.id)}
                    >
                      <div className="workplan-card-link-head">
                        <strong>{card.title}</strong>
                        <span>{card.card_code}</span>
                      </div>
                      <p>{card.assignee || '담당자 미지정'}</p>
                      <div className="workplan-card-link-meta">
                        <small>{columnLabel(card.column_key)}</small>
                        <small>{priorityLabel(card.priority)}</small>
                      </div>
                    </button>
                  ))}
                </div>
              </article>

              <article className="workplan-summary-card">
                <div className="workplan-panel-head">
                  <div>
                    <p className="workplan-kicker">Selected Card</p>
                    <h4>{selectedCard?.title ?? '카드를 선택하세요'}</h4>
                  </div>
                  <ClipboardList size={18} />
                </div>
                {selectedCard ? (
                  <div className="workplan-summary-grid">
                    <div className="workplan-summary-row">
                      <span>카드 코드</span>
                      <strong>{selectedCard.card_code}</strong>
                    </div>
                    <div className="workplan-summary-row">
                      <span>담당자</span>
                      <strong>{selectedCard.assignee || '미지정'}</strong>
                    </div>
                    <div className="workplan-summary-row">
                      <span>현재 상태</span>
                      <strong>{columnLabel(selectedCard.column_key)}</strong>
                    </div>
                    <div className="workplan-summary-row">
                      <span>작업 유형</span>
                      <strong>{selectedCard.card_type === 'new' ? '신규 장비 작업' : '기존 장비 작업'}</strong>
                    </div>
                    <div className="workplan-summary-row">
                      <span>체크리스트 진행</span>
                      <strong>
                        {selectedCard.checklist_completed} / {selectedCard.checklist_total}
                      </strong>
                    </div>
                  </div>
                ) : null}
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

              {selectedCard ? (
                <div className="workplan-stage-grid">
                  {renderStageBlocks(activeStep, selectedCard).map((item) => (
                    <article key={item.title} className="workplan-stage-card">
                      <div className="workplan-stage-card-head">
                        <strong>{item.title}</strong>
                        {item.pill ? <span className="workplan-stage-pill">{item.pill}</span> : null}
                      </div>
                      <p>{item.body}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="workplan-empty-state">
                  <strong>작업 카드를 선택해 주세요.</strong>
                  <p>왼쪽 카드 목록에서 특정 작업을 선택하면, 그 카드에 연결된 작업 계획 틀이 표시됩니다.</p>
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="workplan-empty-state">
            <strong>연결할 작업 카드가 없습니다.</strong>
            <p>먼저 작업 보드에서 카드를 생성하면 작업 계획 화면에서 해당 카드를 선택할 수 있습니다.</p>
          </div>
        )
      ) : null}
    </section>
  )
}

function renderStageBlocks(step: WorkPlanStepKey, card: KanbanCard) {
  if (step === 'planned_config') {
    return [
      {
        title: '작업 목적',
        body: `${card.title} 작업의 목적과 변경 배경을 이 영역에 정리합니다. 이후 카드 설명과 자동으로 연결되도록 확장할 수 있습니다.`,
        pill: '계획서 핵심',
      },
      {
        title: '예정 명령 / 예정 Config',
        body: 'CLI, Config 블록, 적용 순서를 문서형으로 정리하는 자리입니다. 추후 자동화 툴의 출력과 연계될 수 있습니다.',
      },
      {
        title: '영향 범위',
        body: '대상 장비, 연관 서비스, 작업 창구, 고객 공유 포인트를 요약하는 자리입니다.',
      },
      {
        title: '롤백 메모',
        body: '작업 실패 시 원복 명령과 원복 기준을 기록하는 자리입니다.',
      },
    ]
  }

  if (step === 'snapshot') {
    return [
      {
        title: '사전 Snapshot 수집',
        body: '작업 전 장비 상태, 관련 현황, 캡처 증적을 정리하는 영역입니다. 현황 관리 탭과 연결될 수 있습니다.',
        pill: '현황 연계 예정',
      },
      {
        title: '수집 대상',
        body: 'BGP, VLAN, VNI, VRF, Config 등 어떤 증적을 남길지 체크하는 영역입니다.',
      },
      {
        title: '증적 메모',
        body: '고객 제출용 캡처, 작업 전후 비교 캡처 기준, 파일 저장 위치를 적는 영역입니다.',
      },
    ]
  }

  if (step === 'diff') {
    return [
      {
        title: '비교 기준',
        body: '변경 전 기준 Config와 변경 후 예상 상태를 어떤 기준으로 비교할지 정리합니다.',
        pill: '비교 설계',
      },
      {
        title: '검토 포인트',
        body: '정책 변경, 인터페이스 변경, overlay/underlay 영향 등 사전 검토 포인트를 정리합니다.',
      },
      {
        title: '고객 공유 문구',
        body: '외부 제출용으로 diff를 어떻게 설명할지 초안을 적는 자리입니다.',
      },
    ]
  }

  return [
    {
      title: '자동 검증 시나리오',
      body: '현재는 틀만 두고 있으며, 향후 현황 관리 탭과 자동화 툴 결과를 연결할 예정입니다.',
      pill: '자동화 연계 예정',
    },
    {
      title: '중복 / 충돌 확인',
      body: 'IP, VLAN, VNI, VRF, BGP 중복 여부를 끌어와 계획서에 자동 반영할 수 있게 확장할 수 있습니다.',
    },
    {
      title: '승인 전 체크',
      body: '작업 진행 전 마지막 확인 항목과 승인 기준을 정리하는 자리입니다.',
    },
  ]
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

function priorityLabel(priority: KanbanCard['priority']) {
  if (priority === 'high') return '높음'
  if (priority === 'low') return '낮음'
  return '중간'
}
