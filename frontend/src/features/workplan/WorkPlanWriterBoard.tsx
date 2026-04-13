import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileSpreadsheet, RefreshCcw, Sheet } from 'lucide-react'

import { api } from '../../api'
import type { KanbanCard, KanbanTargetItem, WorkPlanProgressResponse } from '../../types'
import './workplan-writer.css'

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running'])

export function WorkPlanWriterBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [projectName, setProjectName] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingArchive, setDownloadingArchive] = useState(false)
  const [downloadMessage, setDownloadMessage] = useState('')
  const [jobProgress, setJobProgress] = useState<WorkPlanProgressResponse | null>(null)
  const downloadedJobIdRef = useRef('')

  const cardsWithTargets = useMemo(() => cards.filter((card) => card.targets.length > 0), [cards])
  const selectedCard = useMemo(
    () => cardsWithTargets.find((card) => card.id === selectedCardId) ?? null,
    [cardsWithTargets, selectedCardId],
  )
  const allTargets = useMemo(() => selectedCard?.targets ?? [], [selectedCard])
  const linkedTargets = useMemo(
    () => allTargets.filter((target) => Boolean(target.cvp_device_id?.trim())),
    [allTargets],
  )
  const missingLinkedTargets = useMemo(
    () => allTargets.filter((target) => !String(target.cvp_device_id ?? '').trim()),
    [allTargets],
  )
  const isJobRunning = Boolean(jobProgress && ACTIVE_JOB_STATUSES.has(jobProgress.status))

  useEffect(() => {
    void loadCards()
  }, [])

  useEffect(() => {
    if (!cardsWithTargets.length) {
      setSelectedCardId(null)
      setProjectName('')
      return
    }
    if (!selectedCardId || !cardsWithTargets.some((card) => card.id === selectedCardId)) {
      const fallbackCard = cardsWithTargets[0]
      setSelectedCardId(fallbackCard.id)
      setProjectName(fallbackCard.title)
    }
  }, [cardsWithTargets, selectedCardId])

  useEffect(() => {
    if (!selectedCard) {
      return
    }
    setProjectName((current) => (current.trim() ? current : selectedCard.title))
  }, [selectedCard])

  useEffect(() => {
    if (!downloadMessage) {
      return
    }
    const timer = window.setTimeout(() => setDownloadMessage(''), 2200)
    return () => window.clearTimeout(timer)
  }, [downloadMessage])

  useEffect(() => {
    if (!jobProgress || !ACTIVE_JOB_STATUSES.has(jobProgress.status)) {
      return
    }

    let cancelled = false

    const pollJob = async () => {
      try {
        const latest = await api.getWorkPlanWorkbookJob(jobProgress.job_id)
        if (!cancelled) {
          setJobProgress(latest)
        }
      } catch (pollError) {
        if (!cancelled) {
          setDownloading(false)
          setError(pollError instanceof Error ? pollError.message : '작업 계획서 진행 상태를 확인하지 못했습니다.')
        }
      }
    }

    void pollJob()
    const timer = window.setInterval(() => {
      void pollJob()
    }, 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobProgress?.job_id, jobProgress?.status])

  useEffect(() => {
    if (!jobProgress || jobProgress.status !== 'success' || !jobProgress.download_ready) {
      return
    }
    if (downloadedJobIdRef.current === jobProgress.job_id) {
      return
    }

    downloadedJobIdRef.current = jobProgress.job_id

    void (async () => {
      try {
        const { blob, filename } = await api.downloadWorkPlanWorkbookJob(jobProgress.job_id)
        triggerDownload(blob, filename)
        setDownloadMessage(`${filename} 다운로드를 시작했습니다.`)
      } catch (downloadError) {
        setError(downloadError instanceof Error ? downloadError.message : '작업 계획서 다운로드에 실패했습니다.')
      } finally {
        setDownloading(false)
      }
    })()
  }, [jobProgress])

  useEffect(() => {
    if (!jobProgress || jobProgress.status !== 'failed') {
      return
    }
    setDownloading(false)
    setError(jobProgress.error_message || jobProgress.detail || '작업 계획서 생성에 실패했습니다.')
  }, [jobProgress])

  async function loadCards() {
    try {
      setLoading(true)
      setError('')
      setCards(await api.getKanbanCards())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '작업 카드 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDownload() {
    if (!selectedCard) {
      return
    }

    try {
      setDownloading(true)
      setError('')
      setDownloadMessage('')
      downloadedJobIdRef.current = ''
      const nextJob = await api.startWorkPlanWorkbookJob(selectedCard.id, {
        project_name: projectName.trim() || selectedCard.title,
      })
      setJobProgress(nextJob)
    } catch (downloadError) {
      setDownloading(false)
      setError(downloadError instanceof Error ? downloadError.message : '작업 계획서 생성을 시작하지 못했습니다.')
    }
  }

  async function handleDownloadSnapshotArchive() {
    if (!jobProgress || jobProgress.status !== 'success') {
      return
    }

    try {
      setDownloadingArchive(true)
      setError('')
      const { blob, filename } = await api.downloadWorkPlanSnapshotArchiveJob(jobProgress.job_id)
      triggerDownload(blob, filename)
      setDownloadMessage(`${filename} download started.`)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Snapshot archive download failed.')
    } finally {
      setDownloadingArchive(false)
    }
  }

  const downloadDisabled = !selectedCard || !linkedTargets.length || missingLinkedTargets.length > 0 || isJobRunning || downloading
  const progressValue = jobProgress?.progress_percent ?? 0
  const progressSummary = jobProgress ? formatJobSummary(jobProgress) : ''
  const snapshotArchiveReady = Boolean(jobProgress && jobProgress.status === 'success')

  return (
    <section className="planwriter-shell">
      <div className="planwriter-hero">
        <div>
          <p className="planwriter-kicker">Work Plan Draft</p>
          <h3>작업 계획서 작성</h3>
          <p className="planwriter-copy">
            작업 카드를 선택하면 카드에 할당된 대상장비 전체를 기준으로 작업 전 작업계획서 xlsx를 생성합니다.
            CVP 연결 장비는 자동 반영되고, 실제 템플릿을 넣으면 같은 시트 배치 그대로 작성됩니다.
          </p>
        </div>
        <button className="planwriter-secondary" type="button" onClick={() => void loadCards()} disabled={loading || downloading || isJobRunning}>
          <RefreshCcw size={16} />
          <span>목록 새로고침</span>
        </button>
      </div>

      {error ? <div className="planwriter-banner error">{error}</div> : null}
      {downloadMessage ? <div className="planwriter-banner success">{downloadMessage}</div> : null}

      {loading ? <div className="planwriter-empty">작업 카드 목록을 불러오는 중입니다.</div> : null}

      {!loading && !cardsWithTargets.length ? (
        <div className="planwriter-empty">대상장비가 등록된 작업 카드가 없습니다.</div>
      ) : null}

      {!loading && cardsWithTargets.length ? (
        <div className="planwriter-grid">
          <aside className="planwriter-panel planwriter-form-panel">
            <div className="planwriter-panel-head">
              <div>
                <p className="planwriter-kicker">Input</p>
                <h4>작업 카드 선택</h4>
              </div>
            </div>

            <label className="planwriter-field">
              <span>작업 카드</span>
              <select
                value={selectedCardId ?? ''}
                onChange={(event) => {
                  const nextCardId = Number(event.target.value)
                  setSelectedCardId(nextCardId)
                  const nextCard = cardsWithTargets.find((card) => card.id === nextCardId)
                  setProjectName(nextCard?.title ?? '')
                }}
              >
                {cardsWithTargets.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.card_code} | {card.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="planwriter-field">
              <span>프로젝트명</span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="작업 카드 제목 기준" />
            </label>

            <div className="planwriter-fixed-stage">
              <strong>작성 단계</strong>
              <span>작업 전</span>
            </div>

            <div className="planwriter-notice">
              <FileSpreadsheet size={16} />
              <p>
                현재는 기본 템플릿으로도 동작하고, 추후 실제 작업계획서 템플릿 파일만 교체하면 같은 로직과 같은 셀
                배치로 그대로 생성됩니다.
              </p>
            </div>

            {jobProgress ? (
              <div className={`planwriter-progress ${jobProgress.status}`}>
                <div className="planwriter-progress-head">
                  <strong>생성 진행도</strong>
                  <span>{progressValue}%</span>
                </div>
                <div className="planwriter-progress-bar" aria-hidden="true">
                  <span style={{ width: `${progressValue}%` }} />
                </div>
                <p className="planwriter-progress-detail">{jobProgress.detail || progressSummary}</p>
                <p className="planwriter-progress-meta">{progressSummary}</p>
              </div>
            ) : null}

            <button className="planwriter-primary" type="button" onClick={() => void handleDownload()} disabled={downloadDisabled}>
              <Download size={16} />
              <span>{isJobRunning || downloading ? '생성 중...' : '작업 계획서 xlsx 다운로드'}</span>
            </button>
            {snapshotArchiveReady ? (
              <button
                className="planwriter-secondary"
                type="button"
                onClick={() => void handleDownloadSnapshotArchive()}
                disabled={downloadingArchive}
              >
                <Download size={16} />
                <span>{downloadingArchive ? 'Preparing snapshot zip...' : 'Snapshot ZIP download'}</span>
              </button>
            ) : null}
          </aside>

          <div className="planwriter-stack">
            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Card Scope</p>
                  <h4>대상장비 자동 반영</h4>
                </div>
                <span className="planwriter-pill">{allTargets.length} targets</span>
              </div>

              <div className="planwriter-meta-grid">
                <StatCard label="카드 코드" value={selectedCard?.card_code ?? '-'} />
                <StatCard label="할당자" value={selectedCard?.assignee || '-'} />
                <StatCard label="전체 대상장비" value={String(allTargets.length)} />
                <StatCard label="CVP 연결 장비" value={String(linkedTargets.length)} />
              </div>

              {missingLinkedTargets.length ? (
                <div className="planwriter-inline-error">
                  다음 대상장비는 CVP 연결 정보가 없어 현재 작업계획서 생성 대상에 포함될 수 없습니다:{' '}
                  {missingLinkedTargets.map((target) => target.display_name).join(', ')}
                </div>
              ) : null}
            </section>

            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Target List</p>
                  <h4>카드에 할당된 대상장비</h4>
                </div>
              </div>

              <div className="planwriter-target-list">
                {allTargets.map((target) => (
                  <TargetRow key={target.id ?? `${target.display_name}-${target.mgmt_ip}`} target={target} />
                ))}
              </div>
            </section>

            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Workbook Layout</p>
                  <h4>원본 시트 구조</h4>
                </div>
              </div>

              <div className="planwriter-sheet-list">
                <SheetCard title="①변경개요" body="D7에 대상장비 목록 전체를 넣고, 작업 카드 프로젝트명 기준으로 파일명을 생성합니다." />
                <SheetCard title="③Check(전 후)" body="장비별 작업 전 행에 전체 점검 컬럼을 채웁니다. 실제 템플릿의 행 배치 구조를 그대로 사용합니다." />
                <SheetCard title="④ 사전 Config 검증" body="장비별 running-config 본문을 작업 전 컬럼에 채우고, Compare 및 비고 컬럼 구조를 유지합니다." />
                <SheetCard title="⑥ 작업시나리오" body="장비명, 관리 IP, CVP snapshot 비교 링크를 원본 위치에 배치합니다." />
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function TargetRow({ target }: { target: KanbanTargetItem }) {
  const isLinked = Boolean(target.cvp_device_id?.trim())
  return (
    <article className="planwriter-target-card">
      <div className="planwriter-target-head">
        <strong>{target.display_name}</strong>
        <span className={`planwriter-target-badge ${isLinked ? 'linked' : 'missing'}`}>
          {isLinked ? 'CVP 연결' : 'CVP 미연결'}
        </span>
      </div>
      <p>
        {target.mgmt_ip || '관리 IP 없음'}
        {target.model ? ` | ${target.model}` : ''}
      </p>
    </article>
  )
}

function triggerDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000)
}

function formatJobSummary(job: WorkPlanProgressResponse) {
  const step = WORKPLAN_STEP_LABELS[job.step] ?? job.step
  const status = WORKPLAN_STATUS_LABELS[job.status] ?? job.status
  return `${status} · ${step}`
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="planwriter-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function SheetCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="planwriter-sheet-card">
      <div className="planwriter-sheet-head">
        <Sheet size={16} />
        <strong>{title}</strong>
      </div>
      <p>{body}</p>
    </article>
  )
}

const WORKPLAN_STATUS_LABELS: Record<string, string> = {
  queued: '대기',
  running: '진행 중',
  success: '완료',
  failed: '실패',
}

const WORKPLAN_STEP_LABELS: Record<string, string> = {
  queued: '대기열 등록',
  prepare: '생성 시작',
  card: '카드 확인',
  target_prepare: '장비 수집 준비',
  target_runtime: 'CVP 매핑 확인',
  target_auth: 'CVP 로그인',
  target_serial: '장비 serial 조회',
  target_snapshot: 'Snapshot 실행',
  target_wait: 'Snapshot 대기',
  target_fetch: 'Snapshot 조회',
  target_extract: '명령 결과 정리',
  target_parse: '명령 결과 파싱',
  target_done: '장비 수집 완료',
  template: '템플릿 로드',
  workbook: '엑셀 작성',
  save: '파일 저장',
  completed: '완료',
  failed: '실패',
}
