import { useCallback, useState } from 'react'
import { asDocumentError, documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { useDocumentStore } from '../stores/documentStore'
import { useEditorStatusStore } from '../stores/editorStatusStore'
import type { DocumentRuntime } from './useDocumentRuntime'
import type { DocumentRecovery } from './useDocumentRecovery'
import type { DocumentActions } from './useDocumentActions'
import type { DocumentPreview } from './useDocumentPreview'

export interface PendingClose {
  documentIds: string[]
  window: boolean
}

export interface PendingDestructive {
  kind: 'reload' | 'overwrite'
  documentId: string
}

export function useDocumentClose(
  { tasks, processingRef, closingRef, exitPromptRef }: DocumentRuntime,
  { scheduleRecoveryDocument, pauseRecovery, flushRecovery }: DocumentRecovery,
  { createDocument, performSave, reloadFromDisk }: DocumentActions,
  clearManualPreview: DocumentPreview['clearManualPreview'],
  reportError: (error: unknown) => void,
) {
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [pendingDestructive, setPendingDestructive] =
    useState<PendingDestructive | null>(null)
  const [processing, setProcessing] = useState(false)

  const resumeEditing = useCallback(async () => {
    closingRef.current = false
    processingRef.current = false
    setProcessing(false)
    exitPromptRef.current = false
    setPendingClose(null)
    try {
      await documentApi.cancelExit()
    } catch (error) {
      reportError(error)
    }
    useDocumentStore
      .getState()
      .documentOrder.forEach((id) => scheduleRecoveryDocument(id))
  }, [
    closingRef,
    exitPromptRef,
    processingRef,
    reportError,
    scheduleRecoveryDocument,
  ])

  const finishWindowClose = useCallback(async () => {
    processingRef.current = true
    setProcessing(true)
    try {
      pauseRecovery()
      await flushRecovery()
      await documentApi.completeExit()
    } catch (error) {
      await resumeEditing()
      reportError(error)
    }
  }, [flushRecovery, pauseRecovery, processingRef, reportError, resumeEditing])

  const closeDocumentsPermanently = useCallback(
    async (documentIds: string[], createReplacement = true) => {
      for (const documentId of documentIds) {
        if (!useDocumentStore.getState().documentsById[documentId]) continue
        try {
          await tasks.run(documentId, () =>
            documentApi.closeDocument(documentId),
          )
        } catch (error) {
          if (asDocumentError(error).code !== 'NOT_FOUND') {
            reportError(error)
            return false
          }
        }
        useDocumentStore.getState().closeLocal(documentId)
        editorSessions.remove(documentId)
        useEditorStatusStore.getState().remove(documentId)
        clearManualPreview(documentId)
      }
      if (
        createReplacement &&
        useDocumentStore.getState().documentOrder.length === 0
      ) {
        await createDocument('text')
      }
      return true
    },
    [clearManualPreview, createDocument, reportError, tasks],
  )

  const requestCloseMany = useCallback(
    (documentIds: string[], windowClose = false) => {
      if (processingRef.current) return
      if (windowClose) {
        if (exitPromptRef.current) return
        exitPromptRef.current = true
      }
      const state = useDocumentStore.getState()
      const existingIds = documentIds.filter((id) => state.documentsById[id])
      if (existingIds.length === 0) {
        if (windowClose) void finishWindowClose()
        return
      }
      const dirty = existingIds.some((id) => state.documentsById[id].dirty)
      if (dirty) {
        setPendingClose({ documentIds: existingIds, window: windowClose })
      } else if (windowClose) {
        void finishWindowClose()
      } else {
        void closeDocumentsPermanently(existingIds)
      }
    },
    [
      closeDocumentsPermanently,
      exitPromptRef,
      finishWindowClose,
      processingRef,
    ],
  )

  const requestTabClose = useCallback(
    (documentId: string) => requestCloseMany([documentId]),
    [requestCloseMany],
  )

  const requestReload = useCallback(
    (documentId: string) => {
      const document = useDocumentStore.getState().documentsById[documentId]
      if (!document) return
      if (document.dirty) {
        setPendingDestructive({ kind: 'reload', documentId })
      } else {
        void reloadFromDisk(documentId, false)
      }
    },
    [reloadFromDisk],
  )

  const handlePendingSave = async () => {
    const pending = pendingClose
    if (!pending || processingRef.current) return
    processingRef.current = true
    setProcessing(true)
    await tasks.drain()
    for (const documentId of pending.window
      ? useDocumentStore.getState().documentOrder
      : pending.documentIds) {
      const document = useDocumentStore.getState().documentsById[documentId]
      if (document?.dirty && !(await performSave(documentId))) {
        await resumeEditing()
        return
      }
    }
    setPendingClose(null)
    if (pending.window) await finishWindowClose()
    else {
      await closeDocumentsPermanently(pending.documentIds)
      await resumeEditing()
      if (useDocumentStore.getState().documentOrder.length === 0)
        await createDocument('text')
    }
  }

  const handlePendingDiscard = async () => {
    const pending = pendingClose
    if (!pending || processingRef.current) return
    setPendingClose(null)
    if (pending.window) await finishWindowClose()
    else await closeDocumentsPermanently(pending.documentIds)
  }

  const executeDestructive = async () => {
    if (processingRef.current || exitPromptRef.current) return
    const pending = pendingDestructive
    if (!pending) return
    setPendingDestructive(null)
    if (pending.kind === 'reload') {
      await reloadFromDisk(pending.documentId, true)
    } else {
      await performSave(pending.documentId, 'force')
    }
  }

  const cancelPendingClose = useCallback(() => {
    if (!processingRef.current) void resumeEditing()
  }, [processingRef, resumeEditing])

  const cancelDestructive = useCallback(() => setPendingDestructive(null), [])
  const requestOverwrite = useCallback((documentId: string) => {
    setPendingDestructive({ kind: 'overwrite', documentId })
  }, [])

  return {
    pendingClose,
    pendingDestructive,
    processing,
    requestCloseMany,
    requestTabClose,
    requestReload,
    requestOverwrite,
    handlePendingSave,
    handlePendingDiscard,
    executeDestructive,
    cancelPendingClose,
    cancelDestructive,
  }
}

export type DocumentClose = ReturnType<typeof useDocumentClose>
