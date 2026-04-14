import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { Download, FileSpreadsheet, RefreshCcw, Save, Send, Settings2, Sheet } from 'lucide-react'

import { api } from '../../api'
import type {
  KanbanCard,
  KanbanTargetItem,
  WinScpProfileConfig,
  WinScpProfileInput,
  WorkPlanEvidenceSummary,
  WorkPlanProgressResponse,
} from '../../types'
import './workplan-writer.css'

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running'])

type StepLabel = '작업 전' | '작업 후'
type WinScpDraft = WinScpProfileInput & { id?: number }

export function WorkPlanWriterBoard() {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [profiles, setProfiles] = useState<WinScpProfileConfig[]>([])
  const [profileDrafts, setProfileDrafts] = useState<WinScpDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingProfiles, setLoadingProfiles] = useState(true)
  const [savingProfiles, setSavingProfiles] = useState(false)
  const [uploadingEvidence, setUploadingEvidence] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadingArchive, setDownloadingArchive] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [projectName, setProjectName] = useState('')
  const [stepLabel, setStepLabel] = useState<StepLabel>('작업 전')
  const [afterWorkbookFile, setAfterWorkbookFile] = useState<File | null>(null)
  const [jobProgress, setJobProgress] = useState<WorkPlanProgressResponse | null>(null)
  const [evidenceSummary, setEvidenceSummary] = useState<WorkPlanEvidenceSummary | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null)
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
    void loadProfiles()
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
    if (!selectedCard || !projectName.trim()) {
      setEvidenceSummary(null)
      return
    }
    void loadEvidence(selectedCard.id, projectName.trim())
  }, [selectedCard?.id, projectName])

  useEffect(() => {
    if (!profiles.length) {
      setSelectedProfileId(null)
      return
    }
    if (!selectedProfileId || !profiles.some((profile) => profile.id === selectedProfileId)) {
      const defaultProfile = profiles.find((profile) => profile.is_default) ?? profiles[0]
      setSelectedProfileId(defaultProfile.id)
    }
  }, [profiles, selectedProfileId])

  useEffect(() => {
    if (!message) {
      return
    }
    const timer = window.setTimeout(() => setMessage(''), 2600)
    return () => window.clearTimeout(timer)
  }, [message])

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
          setError(pollError instanceof Error ? pollError.message : '작업계획서 진행 상태를 확인하지 못했습니다.')
        }
      }
    }
    void pollJob()
    const timer = window.setInterval(() => void pollJob(), 1000)
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
        setMessage(`${filename} 다운로드를 시작했습니다.`)
        if (selectedCard && projectName.trim()) {
          await loadEvidence(selectedCard.id, projectName.trim())
        }
      } catch (downloadError) {
        setError(downloadError instanceof Error ? downloadError.message : '작업계획서 다운로드에 실패했습니다.')
      } finally {
        setDownloading(false)
      }
    })()
  }, [jobProgress, selectedCard, projectName])

  useEffect(() => {
    if (!jobProgress || jobProgress.status !== 'failed') {
      return
    }
    setDownloading(false)
    setError(jobProgress.error_message || jobProgress.detail || '작업계획서 생성에 실패했습니다.')
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

  async function loadProfiles() {
    try {
      setLoadingProfiles(true)
      const response = await api.getWinScpProfiles()
      setProfiles(response)
      setProfileDrafts(response.length > 0 ? response.map(toProfileDraft) : [emptyProfileDraft()])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'WinSCP 프로파일을 불러오지 못했습니다.')
    } finally {
      setLoadingProfiles(false)
    }
  }

  async function loadEvidence(cardId: number, nextProjectName: string) {
    try {
      const response = await api.getWorkPlanEvidence(cardId, nextProjectName)
      setEvidenceSummary(response)
    } catch (loadError) {
      setEvidenceSummary(null)
      setError(loadError instanceof Error ? loadError.message : '작업계획서 증적 정보를 불러오지 못했습니다.')
    }
  }

  async function handleDownload() {
    if (!selectedCard) {
      return
    }
    try {
      setDownloading(true)
      setError('')
      setMessage('')
      downloadedJobIdRef.current = ''
      const payload = {
        project_name: projectName.trim() || selectedCard.title,
        step_label: stepLabel,
        source_workbook_name: '',
        source_workbook_base64: '',
      }
      if (stepLabel === '작업 후') {
        if (!afterWorkbookFile) {
          throw new Error('작업 후 작업계획서 업로드 파일이 필요합니다.')
        }
        payload.source_workbook_name = afterWorkbookFile.name
        payload.source_workbook_base64 = await fileToBase64(afterWorkbookFile)
      }
      const nextJob = await api.startWorkPlanWorkbookJob(selectedCard.id, payload)
      setJobProgress(nextJob)
    } catch (downloadError) {
      setDownloading(false)
      setError(downloadError instanceof Error ? downloadError.message : '작업계획서 생성을 시작하지 못했습니다.')
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
      setMessage(`${filename} 다운로드를 시작했습니다.`)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Snapshot ZIP 다운로드에 실패했습니다.')
    } finally {
      setDownloadingArchive(false)
    }
  }

  async function handleSaveProfiles() {
    try {
      setSavingProfiles(true)
      setError('')
      const normalized = normalizeProfileDrafts(profileDrafts)
      const saved = await api.saveWinScpProfiles(normalized)
      setProfiles(saved)
      setProfileDrafts(saved.length > 0 ? saved.map(toProfileDraft) : [emptyProfileDraft()])
      setMessage('WinSCP 설정을 저장했습니다.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'WinSCP 설정 저장에 실패했습니다.')
    } finally {
      setSavingProfiles(false)
    }
  }

  async function handleUploadEvidence() {
    if (!selectedCard) {
      return
    }
    try {
      setUploadingEvidence(true)
      setError('')
      const response = await api.uploadWorkPlanEvidence(selectedCard.id, {
        project_name: projectName.trim() || selectedCard.title,
        profile_id: selectedProfileId,
      })
      setMessage(`${response.profile_name} 프로파일로 최신 증적 업로드를 완료했습니다.`)
      await loadEvidence(selectedCard.id, projectName.trim() || selectedCard.title)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'WinSCP 업로드에 실패했습니다.')
    } finally {
      setUploadingEvidence(false)
    }
  }

  const progressValue = jobProgress?.progress_percent ?? 0
  const progressSummary = jobProgress ? formatJobSummary(jobProgress) : ''
  const snapshotArchiveReady = Boolean(jobProgress && jobProgress.status === 'success')
  const downloadDisabled =
    !selectedCard ||
    !linkedTargets.length ||
    missingLinkedTargets.length > 0 ||
    isJobRunning ||
    downloading ||
    (stepLabel === '작업 후' && !afterWorkbookFile)
  const uploadDisabled = !selectedCard || !evidenceSummary || (!evidenceSummary.before.exists && !evidenceSummary.after.exists) || uploadingEvidence

  return (
    <section className="planwriter-shell">
      <div className="planwriter-hero">
        <div>
          <p className="planwriter-kicker">Work Plan Writer</p>
          <h3>작업 계획서 작성</h3>
          <p className="planwriter-copy">
            카드에 할당된 대상 장비 전체를 기준으로 작업계획서를 생성하고, 카드/프로젝트 기준 증적 폴더에 작업 전, 작업 후,
            업로드 원본, 생성 결과물을 함께 관리합니다.
          </p>
        </div>
        <button className="planwriter-secondary" type="button" onClick={() => void loadCards()} disabled={loading || downloading || isJobRunning}>
          <RefreshCcw size={16} />
          <span>카드 새로고침</span>
        </button>
      </div>

      {error ? <div className="planwriter-banner error">{error}</div> : null}
      {message ? <div className="planwriter-banner success">{message}</div> : null}
      {loading ? <div className="planwriter-empty">작업 카드 목록을 불러오는 중입니다.</div> : null}
      {!loading && !cardsWithTargets.length ? <div className="planwriter-empty">대상 장비가 등록된 작업 카드가 없습니다.</div> : null}

      {!loading && cardsWithTargets.length ? (
        <div className="planwriter-grid">
          <aside className="planwriter-panel planwriter-form-panel">
            <div className="planwriter-panel-head">
              <div>
                <p className="planwriter-kicker">Input</p>
                <h4>기본 정보</h4>
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

            <div className="planwriter-step-toggle">
              <button type="button" className={stepLabel === '작업 전' ? 'active' : ''} onClick={() => setStepLabel('작업 전')}>
                작업 전
              </button>
              <button type="button" className={stepLabel === '작업 후' ? 'active' : ''} onClick={() => setStepLabel('작업 후')}>
                작업 후
              </button>
            </div>

            {stepLabel === '작업 후' ? (
              <label className="planwriter-field">
                <span>작업 후 반영 대상 xlsx</span>
                <input
                  type="file"
                  accept=".xlsx,.xlsm"
                  onChange={(event) => setAfterWorkbookFile(event.target.files?.[0] ?? null)}
                />
                <small className="planwriter-field-hint">{afterWorkbookFile ? afterWorkbookFile.name : '기존 작업계획서 파일을 업로드해 주세요.'}</small>
              </label>
            ) : null}

            <div className="planwriter-notice">
              <FileSpreadsheet size={16} />
              <p>
                작업 후는 업로드한 기존 작업계획서에 후행 영역만 반영합니다. 작업 전/후 최신 증적은 카드 기준 폴더에 분리 저장됩니다.
              </p>
            </div>

            {jobProgress ? (
              <div className={`planwriter-progress ${jobProgress.status}`}>
                <div className="planwriter-progress-head">
                  <strong>생성 진행률</strong>
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
              <span>{isJobRunning || downloading ? '생성 중...' : `${stepLabel} 작업계획서 xlsx 다운로드`}</span>
            </button>
            {snapshotArchiveReady ? (
              <button className="planwriter-secondary" type="button" onClick={() => void handleDownloadSnapshotArchive()} disabled={downloadingArchive}>
                <Download size={16} />
                <span>{downloadingArchive ? '준비 중...' : '현재 Job Snapshot ZIP 다운로드'}</span>
              </button>
            ) : null}
          </aside>

          <div className="planwriter-stack">
            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Card Scope</p>
                  <h4>대상 장비 반영</h4>
                </div>
                <span className="planwriter-pill">{allTargets.length} targets</span>
              </div>
              <div className="planwriter-meta-grid">
                <StatCard label="카드 코드" value={selectedCard?.card_code ?? '-'} />
                <StatCard label="담당자" value={selectedCard?.assignee || '-'} />
                <StatCard label="전체 장비" value={String(allTargets.length)} />
                <StatCard label="CVP 연결 장비" value={String(linkedTargets.length)} />
              </div>
              {missingLinkedTargets.length ? (
                <div className="planwriter-inline-error">
                  다음 대상 장비는 CVP 연결 정보가 없어 현재 작업계획서 생성 대상에 포함할 수 없습니다:
                  {' '}{missingLinkedTargets.map((target) => target.display_name).join(', ')}
                </div>
              ) : null}
            </section>

            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Evidence</p>
                  <h4>최신 증적 폴더</h4>
                </div>
                <button className="planwriter-secondary compact" type="button" onClick={() => selectedCard && void loadEvidence(selectedCard.id, projectName)} disabled={!selectedCard}>
                  <RefreshCcw size={14} />
                  <span>증적 새로고침</span>
                </button>
              </div>
              <div className="planwriter-meta-grid expanded">
                <EvidenceStageCard title="작업 전 최신" stage={evidenceSummary?.before ?? null} />
                <EvidenceStageCard title="작업 후 최신" stage={evidenceSummary?.after ?? null} />
                <StatCard label="업로드 로그" value={String(evidenceSummary?.upload_log_count ?? 0)} />
              </div>
              <div className="planwriter-upload-row">
                <label className="planwriter-field">
                  <span>업로드 프로파일</span>
                  <select value={selectedProfileId ?? ''} onChange={(event) => setSelectedProfileId(Number(event.target.value) || null)} disabled={!profiles.length}>
                    {!profiles.length ? <option value="">저장된 프로파일 없음</option> : null}
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} | {profile.protocol.toUpperCase()} | {profile.host}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="planwriter-primary" type="button" onClick={() => void handleUploadEvidence()} disabled={uploadDisabled}>
                  <Send size={16} />
                  <span>{uploadingEvidence ? '업로드 중...' : '최신 증적 WinSCP 업로드'}</span>
                </button>
              </div>
              {evidenceSummary?.upload_logs?.length ? (
                <div className="planwriter-log-list">
                  {evidenceSummary.upload_logs.slice(0, 5).map((item) => (
                    <span key={item} className="planwriter-log-chip">{item}</span>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">WinSCP</p>
                  <h4>업로드 설정</h4>
                </div>
                <button className="planwriter-secondary compact" type="button" onClick={() => setProfileDrafts((current) => [...current, emptyProfileDraft()])}>
                  <Settings2 size={14} />
                  <span>프로파일 추가</span>
                </button>
              </div>
              {loadingProfiles ? <div className="planwriter-empty compact">WinSCP 설정을 불러오는 중입니다.</div> : null}
              <div className="planwriter-profile-list">
                {profileDrafts.map((draft, index) => (
                  <article key={`${draft.id ?? 'new'}-${index}`} className="planwriter-profile-card">
                    <div className="planwriter-profile-head">
                      <strong>{draft.name || `프로파일 ${index + 1}`}</strong>
                      <button
                        className="planwriter-secondary compact"
                        type="button"
                        onClick={() => setProfileDrafts((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                        disabled={profileDrafts.length === 1}
                      >
                        삭제
                      </button>
                    </div>
                    <div className="planwriter-profile-grid">
                      <Field label="이름"><input value={draft.name} onChange={(event) => updateProfileDraft(index, { name: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="WinSCP 경로"><input value={draft.winscp_path} onChange={(event) => updateProfileDraft(index, { winscp_path: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="프로토콜">
                        <select value={draft.protocol} onChange={(event) => updateProfileDraft(index, { protocol: event.target.value as WinScpDraft['protocol'] }, setProfileDrafts)}>
                          <option value="sftp">SFTP</option>
                          <option value="scp">SCP</option>
                          <option value="ftp">FTP</option>
                        </select>
                      </Field>
                      <Field label="Host / IP"><input value={draft.host} onChange={(event) => updateProfileDraft(index, { host: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="Port"><input type="number" value={draft.port} onChange={(event) => updateProfileDraft(index, { port: Number(event.target.value) || 0 }, setProfileDrafts)} /></Field>
                      <Field label="Username"><input value={draft.username} onChange={(event) => updateProfileDraft(index, { username: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="Password"><input type="password" value={draft.password} onChange={(event) => updateProfileDraft(index, { password: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="Remote Path"><input value={draft.remote_path} onChange={(event) => updateProfileDraft(index, { remote_path: event.target.value }, setProfileDrafts)} /></Field>
                      <Field label="Host Key"><input value={draft.host_key} onChange={(event) => updateProfileDraft(index, { host_key: event.target.value }, setProfileDrafts)} /></Field>
                    </div>
                    <div className="planwriter-profile-flags">
                      <label><input type="checkbox" checked={draft.enabled} onChange={(event) => updateProfileDraft(index, { enabled: event.target.checked }, setProfileDrafts)} /> 사용</label>
                      <label><input type="checkbox" checked={draft.is_default} onChange={(event) => updateProfileDefault(index, event.target.checked, setProfileDrafts)} /> 기본 프로파일</label>
                    </div>
                  </article>
                ))}
              </div>
              <button className="planwriter-primary" type="button" onClick={() => void handleSaveProfiles()} disabled={savingProfiles}>
                <Save size={16} />
                <span>{savingProfiles ? '저장 중...' : 'WinSCP 설정 저장'}</span>
              </button>
            </section>

            <section className="planwriter-panel">
              <div className="planwriter-panel-head">
                <div>
                  <p className="planwriter-kicker">Target List</p>
                  <h4>카드 할당 대상 장비</h4>
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
                <SheetCard title="①변경개요" body="D7에 대상 장비 목록을 넣고 프로젝트명을 기준으로 파일명을 만듭니다." />
                <SheetCard title="③Check(전 후)" body="작업 전은 짝수 행, 작업 후는 홀수 행에 결과를 채웁니다." />
                <SheetCard title="④ 사전 Config 검증" body="장비별 컬럼 배치를 유지한 채 작업 전/후 running-config를 각 컬럼에 씁니다." />
                <SheetCard title="⑥ 작업시나리오" body="장비명, 관리 IP, CVP snapshot 비교 링크를 원본 위치 그대로 반영합니다." />
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
        <span className={`planwriter-target-badge ${isLinked ? 'linked' : 'missing'}`}>{isLinked ? 'CVP 연결' : 'CVP 미연결'}</span>
      </div>
      <p>
        {target.mgmt_ip || '관리 IP 없음'}
        {target.model ? ` | ${target.model}` : ''}
      </p>
    </article>
  )
}

function EvidenceStageCard({ title, stage }: { title: string; stage: WorkPlanEvidenceSummary['before'] | null }) {
  return (
    <article className="planwriter-stat-card">
      <span>{title}</span>
      <strong>{stage?.exists ? stage.workbook_filename || '생성됨' : '없음'}</strong>
      <small className="planwriter-stat-sub">
        {stage?.exists ? `${stage.snapshot_output_count} files | ${stage.history_count} history` : '아직 저장된 증적이 없습니다.'}
      </small>
    </article>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="planwriter-field">
      <span>{label}</span>
      {children}
    </label>
  )
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

function emptyProfileDraft(): WinScpDraft {
  return {
    name: '',
    winscp_path: '',
    protocol: 'sftp',
    host: '',
    port: 22,
    username: '',
    password: '',
    remote_path: '/',
    host_key: '',
    enabled: true,
    is_default: false,
  }
}

function toProfileDraft(profile: WinScpProfileConfig): WinScpDraft {
  return { ...profile }
}

function normalizeProfileDrafts(items: WinScpDraft[]): WinScpProfileInput[] {
  let defaultSeen = false
  return items
    .filter((item) => item.name.trim() || item.host.trim() || item.winscp_path.trim())
    .map((item, index) => {
      const isDefault = item.is_default && !defaultSeen
      if (isDefault) {
        defaultSeen = true
      }
      return {
        name: item.name.trim(),
        winscp_path: item.winscp_path.trim(),
        protocol: item.protocol,
        host: item.host.trim(),
        port: Number(item.port) || (item.protocol === 'ftp' ? 21 : 22),
        username: item.username.trim(),
        password: item.password,
        remote_path: item.remote_path.trim() || '/',
        host_key: item.host_key.trim(),
        enabled: item.enabled,
        is_default: isDefault || (!defaultSeen && index === 0),
      }
    })
}

function updateProfileDraft(index: number, changes: Partial<WinScpDraft>, setDrafts: Dispatch<SetStateAction<WinScpDraft[]>>) {
  setDrafts((current) => current.map((draft, currentIndex) => (currentIndex === index ? { ...draft, ...changes } : draft)))
}

function updateProfileDefault(index: number, checked: boolean, setDrafts: Dispatch<SetStateAction<WinScpDraft[]>>) {
  setDrafts((current) =>
    current.map((draft, currentIndex) => ({
      ...draft,
      is_default: checked ? currentIndex === index : currentIndex === index ? false : draft.is_default,
    })),
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

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return window.btoa(binary)
}

function formatJobSummary(job: WorkPlanProgressResponse) {
  const step = WORKPLAN_STEP_LABELS[job.step] ?? job.step
  const status = WORKPLAN_STATUS_LABELS[job.status] ?? job.status
  return `${job.step_label} | ${status} | ${step}`
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
  target_prepare: '장비 준비',
  target_runtime: 'CVP 매핑 확인',
  target_auth: 'CVP 로그인',
  target_serial: '장비 serial 조회',
  target_snapshot: 'Snapshot 실행',
  target_wait: 'Snapshot 대기',
  target_fetch: 'Snapshot 조회',
  target_extract: '결과 정리',
  target_parse: '결과 파싱',
  target_done: '장비 수집 완료',
  template: '워크북 준비',
  workbook: '시트 반영',
  save: '파일 저장',
  completed: '완료',
  failed: '실패',
}
