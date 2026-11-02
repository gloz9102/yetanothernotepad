import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SaveStatus } from '../components/StatusBar'
import { asDocumentError, documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { showDocumentWarnings } from '../lib/documentWarnings'
import { PREVIEW_MAX_BYTES, PREVIEW_SOFT_BYTES } from '../lib/documentPolicy'
import { useDocumentStore } from '../stores/documentStore'
import type {
  DocumentKind,
  DocumentSnapshot,
  SaveDocumentRequest,
  ViewMode,
} from '../types'
import type { DocumentRuntime } from './useDocumentRuntime'
import type { DocumentRecovery } from './useDocumentRecovery'
import type { DocumentPreview } from './useDocumentPreview'

function seedSnapshot(snapshot: DocumentSnapshot) {
  if (!editorSessions.has(snapshot.id)) editorSessions.seed(snapshot)
}

export function useDocumentActions(
  { tasks, processingRef }: DocumentRuntime,
  { persistRecoveryDocument, scheduleRecoveryDocument }: DocumentRecovery,
  clearManualPreview: DocumentPreview['clearManualPreview'],
  reportError: (error: unknown) => void,
  setErrorMessage: (message: string) => void,
) {
  const { t } = useTranslation()
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const saveStatusTimerRef = useRef<number | null>(null)

  const showTransientSaveStatus = useCallback((status: SaveStatus) => {
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current)
    }
    setSaveStatus(status)
    if (status === 'saved') {
      saveStatusTimerRef.current = window.setTimeout(
        () => setSaveStatus('idle'),
        2_000,
      )
    }
  }, [])

  const integrateSnapshots = useCallback(
    (snapshots: DocumentSnapshot[]) => {
      snapshots.forEach(seedSnapshot)
      useDocumentStore.getState().addSnapshots(snapshots)
      showDocumentWarnings(snapshots, setErrorMessage)
    },
    [setErrorMessage],
  )

  const createDocument = useCallback(
    async (kind: DocumentKind) => {
      if (processingRef.current) return
      try {
        const document = await tasks.run('workspace', () =>
          documentApi.newDocument(kind),
        )
        integrateSnapshots([document])
        if (kind === 'markdown') {
          useDocumentStore.getState().setViewMode(document.id, 'split')
          editorSessions.setLastMarkdownViewMode(document.id, 'split')
        }
      } catch (error) {
        reportError(error)
      }
    },
    [integrateSnapshots, processingRef, reportError, tasks],
  )

  const openDocuments = useCallback(async () => {
    if (processingRef.current) return
    try {
      integrateSnapshots(
        await tasks.run('workspace', () => documentApi.openDocuments()),
      )
    } catch (error) {
      reportError(error)
    }
  }, [integrateSnapshots, processingRef, reportError, tasks])

  const saveNow = useCallback(
    async (
      documentId: string,
      mode: 'save' | 'saveAs' | 'force' = 'save',
    ): Promise<boolean> => {
      const document = useDocumentStore.getState().documentsById[documentId]
      if (!document) return false

      if (
        document.normalizationWarning &&
        !window.confirm(t('mixedLineWarning'))
      ) {
        return false
      }

      const materialized = editorSessions.materialize(documentId)
      const request: SaveDocumentRequest = {
        documentId,
        content: materialized.content,
        expectedRevision: document.revision,
      }
      setSaveStatus('saving')
      try {
        const saved =
          mode === 'saveAs' || (mode === 'save' && document.readOnly)
            ? await documentApi.saveDocumentAs(request)
            : mode === 'force'
              ? await documentApi.forceSaveDocument(request)
              : await documentApi.saveDocument(request)
        if (!saved) {
          setSaveStatus('idle')
          return false
        }
        editorSessions.setKind(documentId, saved.kind)
        const editedDuringSave = editorSessions.markSaved(
          documentId,
          saved.content,
        )
        useDocumentStore.getState().applySavedSnapshot(saved)
        if (editedDuringSave) {
          const current = editorSessions.materialize(documentId)
          useDocumentStore
            .getState()
            .setMaterializedContent(
              documentId,
              current.content,
              current.byteLength,
            )
          useDocumentStore.getState().setDirty(documentId, true)
        }
        scheduleRecoveryDocument(documentId, 0)
        if (editedDuringSave) setSaveStatus('idle')
        else showTransientSaveStatus('saved')
        showDocumentWarnings([saved], setErrorMessage)
        return !editedDuringSave
      } catch (error) {
        const documentError = asDocumentError(error)
        if (documentError.code === 'EXTERNAL_CONFLICT') {
          useDocumentStore.getState().setExternalChange(documentId, 'modified')
        } else {
          setErrorMessage(documentError.message)
        }
        setSaveStatus('error')
        return false
      }
    },
    [scheduleRecoveryDocument, setErrorMessage, showTransientSaveStatus, t],
  )

  const performSave = useCallback(
    (id: string, mode: 'save' | 'saveAs' | 'force' = 'save') =>
      tasks.run(id, () => saveNow(id, mode)),
    [saveNow, tasks],
  )

  const reloadFromDisk = useCallback(
    async (documentId: string, preserveUndo: boolean) => {
      try {
        if (preserveUndo) await persistRecoveryDocument(documentId)
        const requestedVersion = editorSessions.getMetrics(documentId).version
        const reloaded = await tasks.run(documentId, () =>
          documentApi.reloadDocument(documentId),
        )
        showDocumentWarnings([reloaded], setErrorMessage)
        if (
          editorSessions.getMetrics(documentId).version !== requestedVersion
        ) {
          useDocumentStore.getState().setExternalChange(documentId, 'modified')
          scheduleRecoveryDocument(documentId, 0)
          return
        }
        editorSessions.replaceContent(documentId, reloaded.content, {
          preserveUndo,
        })
        editorSessions.setKind(documentId, reloaded.kind)
        useDocumentStore.getState().applyReloadedSnapshot(reloaded)
        scheduleRecoveryDocument(documentId, 0)
        if (preserveUndo) setSaveStatus('reloaded')
      } catch (error) {
        reportError(error)
      }
    },
    [
      persistRecoveryDocument,
      reportError,
      scheduleRecoveryDocument,
      setErrorMessage,
      tasks,
    ],
  )

  const changeDocumentKind = useCallback(
    async (kind: DocumentKind) => {
      const state = useDocumentStore.getState()
      const documentId = state.activeId
      const document = documentId ? state.documentsById[documentId] : null
      if (!document || document.path !== null || document.kind === kind) return

      try {
        const materialized = editorSessions.materialize(document.id)
        const update = await tasks.run(document.id, () =>
          documentApi.setDocumentKind(document.id, kind),
        )
        let nextViewMode: ViewMode = 'source'
        if (
          kind === 'markdown' &&
          materialized.byteLength <= PREVIEW_MAX_BYTES
        ) {
          nextViewMode = editorSessions.getLastMarkdownViewMode(document.id)
        }
        if (
          document.kind === 'markdown' &&
          (document.viewMode === 'split' || document.viewMode === 'preview')
        ) {
          editorSessions.setLastMarkdownViewMode(document.id, document.viewMode)
        }
        editorSessions.setKind(document.id, kind)
        useDocumentStore
          .getState()
          .setMaterializedContent(
            document.id,
            materialized.content,
            materialized.byteLength,
          )
        useDocumentStore
          .getState()
          .applyKindUpdate(update, kind === 'text' ? 'source' : nextViewMode)
        if (materialized.byteLength > PREVIEW_SOFT_BYTES) {
          clearManualPreview(document.id)
        }
        scheduleRecoveryDocument(document.id, 0)
      } catch (error) {
        reportError(error)
      }
    },
    [clearManualPreview, reportError, scheduleRecoveryDocument, tasks],
  )

  const undoReload = useCallback(() => {
    editorSessions.run('undo')
    setSaveStatus('idle')
  }, [])

  useEffect(
    () => () => {
      if (saveStatusTimerRef.current !== null)
        window.clearTimeout(saveStatusTimerRef.current)
    },
    [],
  )

  return {
    createDocument,
    openDocuments,
    integrateSnapshots,
    performSave,
    reloadFromDisk,
    changeDocumentKind,
    saveStatus,
    undoReload,
  }
}

export type DocumentActions = ReturnType<typeof useDocumentActions>
