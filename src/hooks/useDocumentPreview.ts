import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { editorSessions } from '../lib/editorSessions'
import {
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_MAX_BYTES,
  PREVIEW_SOFT_BYTES,
} from '../lib/documentPolicy'
import { useDocumentStore } from '../stores/documentStore'
import type { ViewMode } from '../types'
import type { DocumentRecovery } from './useDocumentRecovery'

export function useDocumentPreview(
  scheduleRecoveryDocument: DocumentRecovery['scheduleRecoveryDocument'],
  setErrorMessage: (message: string) => void,
) {
  const { t } = useTranslation()
  const [manualPreviews, setManualPreviews] = useState<Record<string, string>>(
    {},
  )
  const previewTimersRef = useRef(new Map<string, number>())

  const clearManualPreview = useCallback((documentId: string) => {
    setManualPreviews((current) => {
      const next = { ...current }
      delete next[documentId]
      return next
    })
  }, [])

  const schedulePreview = useCallback((documentId: string) => {
    const previous = previewTimersRef.current.get(documentId)
    if (previous !== undefined) window.clearTimeout(previous)
    const timer = window.setTimeout(() => {
      previewTimersRef.current.delete(documentId)
      const document = useDocumentStore.getState().documentsById[documentId]
      if (
        !document ||
        document.kind !== 'markdown' ||
        document.viewMode === 'source' ||
        document.byteLength > PREVIEW_SOFT_BYTES
      ) {
        return
      }
      const materialized = editorSessions.materialize(documentId)
      useDocumentStore
        .getState()
        .setMaterializedContent(
          documentId,
          materialized.content,
          materialized.byteLength,
        )
    }, PREVIEW_DEBOUNCE_MS)
    previewTimersRef.current.set(documentId, timer)
  }, [])

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      const state = useDocumentStore.getState()
      const documentId = state.activeId
      const document = documentId ? state.documentsById[documentId] : null
      if (!document || document.kind !== 'markdown') return

      if (mode !== 'source') {
        const materialized = editorSessions.materialize(document.id)
        useDocumentStore
          .getState()
          .setMaterializedContent(
            document.id,
            materialized.content,
            materialized.byteLength,
          )
        if (materialized.byteLength > PREVIEW_MAX_BYTES) {
          setErrorMessage(t('previewUnavailable'))
          return
        }
        if (materialized.byteLength > PREVIEW_SOFT_BYTES) {
          clearManualPreview(document.id)
        }
      }
      useDocumentStore.getState().setViewMode(document.id, mode)
      if (mode === 'split' || mode === 'preview') {
        editorSessions.setLastMarkdownViewMode(document.id, mode)
      }
      scheduleRecoveryDocument(document.id)
    },
    [clearManualPreview, scheduleRecoveryDocument, setErrorMessage, t],
  )

  const handleEditorChange = useCallback(
    (documentId: string, dirty: boolean) => {
      useDocumentStore.getState().setDirty(documentId, dirty)
      const document = useDocumentStore.getState().documentsById[documentId]
      if (
        document?.kind === 'markdown' &&
        document.viewMode !== 'source' &&
        document.byteLength <= PREVIEW_SOFT_BYTES
      ) {
        schedulePreview(documentId)
      }
      scheduleRecoveryDocument(documentId)
    },
    [schedulePreview, scheduleRecoveryDocument],
  )

  const refreshManualPreview = useCallback(() => {
    const state = useDocumentStore.getState()
    const document = state.activeId ? state.documentsById[state.activeId] : null
    if (!document) return
    const materialized = editorSessions.materialize(document.id)
    useDocumentStore
      .getState()
      .setMaterializedContent(
        document.id,
        materialized.content,
        materialized.byteLength,
      )
    setManualPreviews((current) => ({
      ...current,
      [document.id]: materialized.content,
    }))
  }, [])

  useEffect(() => {
    const timers = previewTimersRef.current
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [])

  return {
    manualPreviews,
    clearManualPreview,
    setViewMode,
    handleEditorChange,
    refreshManualPreview,
  }
}

export type DocumentPreview = ReturnType<typeof useDocumentPreview>
