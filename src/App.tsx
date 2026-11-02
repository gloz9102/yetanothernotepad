import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTranslation } from 'react-i18next'
import { CodeEditor } from './components/CodeEditor'
import { ConfirmDialog, ErrorDialog, UnsavedDialog } from './components/Dialogs'
import { ExternalChangeBanner } from './components/ExternalChangeBanner'
import { MarkdownPreview } from './components/MarkdownPreview'
import { SettingsPanel } from './components/SettingsPanel'
import { StatusBar, type SaveStatus } from './components/StatusBar'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import i18n from './i18n'
import { asDocumentError, documentApi } from './lib/api'
import { editorSessions } from './lib/editorSessions'
import { DocumentTasks } from './lib/documentTasks'
import { useDocumentStore } from './stores/documentStore'
import { useEditorStatusStore } from './stores/editorStatusStore'
import { useSettingsStore } from './stores/settingsStore'
import type {
  AppCommand,
  DocumentKind,
  DocumentSnapshot,
  DocumentTab,
  ExternalChange,
  LineRange,
  RestoredDocument,
  SaveDocumentRequest,
  ViewMode,
} from './types'
import './styles.css'

const PREVIEW_SOFT_BYTES = 512 * 1024
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_DEBOUNCE_MS = 200
const RECOVERY_DEBOUNCE_MS = 1_000
const LAYOUT_DEBOUNCE_MS = 250
const VIEW_MODE_SHORTCUTS: Partial<Record<string, ViewMode>> = {
  Digit1: 'source',
  Digit2: 'split',
  Digit3: 'preview',
}

interface PendingClose {
  documentIds: string[]
  window: boolean
}

interface PendingDestructive {
  kind: 'reload' | 'overwrite'
  documentId: string
}

function seedSnapshot(snapshot: DocumentSnapshot) {
  if (!editorSessions.has(snapshot.id)) editorSessions.seed(snapshot)
}

function seedRestored(restored: RestoredDocument) {
  editorSessions.seed(restored.document, {
    dirty: restored.dirty,
    cursor: restored.cursor,
    scrollTop: restored.scrollTop,
    viewMode: restored.viewMode,
  })
}

export default function App() {
  const { t } = useTranslation()
  const documentOrder = useDocumentStore((state) => state.documentOrder)
  const documentsById = useDocumentStore((state) => state.documentsById)
  const activeId = useDocumentStore((state) => state.activeId)
  const hydrated = useDocumentStore((state) => state.hydrated)
  const theme = useSettingsStore((state) => state.theme)
  const localePreference = useSettingsStore((state) => state.locale)
  const wordWrap = useSettingsStore((state) => state.wordWrap)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const persistedSplitRatio = useSettingsStore((state) => state.splitRatio)
  const setPersistedSplitRatio = useSettingsStore(
    (state) => state.setSplitRatio,
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [pendingDestructive, setPendingDestructive] =
    useState<PendingDestructive | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [manualPreviews, setManualPreviews] = useState<Record<string, string>>(
    {},
  )
  const [dropActive, setDropActive] = useState(false)
  const [splitRatio, setSplitRatio] = useState(persistedSplitRatio)

  const initializingRef = useRef(false)
  const tasksRef = useRef(new DocumentTasks())
  const recoveryFirstAtRef = useRef(new Map<string, number>())
  const processingRef = useRef(false)
  const [processing, setProcessing] = useState(false)
  const exitPromptRef = useRef(false)
  const closingRef = useRef(false)
  const recoveryTimersRef = useRef(new Map<string, number>())
  const previewTimersRef = useRef(new Map<string, number>())
  const recoveryInFlightRef = useRef(new Set<Promise<unknown>>())
  const saveStatusTimerRef = useRef<number | null>(null)
  const previewPaneRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const scrollSyncRef = useRef(false)
  const activeDocumentRef = useRef<DocumentTab | null>(null)
  const handlersRef = useRef<Record<AppCommand, () => void> | null>(null)

  const documents = useMemo(
    () => documentOrder.map((id) => documentsById[id]).filter(Boolean),
    [documentOrder, documentsById],
  )
  const activeDocument = activeId ? (documentsById[activeId] ?? null) : null
  activeDocumentRef.current = activeDocument

  const previewTooLarge = (activeDocument?.byteLength ?? 0) > PREVIEW_MAX_BYTES
  const previewNeedsManual =
    (activeDocument?.byteLength ?? 0) > PREVIEW_SOFT_BYTES && !previewTooLarge
  // Line linking needs a preview rendered from the live content.
  const linkSourceLines =
    activeDocument?.viewMode === 'split' && !previewNeedsManual
  const menuHasDocument = Boolean(activeDocument)
  const menuMarkdown = activeDocument?.kind === 'markdown'
  const menuViewMode = activeDocument?.viewMode ?? 'source'

  const resolvedLocale: 'ko' | 'en' =
    localePreference === 'system'
      ? navigator.language.toLowerCase().startsWith('ko')
        ? 'ko'
        : 'en'
      : localePreference

  const reportError = useCallback((error: unknown) => {
    setErrorMessage(asDocumentError(error).message)
  }, [])

  const trackRecovery = useCallback((promise: Promise<unknown>) => {
    const tracked = promise.finally(() =>
      recoveryInFlightRef.current.delete(tracked),
    )
    recoveryInFlightRef.current.add(tracked)
    return tracked
  }, [])

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

  const integrateSnapshots = useCallback((snapshots: DocumentSnapshot[]) => {
    snapshots.forEach(seedSnapshot)
    useDocumentStore.getState().addSnapshots(snapshots)
  }, [])

  const persistRecoveryDocument = useCallback(
    (documentId: string) =>
      tasksRef.current.run(documentId, async () => {
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
    [],
  )

  const scheduleRecoveryDocument = useCallback(
    (documentId: string, delay = RECOVERY_DEBOUNCE_MS) => {
      if (closingRef.current) return
      const previous = recoveryTimersRef.current.get(documentId)
      if (previous !== undefined) window.clearTimeout(previous)
      const first = recoveryFirstAtRef.current.get(documentId) ?? Date.now()
      recoveryFirstAtRef.current.set(documentId, first)
      const boundedDelay = Math.min(
        delay,
        Math.max(0, 5_000 - (Date.now() - first)),
      )
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
    [persistRecoveryDocument, trackRecovery, reportError],
  )

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

  const createDocument = useCallback(
    async (kind: DocumentKind) => {
      if (processingRef.current) return
      try {
        const document = await tasksRef.current.run('workspace', () =>
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
    [integrateSnapshots, reportError],
  )

  const openDocuments = useCallback(async () => {
    if (processingRef.current) return
    try {
      integrateSnapshots(
        await tasksRef.current.run('workspace', () =>
          documentApi.openDocuments(),
        ),
      )
    } catch (error) {
      reportError(error)
    }
  }, [integrateSnapshots, reportError])

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
        if (saved.warnings?.length) setErrorMessage(saved.warnings.join('\n'))
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
    [scheduleRecoveryDocument, showTransientSaveStatus, t],
  )

  const performSave = useCallback(
    (id: string, mode: 'save' | 'saveAs' | 'force' = 'save') =>
      tasksRef.current.run(id, () => saveNow(id, mode)),
    [saveNow],
  )

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
  }, [reportError, scheduleRecoveryDocument])

  const finishWindowClose = useCallback(async () => {
    processingRef.current = true
    setProcessing(true)
    try {
      closingRef.current = true
      recoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      recoveryTimersRef.current.clear()
      recoveryFirstAtRef.current.clear()
      await tasksRef.current.drain()
      await Promise.allSettled([...recoveryInFlightRef.current])
      for (const id of useDocumentStore.getState().documentOrder) {
        await persistRecoveryDocument(id)
      }
      const state = useDocumentStore.getState()
      await documentApi.updateRecoveryLayout({
        documentIds: state.documentOrder,
        activeId: state.activeId,
      })
      await documentApi.completeExit()
    } catch (error) {
      await resumeEditing()
      reportError(error)
    }
  }, [persistRecoveryDocument, reportError, resumeEditing])

  const closeDocumentsPermanently = useCallback(
    async (documentIds: string[], createReplacement = true) => {
      for (const documentId of documentIds) {
        if (!useDocumentStore.getState().documentsById[documentId]) continue
        try {
          await tasksRef.current.run(documentId, () =>
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
        setManualPreviews((current) => {
          const next = { ...current }
          delete next[documentId]
          return next
        })
      }
      if (
        createReplacement &&
        useDocumentStore.getState().documentOrder.length === 0
      ) {
        await createDocument('text')
      }
      return true
    },
    [createDocument, reportError],
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
    [closeDocumentsPermanently, finishWindowClose],
  )

  const requestTabClose = useCallback(
    (documentId: string) => requestCloseMany([documentId]),
    [requestCloseMany],
  )

  const reloadFromDisk = useCallback(
    async (documentId: string, preserveUndo: boolean) => {
      try {
        if (preserveUndo) await persistRecoveryDocument(documentId)
        const requestedVersion = editorSessions.getMetrics(documentId).version
        const reloaded = await tasksRef.current.run(documentId, () =>
          documentApi.reloadDocument(documentId),
        )
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
    [persistRecoveryDocument, reportError, scheduleRecoveryDocument],
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
          setManualPreviews((current) => {
            const next = { ...current }
            delete next[document.id]
            return next
          })
        }
      }
      useDocumentStore.getState().setViewMode(document.id, mode)
      if (mode === 'split' || mode === 'preview') {
        editorSessions.setLastMarkdownViewMode(document.id, mode)
      }
      scheduleRecoveryDocument(document.id)
    },
    [scheduleRecoveryDocument, t],
  )

  const changeDocumentKind = useCallback(
    async (kind: DocumentKind) => {
      const state = useDocumentStore.getState()
      const documentId = state.activeId
      const document = documentId ? state.documentsById[documentId] : null
      if (!document || document.path !== null || document.kind === kind) return

      try {
        const materialized = editorSessions.materialize(document.id)
        const update = await tasksRef.current.run(document.id, () =>
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
          setManualPreviews((current) => {
            const next = { ...current }
            delete next[document.id]
            return next
          })
        }
        scheduleRecoveryDocument(document.id, 0)
      } catch (error) {
        reportError(error)
      }
    },
    [reportError, scheduleRecoveryDocument],
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
    const document = activeDocumentRef.current
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
  }, [activeId, linkSourceLines])

  const adjustSplitRatio = useCallback(
    (next: number) => {
      const resolved = Math.min(75, Math.max(25, next))
      setSplitRatio(resolved)
      setPersistedSplitRatio(resolved)
    },
    [setPersistedSplitRatio],
  )

  const handlePendingSave = async () => {
    const pending = pendingClose
    if (!pending || processingRef.current) return
    processingRef.current = true
    setProcessing(true)
    await tasksRef.current.drain()
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

  useEffect(() => {
    if (initializingRef.current) return
    initializingRef.current = true
    void documentApi
      .restoreSession()
      .then(async (session) => {
        session.documents.forEach(seedRestored)
        useDocumentStore.getState().hydrate(session.documents, session.activeId)
        if (session.documents.length === 0) await createDocument('text')
      })
      .catch(async (error) => {
        reportError(error)
        useDocumentStore.getState().hydrate([], null)
        await createDocument('text')
      })
  }, [createDocument, reportError])

  useEffect(() => {
    if (!hydrated) return
    const disposers: Array<() => void> = []
    void listen<DocumentSnapshot[]>('documents-opened', (event) => {
      integrateSnapshots(event.payload)
    }).then((dispose) => disposers.push(dispose))
    void listen('documents-open-failed', (event) => {
      reportError(event.payload)
    }).then((dispose) => disposers.push(dispose))
    void listen<ExternalChange>('document-external-change', (event) => {
      const change = event.payload
      const document =
        useDocumentStore.getState().documentsById[change.documentId]
      if (!document) return
      if (
        !processingRef.current &&
        !document.dirty &&
        change.kind === 'modified'
      ) {
        void reloadFromDisk(document.id, false)
      } else {
        useDocumentStore.getState().setExternalChange(document.id, change.kind)
      }
    }).then((dispose) => disposers.push(dispose))
    void listen<AppCommand>('app-command', (event) => {
      if (!processingRef.current && !exitPromptRef.current)
        handlersRef.current?.[event.payload]?.()
    }).then((dispose) => disposers.push(dispose))
    return () => disposers.forEach((dispose) => dispose())
  }, [hydrated, integrateSnapshots, reloadFromDisk, reportError])

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
  }, [activeId, documentOrder, hydrated, trackRecovery])

  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const request = () =>
      requestCloseMany(useDocumentStore.getState().documentOrder, true)
    void listen('exit-requested', request)
      .then(async (dispose) => {
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        if (await documentApi.exitPending()) request()
      })
      .catch(reportError)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [hydrated, requestCloseMany, reportError])

  useEffect(() => {
    let disposed = false
    let dispose: (() => void) | undefined
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        // Only file drags carry paths; dragged text must not show the file overlay.
        if (event.payload.type === 'enter') {
          setDropActive(event.payload.paths.length > 0)
        } else if (event.payload.type !== 'over') {
          setDropActive(false)
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch(reportError)
    return () => {
      disposed = true
      dispose?.()
    }
  }, [reportError])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const resolved =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [theme])

  useEffect(() => {
    void i18n.changeLanguage(resolvedLocale)
    document.documentElement.lang = resolvedLocale
  }, [resolvedLocale])

  useEffect(() => {
    document.title = activeDocument
      ? `${activeDocument.dirty ? '● ' : ''}${activeDocument.displayName} — ${t('appName')}`
      : t('appName')
  }, [activeDocument, t])

  useEffect(() => {
    void documentApi
      .updateMenuContext({
        locale: resolvedLocale,
        hasDocument: menuHasDocument,
        markdown: menuMarkdown,
        viewMode: menuViewMode,
      })
      .catch((error) => console.error('Failed to update native menu', error))
  }, [menuHasDocument, menuMarkdown, menuViewMode, resolvedLocale])

  useEffect(() => {
    setSplitRatio(persistedSplitRatio)
  }, [persistedSplitRatio])

  useEffect(() => {
    const activateRelative = (offset: number) => {
      const state = useDocumentStore.getState()
      if (state.documentOrder.length === 0) return
      const current = Math.max(
        0,
        state.documentOrder.indexOf(state.activeId ?? ''),
      )
      const next =
        (current + offset + state.documentOrder.length) %
        state.documentOrder.length
      state.setActive(state.documentOrder[next])
    }

    handlersRef.current = {
      'new-text': () => void createDocument('text'),
      'new-markdown': () => void createDocument('markdown'),
      open: () => void openDocuments(),
      save: () => {
        const id = useDocumentStore.getState().activeId
        if (id) void performSave(id)
      },
      'save-as': () => {
        const id = useDocumentStore.getState().activeId
        if (id) void performSave(id, 'saveAs')
      },
      close: () => {
        const id = useDocumentStore.getState().activeId
        if (id) requestTabClose(id)
      },
      undo: () => void editorSessions.run('undo'),
      redo: () => void editorSessions.run('redo'),
      find: () => void editorSessions.run('find'),
      replace: () => void editorSessions.run('replace'),
      'view-source': () => setViewMode('source'),
      'view-split': () => setViewMode('split'),
      'view-preview': () => setViewMode('preview'),
      settings: () => setSettingsOpen((open) => !open),
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        processingRef.current ||
        (exitPromptRef.current && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault()
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.altKey) {
        // Option changes event.key on macOS, so match the physical digit key.
        const mode = VIEW_MODE_SHORTCUTS[event.code]
        if (mode && !event.shiftKey) {
          event.preventDefault()
          setViewMode(mode)
        }
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        activateRelative(event.shiftKey ? -1 : 1)
        return
      }
      // macOS reserves Cmd+Tab, so also accept Cmd+Shift+] / [ like browsers.
      if (
        event.metaKey &&
        event.shiftKey &&
        (event.code === 'BracketRight' || event.code === 'BracketLeft')
      ) {
        event.preventDefault()
        activateRelative(event.code === 'BracketRight' ? 1 : -1)
        return
      }
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const state = useDocumentStore.getState()
        const id =
          state.documentOrder[Math.min(index, state.documentOrder.length - 1)]
        if (id) {
          event.preventDefault()
          state.setActive(id)
        }
        return
      }
      const key = event.key.toLowerCase()
      if (key === ',') {
        event.preventDefault()
        setSettingsOpen((open) => !open)
      } else if (key === 'n') {
        event.preventDefault()
        void createDocument(event.shiftKey ? 'markdown' : 'text')
      } else if (key === 'o') {
        event.preventDefault()
        void openDocuments()
      } else if (key === 's') {
        event.preventDefault()
        const id = useDocumentStore.getState().activeId
        if (id) void performSave(id, event.shiftKey ? 'saveAs' : 'save')
      } else if (key === 'w') {
        event.preventDefault()
        const id = useDocumentStore.getState().activeId
        if (id) requestTabClose(id)
      } else if (key === 'm' && event.shiftKey) {
        event.preventDefault()
        const document = activeDocumentRef.current
        if (document?.kind === 'markdown') {
          setViewMode(document.viewMode === 'source' ? 'preview' : 'source')
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [createDocument, openDocuments, performSave, requestTabClose, setViewMode])

  useEffect(
    () => () => {
      closingRef.current = true
      recoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      previewTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      if (saveStatusTimerRef.current !== null) {
        window.clearTimeout(saveStatusTimerRef.current)
      }
    },
    [],
  )

  if (!hydrated) {
    return <main className="loading-screen">{t('loading')}</main>
  }

  const previewContent = activeDocument
    ? previewNeedsManual
      ? manualPreviews[activeDocument.id]
      : activeDocument.content
    : undefined
  const workspaceStyle = {
    '--split-ratio': `${splitRatio}%`,
  } as CSSProperties
  const closeDocuments = pendingClose
    ? pendingClose.documentIds.map((id) => documentsById[id]).filter(Boolean)
    : []
  const singleCloseName =
    closeDocuments.length === 1 ? closeDocuments[0].displayName : undefined

  return (
    <main className="app-shell">
      <div
        className="interaction-content"
        inert={processing || Boolean(pendingClose?.window)}
      >
        <TabStrip
          documents={documents}
          activeId={activeId}
          onActivate={useDocumentStore.getState().setActive}
          onClose={requestTabClose}
          onCloseMany={requestCloseMany}
        />
        <Toolbar
          document={activeDocument}
          richViewDisabled={previewTooLarge}
          onNewText={() => void createDocument('text')}
          onOpen={() => void openDocuments()}
          onSave={() => activeDocument && void performSave(activeDocument.id)}
          onDocumentKind={(kind) => void changeDocumentKind(kind)}
          onViewMode={setViewMode}
        />

        {settingsOpen && (
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        )}

        {activeDocument?.externalChange && (
          <ExternalChangeBanner
            change={activeDocument.externalChange}
            onReload={() => requestReload(activeDocument.id)}
            onOverwrite={() =>
              setPendingDestructive({
                kind: 'overwrite',
                documentId: activeDocument.id,
              })
            }
            onSaveAs={() => void performSave(activeDocument.id, 'saveAs')}
          />
        )}

        <section
          className={`workspace mode-${activeDocument?.viewMode ?? 'source'}`}
          ref={workspaceRef}
          style={workspaceStyle}
          role="tabpanel"
          id={activeDocument ? `panel-${activeDocument.id}` : undefined}
          aria-labelledby={
            activeDocument ? `tab-${activeDocument.id}` : undefined
          }
        >
          {activeDocument && (
            <div
              className={`editor-pane ${activeDocument.viewMode === 'preview' ? 'pane-hidden' : ''}`}
            >
              <CodeEditor
                documentId={activeDocument.id}
                kind={activeDocument.kind}
                readOnly={
                  activeDocument.readOnly ||
                  processing ||
                  Boolean(pendingClose?.window)
                }
                wordWrap={wordWrap}
                fontSize={fontSize}
                hidden={activeDocument.viewMode === 'preview'}
                onDocumentChange={handleEditorChange}
                onSessionChange={scheduleRecoveryDocument}
                onScrollFractionChange={handleEditorScroll}
              />
            </div>
          )}

          {activeDocument?.kind === 'markdown' &&
            activeDocument.viewMode === 'split' && (
              <div
                className="split-separator"
                role="separator"
                aria-label={t('splitSeparator')}
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(splitRatio)}
                tabIndex={0}
                onPointerDown={handleSeparatorPointerDown}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    adjustSplitRatio(splitRatio - 5)
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    adjustSplitRatio(splitRatio + 5)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    adjustSplitRatio(25)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    adjustSplitRatio(75)
                  }
                }}
              />
            )}

          {activeDocument?.kind === 'markdown' &&
            activeDocument.viewMode !== 'source' && (
              <div
                className="preview-pane"
                ref={previewPaneRef}
                onScroll={handlePreviewScroll}
              >
                {previewTooLarge ? (
                  <div className="preview-empty">{t('previewUnavailable')}</div>
                ) : previewNeedsManual && previewContent === undefined ? (
                  <div className="preview-manual">
                    <p>{t('previewManual')}</p>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={refreshManualPreview}
                    >
                      {t('refreshPreview')}
                    </button>
                  </div>
                ) : (
                  <>
                    {previewNeedsManual && (
                      <div className="preview-refresh-bar">
                        <span>{t('previewManual')}</span>
                        <button type="button" onClick={refreshManualPreview}>
                          {t('refreshPreview')}
                        </button>
                      </div>
                    )}
                    <MarkdownPreview
                      documentId={activeDocument.id}
                      content={previewContent ?? ''}
                      onError={reportError}
                      onSourceLinesSelect={
                        linkSourceLines ? handleSourceLinesSelect : undefined
                      }
                    />
                  </>
                )}
              </div>
            )}
        </section>

        <StatusBar
          document={activeDocument}
          saveStatus={saveStatus}
          onUndoReload={() => {
            editorSessions.run('undo')
            setSaveStatus('idle')
          }}
        />

        {dropActive && <div className="drop-overlay">{t('dropFiles')}</div>}
      </div>
      {pendingClose && (
        <UnsavedDialog
          count={closeDocuments.filter((document) => document.dirty).length}
          documentName={singleCloseName}
          onSave={() => void handlePendingSave()}
          onDiscard={() => void handlePendingDiscard()}
          onCancel={() => {
            if (!processingRef.current) void resumeEditing()
          }}
        />
      )}
      {pendingDestructive && (
        <ConfirmDialog
          title={
            pendingDestructive.kind === 'reload'
              ? t('reloadConfirmTitle')
              : t('overwriteConfirmTitle')
          }
          message={
            pendingDestructive.kind === 'reload'
              ? t('reloadConfirmMessage')
              : t('overwriteConfirmMessage')
          }
          confirmLabel={
            pendingDestructive.kind === 'reload' ? t('reload') : t('overwrite')
          }
          danger
          onConfirm={() => void executeDestructive()}
          onCancel={() => setPendingDestructive(null)}
        />
      )}
      {errorMessage && (
        <ErrorDialog
          message={errorMessage}
          onClose={() => setErrorMessage(null)}
        />
      )}
    </main>
  )
}
