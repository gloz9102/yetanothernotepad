import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { editorSessions } from '../lib/editorSessions'
import { useSettingsStore } from '../stores/settingsStore'
import type { DocumentTab, LineRange } from '../types'

export function useSplitLayout(
  activeDocument: DocumentTab | null,
  linkSourceLines: boolean,
) {
  const persistedSplitRatio = useSettingsStore((state) => state.splitRatio)
  const setPersistedSplitRatio = useSettingsStore(
    (state) => state.setSplitRatio,
  )
  const [splitRatio, setSplitRatio] = useState(persistedSplitRatio)
  const previewPaneRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const scrollSyncRef = useRef(false)
  const activeDocumentRef = useRef(activeDocument)
  activeDocumentRef.current = activeDocument

  const handleEditorScroll = useCallback((fraction: number) => {
    const document = activeDocumentRef.current
    const preview = previewPaneRef.current
    if (!document || document.viewMode !== 'split' || !preview) return
    if (scrollSyncRef.current) return
    scrollSyncRef.current = true
    const max = preview.scrollHeight - preview.clientHeight
    preview.scrollTop = fraction * Math.max(0, max)
    requestAnimationFrame(() => {
      scrollSyncRef.current = false
    })
  }, [])

  const handlePreviewScroll = useCallback(() => {
    const document = activeDocumentRef.current
    const preview = previewPaneRef.current
    if (!document || document.viewMode !== 'split' || !preview) return
    if (scrollSyncRef.current) return
    scrollSyncRef.current = true
    const max = preview.scrollHeight - preview.clientHeight
    editorSessions.setScrollFraction(max > 0 ? preview.scrollTop / max : 0)
    requestAnimationFrame(() => {
      scrollSyncRef.current = false
    })
  }, [])

  const handleSeparatorPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const separator = event.currentTarget
      separator.setPointerCapture(event.pointerId)
      const onMove = (moveEvent: PointerEvent) => {
        const rect = workspaceRef.current?.getBoundingClientRect()
        if (!rect || rect.width === 0) return
        setSplitRatio(
          Math.min(
            75,
            Math.max(25, ((moveEvent.clientX - rect.left) / rect.width) * 100),
          ),
        )
      }
      // lostpointercapture follows both pointerup and pointercancel, so a
      // cancelled drag cannot leave the move listener attached.
      const onEnd = () => {
        separator.removeEventListener('pointermove', onMove)
        separator.removeEventListener('lostpointercapture', onEnd)
        setSplitRatio((current) => {
          setPersistedSplitRatio(current)
          return current
        })
      }
      separator.addEventListener('pointermove', onMove)
      separator.addEventListener('lostpointercapture', onEnd)
    },
    [setPersistedSplitRatio],
  )

  const handleSourceLinesSelect = useCallback((range: LineRange | null) => {
    editorSessions.showLinkedLines(range)
  }, [])

  useEffect(() => {
    if (!linkSourceLines) editorSessions.showLinkedLines(null)
  }, [activeDocument?.id, linkSourceLines])

  const adjustSplitRatio = useCallback(
    (next: number) => {
      const resolved = Math.min(75, Math.max(25, next))
      setSplitRatio(resolved)
      setPersistedSplitRatio(resolved)
    },
    [setPersistedSplitRatio],
  )

  useEffect(() => {
    setSplitRatio(persistedSplitRatio)
  }, [persistedSplitRatio])

  return {
    splitRatio,
    previewPaneRef,
    workspaceRef,
    handleEditorScroll,
    handlePreviewScroll,
    handleSeparatorPointerDown,
    handleSourceLinesSelect,
    adjustSplitRatio,
  }
}
