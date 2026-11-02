import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, FileText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DocumentTab } from '../types'

interface TabStripProps {
  documents: DocumentTab[]
  activeId: string | null
  onActivate: (documentId: string) => void
  onClose: (documentId: string) => void
  onCloseMany: (documentIds: string[]) => void
}

interface ContextMenuState {
  documentId: string
  x: number
  y: number
}

export function TabStrip({
  documents,
  activeId,
  onActivate,
  onClose,
  onCloseMany,
}: TabStripProps) {
  const { t } = useTranslation()
  const stripRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [overflow, setOverflow] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    const strip = stripRef.current
    if (!strip || typeof ResizeObserver === 'undefined') return
    const update = () => setOverflow(strip.scrollWidth > strip.clientWidth + 2)
    const observer = new ResizeObserver(update)
    observer.observe(strip)
    update()
    return () => observer.disconnect()
  }, [documents.length])

  useEffect(() => {
    if (!contextMenu && !listOpen) return
    const close = () => {
      setContextMenu(null)
      setListOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu, listOpen])

  const focusAt = (index: number) => {
    if (documents.length === 0) return
    const resolved = (index + documents.length) % documents.length
    const document = documents[resolved]
    onActivate(document.id)
    requestAnimationFrame(() => tabRefs.current.get(document.id)?.focus())
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusAt(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(documents.length - 1)
    }
  }

  return (
    <div className="tab-bar">
      <div className="tab-strip" role="tablist" ref={stripRef}>
        {documents.map((document, index) => (
          <div
            className={`tab ${document.id === activeId ? 'active' : ''}`}
            key={document.id}
            role="presentation"
            title={document.path ?? document.displayName}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(document.id)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              setContextMenu({
                documentId: document.id,
                x: event.clientX,
                y: event.clientY,
              })
            }}
          >
            <button
              className="tab-main"
              type="button"
              role="tab"
              id={`tab-${document.id}`}
              aria-controls={`panel-${document.id}`}
              aria-selected={document.id === activeId}
              tabIndex={document.id === activeId ? 0 : -1}
              ref={(node) => {
                if (node) tabRefs.current.set(document.id, node)
                else tabRefs.current.delete(document.id)
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onClick={() => onActivate(document.id)}
            >
              <FileText size={14} aria-hidden="true" />
              <span className="tab-title">{document.displayName}</span>
              {document.dirty && (
                <span className="dirty-dot" aria-label={t('modified')} />
              )}
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={t('closeDocument', { name: document.displayName })}
              onClick={() => onClose(document.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>

      {overflow && (
        <button
          className="tab-list-button"
          type="button"
          aria-label={t('allDocuments')}
          aria-expanded={listOpen}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setListOpen((open) => !open)}
        >
          <ChevronDown size={15} />
        </button>
      )}

      {listOpen && (
        <div
          className="tab-list-menu"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {documents.map((document) => (
            <button
              type="button"
              role="menuitem"
              key={document.id}
              className={document.id === activeId ? 'active' : ''}
              onClick={() => {
                onActivate(document.id)
                setListOpen(false)
              }}
            >
              <span>{document.displayName}</span>
              {document.dirty && <span aria-hidden="true">●</span>}
            </button>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="tab-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose(contextMenu.documentId)
              setContextMenu(null)
            }}
          >
            {t('close')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseMany(
                documents
                  .filter((document) => document.id !== contextMenu.documentId)
                  .map((document) => document.id),
              )
              setContextMenu(null)
            }}
          >
            {t('closeOthers')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseMany(documents.map((document) => document.id))
              setContextMenu(null)
            }}
          >
            {t('closeAll')}
          </button>
        </div>
      )}
    </div>
  )
}
