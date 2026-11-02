import { useCallback, useEffect, useRef } from 'react'
import { documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import {
  LAYOUT_DEBOUNCE_MS,
  RECOVERY_DEBOUNCE_MS,
  recoveryDelay,
} from '../lib/documentPolicy'
import { useDocumentStore } from '../stores/documentStore'
import type { DocumentRuntime } from './useDocumentRuntime'

export function useDocumentRecovery(
  { tasks, closingRef }: DocumentRuntime,
  reportError: (error: unknown) => void,
) {
  const documentOrder = useDocumentStore((state) => state.documentOrder)
  const activeId = useDocumentStore((state) => state.activeId)
  const hydrated = useDocumentStore((state) => state.hydrated)
  const recoveryFirstAtRef = useRef(new Map<string, number>())
  const recoveryTimersRef = useRef(new Map<string, number>())
  const recoveryInFlightRef = useRef(new Set<Promise<unknown>>())

  const trackRecovery = useCallback((promise: Promise<unknown>) => {
    const tracked = promise.finally(() =>
      recoveryInFlightRef.current.delete(tracked),
    )
    recoveryInFlightRef.current.add(tracked)
    return tracked
  }, [])

  const persistRecoveryDocument = useCallback(
    (documentId: string) =>
      tasks.run(documentId, async () => {
        const document = useDocumentStore.getState().documentsById[documentId]
        if (!document || !editorSessions.has(documentId)) return
        const materialized = editorSessions.materialize(documentId)
        useDocumentStore
          .getState()
          .setMaterializedContent(
            documentId,
            materialized.content,
            materialized.byteLength,
          )
        const metrics = editorSessions.getMetrics(documentId)
        await documentApi.updateRecoveryDocument({
          documentId,
          content: materialized.content,
          dirty: document.dirty,
          viewMode: document.viewMode,
          cursor: metrics.cursor,
          scrollTop: metrics.scrollTop,
        })
      }),
    [tasks],
  )

  const scheduleRecoveryDocument = useCallback(
    (documentId: string, delay = RECOVERY_DEBOUNCE_MS) => {
      if (closingRef.current) return
      const previous = recoveryTimersRef.current.get(documentId)
      if (previous !== undefined) window.clearTimeout(previous)
      const first = recoveryFirstAtRef.current.get(documentId) ?? Date.now()
      recoveryFirstAtRef.current.set(documentId, first)
      const boundedDelay = recoveryDelay(first, Date.now(), delay)
      const timer = window.setTimeout(() => {
        recoveryFirstAtRef.current.delete(documentId)
        recoveryTimersRef.current.delete(documentId)
        void trackRecovery(persistRecoveryDocument(documentId)).catch(
          (error) => {
            reportError(error)
            scheduleRecoveryDocument(documentId)
          },
        )
      }, boundedDelay)
      recoveryTimersRef.current.set(documentId, timer)
    },
    [closingRef, persistRecoveryDocument, trackRecovery, reportError],
  )

  const pauseRecovery = useCallback(() => {
    closingRef.current = true
    recoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    recoveryTimersRef.current.clear()
    recoveryFirstAtRef.current.clear()
  }, [closingRef])

  const flushRecovery = useCallback(async () => {
    await tasks.drain()
    await Promise.allSettled([...recoveryInFlightRef.current])
    for (const id of useDocumentStore.getState().documentOrder) {
      await persistRecoveryDocument(id)
    }
    const state = useDocumentStore.getState()
    await documentApi.updateRecoveryLayout({
      documentIds: state.documentOrder,
      activeId: state.activeId,
    })
  }, [persistRecoveryDocument, tasks])

  useEffect(() => {
    if (!hydrated) return
    const timeout = window.setTimeout(() => {
      if (closingRef.current) return
      void trackRecovery(
        documentApi.updateRecoveryLayout({
          documentIds: documentOrder,
          activeId,
        }),
      ).catch((error) => {
        console.error('Failed to persist recovery layout', error)
      })
    }, LAYOUT_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [activeId, closingRef, documentOrder, hydrated, trackRecovery])

  useEffect(() => () => pauseRecovery(), [pauseRecovery])

  return {
    persistRecoveryDocument,
    scheduleRecoveryDocument,
    pauseRecovery,
    flushRecovery,
  }
}

export type DocumentRecovery = ReturnType<typeof useDocumentRecovery>
