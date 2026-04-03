import { useEffect, useMemo, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { Link2, PencilLine, Plus, Search, Trash2 } from 'lucide-react'

import { api } from '../../api'
import type { EdmLink, EdmLinkColorKey, EdmLinkInput } from '../../types'
import './edm-links.css'

const COLOR_OPTIONS: Array<{ key: EdmLinkColorKey; label: string }> = [
  { key: 'ocean', label: '오션' },
  { key: 'forest', label: '포레스트' },
  { key: 'sunset', label: '선셋' },
  { key: 'plum', label: '플럼' },
  { key: 'cobalt', label: '코발트' },
  { key: 'slate', label: '슬레이트' },
]

const EMPTY_LINK_INPUT: EdmLinkInput = {
  title: '',
  subtitle: '',
  link_type: '',
  url: '',
  color_key: 'ocean',
}

export function EdmLinkManager() {
  const [links, setLinks] = useState<EdmLink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null)
  const [editorLink, setEditorLink] = useState<EdmLink | null>(null)
  const [formValues, setFormValues] = useState<EdmLinkInput>(EMPTY_LINK_INPUT)
  const [searchQuery, setSearchQuery] = useState('')
  const [draggedLinkId, setDraggedLinkId] = useState<number | null>(null)
  const [dropTargetId, setDropTargetId] = useState<number | null>(null)

  const sortedLinks = useMemo(
    () => [...links].sort((left, right) => left.sort_order - right.sort_order || left.id - right.id),
    [links],
  )
  const filteredLinks = useMemo(() => {
    const token = searchQuery.trim().toLowerCase()
    if (!token) {
      return sortedLinks
    }
    return sortedLinks.filter((link) =>
      [link.title, link.subtitle, link.link_type].join(' ').toLowerCase().includes(token),
    )
  }, [searchQuery, sortedLinks])

  useEffect(() => {
    void loadLinks()
  }, [])

  async function loadLinks() {
    try {
      setLoading(true)
      setError('')
      setLinks(await api.getEdmLinks())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'EDM LINK 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  function openCreateModal() {
    setEditorMode('create')
    setEditorLink(null)
    setFormValues(EMPTY_LINK_INPUT)
  }

  function openEditModal(link: EdmLink) {
    setEditorMode('edit')
    setEditorLink(link)
    setFormValues({
      title: link.title,
      subtitle: link.subtitle,
      link_type: link.link_type,
      url: link.url,
      color_key: link.color_key,
    })
  }

  function closeModal() {
    setEditorMode(null)
    setEditorLink(null)
    setFormValues(EMPTY_LINK_INPUT)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload = normalizeLinkInput(formValues)
    if (!payload.title || !payload.url) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      if (editorMode === 'edit' && editorLink) {
        const updated = await api.updateEdmLink(editorLink.id, payload)
        setLinks((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      } else {
        const created = await api.createEdmLink(payload)
        setLinks((current) => [...current, created])
      }
      closeModal()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'EDM LINK를 저장하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(linkId: number) {
    if (!window.confirm('이 EDM LINK를 삭제할까요?')) {
      return
    }

    try {
      setSubmitting(true)
      setError('')
      await api.deleteEdmLink(linkId)
      setLinks((current) => current.filter((item) => item.id !== linkId))
      closeModal()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'EDM LINK를 삭제하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  function openLink(url: string) {
    window.open(ensureAbsoluteUrl(url), '_blank', 'noopener,noreferrer')
  }

  function handleDragStart(linkId: number) {
    setDraggedLinkId(linkId)
    setDropTargetId(linkId)
  }

  function handleDragOver(event: DragEvent<HTMLElement>, linkId: number) {
    event.preventDefault()
    if (draggedLinkId === null || draggedLinkId === linkId) {
      return
    }
    setDropTargetId(linkId)
  }

  async function handleDrop(targetId: number) {
    if (draggedLinkId === null || draggedLinkId === targetId) {
      setDraggedLinkId(null)
      setDropTargetId(null)
      return
    }

    const fromIndex = sortedLinks.findIndex((item) => item.id === draggedLinkId)
    const toIndex = sortedLinks.findIndex((item) => item.id === targetId)
    if (fromIndex < 0 || toIndex < 0) {
      setDraggedLinkId(null)
      setDropTargetId(null)
      return
    }

    const reordered = [...sortedLinks]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    const normalized = reordered.map((item, index) => ({ ...item, sort_order: index + 1 }))

    setLinks(normalized)
    setDraggedLinkId(null)
    setDropTargetId(null)

    try {
      const changed = normalized.filter((item, index) => item.sort_order !== sortedLinks[index]?.sort_order || item.id !== sortedLinks[index]?.id)
      await Promise.all(changed.map((item) => api.updateEdmLink(item.id, { sort_order: item.sort_order })))
      const latest = await api.getEdmLinks()
      setLinks(latest)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '링크 순서를 저장하지 못했습니다.')
      await loadLinks()
    }
  }

  function handleDragEnd() {
    setDraggedLinkId(null)
    setDropTargetId(null)
  }

  return (
    <section className="edm-shell">
      <div className="edm-toolbar">
        <div className="edm-toolbar-copy">
          <p className="edm-kicker">EDM Link Directory</p>
          <h3>사내 링크 바로가기</h3>
          <p className="edm-copy">자주 쓰는 포털, 문서, 시스템 링크를 빠르게 열고 순서를 정리할 수 있습니다.</p>
        </div>
        <button className="edm-primary-button" type="button" onClick={openCreateModal}>
          <Plus size={16} />
          <span>링크 등록</span>
        </button>
      </div>

      <div className="edm-search-row">
        <label className="edm-search">
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="링크 이름이나 설명을 검색하세요..."
          />
        </label>
        <div className="edm-count">총 {filteredLinks.length}개의 링크</div>
      </div>

      {error ? <div className="edm-message error">{error}</div> : null}
      {loading ? <div className="edm-loading">EDM LINK 목록을 불러오는 중입니다.</div> : null}

      {!loading ? (
        filteredLinks.length > 0 ? (
          <div className="edm-grid">
            {filteredLinks.map((link) => (
              <article
                key={link.id}
                className={`edm-card ${link.color_key} ${draggedLinkId === link.id ? 'is-dragging' : ''} ${
                  dropTargetId === link.id && draggedLinkId !== link.id ? 'is-drop-target' : ''
                }`}
                draggable
                onDragStart={() => handleDragStart(link.id)}
                onDragOver={(event) => handleDragOver(event, link.id)}
                onDrop={() => void handleDrop(link.id)}
                onDragEnd={handleDragEnd}
              >
                <div className="edm-card-top">
                  <span className="edm-type-badge">{link.link_type || '바로가기'}</span>
                  <button className="edm-icon-button" type="button" onClick={() => openEditModal(link)} aria-label="링크 수정">
                    <PencilLine size={16} />
                  </button>
                </div>

                <div className="edm-card-body">
                  <h4>{link.title}</h4>
                  <p>{link.subtitle || '설명이 없는 링크입니다.'}</p>
                </div>

                <div className="edm-card-foot">
                  <div className="edm-link-preview">{link.url}</div>
                  <button className="edm-open-button" type="button" onClick={() => openLink(link.url)}>
                    <Link2 size={16} />
                    <span>열기</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="edm-empty-state">
            <strong>표시할 EDM LINK가 없습니다.</strong>
            <p>검색어를 바꾸거나 새 링크를 등록해 주세요.</p>
          </div>
        )
      ) : null}

      {editorMode ? (
        <div className="edm-modal-backdrop" onClick={closeModal}>
          <div className="edm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="edm-modal-head">
              <div>
                <p className="edm-kicker">{editorMode === 'create' ? 'Create Link' : 'Edit Link'}</p>
                <h3>{editorMode === 'create' ? '새 EDM LINK 등록' : editorLink?.title ?? 'EDM LINK 수정'}</h3>
              </div>
              <button className="edm-secondary-button ghost" type="button" onClick={closeModal}>
                닫기
              </button>
            </div>

            <form className="edm-form" onSubmit={handleSubmit}>
              <label className="edm-field wide">
                <span>제목</span>
                <input
                  value={formValues.title}
                  onChange={(event) => setFormValues((current) => ({ ...current, title: event.target.value }))}
                  placeholder="예: 공통 포털"
                  required
                />
              </label>

              <div className="edm-field-grid">
                <label className="edm-field">
                  <span>링크 종류</span>
                  <input
                    value={formValues.link_type}
                    onChange={(event) => setFormValues((current) => ({ ...current, link_type: event.target.value }))}
                    placeholder="예: 공통 포털"
                  />
                </label>

                <label className="edm-field">
                  <span>설명</span>
                  <input
                    value={formValues.subtitle}
                    onChange={(event) => setFormValues((current) => ({ ...current, subtitle: event.target.value }))}
                    placeholder="간단한 설명"
                  />
                </label>
              </div>

              <label className="edm-field wide">
                <span>링크 URL</span>
                <input
                  value={formValues.url}
                  onChange={(event) => setFormValues((current) => ({ ...current, url: event.target.value }))}
                  placeholder="https://..."
                  required
                />
              </label>

              <div className="edm-field wide">
                <span>카드 색상</span>
                <div className="edm-color-grid">
                  {COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      className={`edm-color-option ${option.key} ${formValues.color_key === option.key ? 'active' : ''}`}
                      type="button"
                      onClick={() => setFormValues((current) => ({ ...current, color_key: option.key }))}
                    >
                      <span className="edm-color-swatch" />
                      <strong>{option.label}</strong>
                    </button>
                  ))}
                </div>
              </div>

              <div className="edm-modal-actions">
                {editorMode === 'edit' && editorLink ? (
                  <button className="edm-secondary-button danger" type="button" onClick={() => void handleDelete(editorLink.id)} disabled={submitting}>
                    <Trash2 size={16} />
                    <span>삭제</span>
                  </button>
                ) : (
                  <span />
                )}
                <div className="edm-inline-actions">
                  <button className="edm-secondary-button ghost" type="button" onClick={closeModal} disabled={submitting}>
                    취소
                  </button>
                  <button className="edm-primary-button" type="submit" disabled={submitting || !formValues.title.trim() || !formValues.url.trim()}>
                    {submitting ? '저장 중...' : editorMode === 'create' ? '등록' : '저장'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function normalizeLinkInput(values: EdmLinkInput): EdmLinkInput {
  return {
    title: values.title.trim(),
    subtitle: values.subtitle.trim(),
    link_type: values.link_type.trim(),
    url: ensureAbsoluteUrl(values.url.trim()),
    color_key: values.color_key,
  }
}

function ensureAbsoluteUrl(url: string) {
  const trimmed = url.trim()
  if (!trimmed) {
    return ''
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    return trimmed
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`
  }
  return `https://${trimmed.replace(/^\/+/, '')}`
}
