import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { showDocumentWarnings } from '../lib/documentWarnings'
import { useDocumentStore } from '../stores/documentStore'
import type {
  AppCommand,
  DocumentSnapshot,
  ExternalChange,
  RestoredDocument,
} from '../types'
import type { DocumentRuntime } from './useDocumentRuntime'
import type { DocumentActions } from './useDocumentActions'
import type { DocumentClose } from './useDocumentClose'

function seedRestored(restored: RestoredDocument) {
  editorSessions.seed(restored.document, {
    dirty: restored.dirty,
    cursor: restored.cursor,
    scrollTop: restored.scrollTop,
    viewMode: restored.viewMode,
  })
}

interface WorkspaceEventHandlers {
  createDocument: DocumentActions['createDocument']
  integrateSnapshots: DocumentActions['integrateSnapshots']
  reloadFromDisk: DocumentActions['reloadFromDisk']
  requestCloseMany: DocumentClose['requestCloseMany']
  dispatchCommand: (command: AppCommand) => void
  reportError: (error: unknown) => void
}

export function useWorkspaceEvents(
  { processingRef, exitPromptRef }: DocumentRuntime,
  handlers: WorkspaceEventHandlers,
) {
  const hydrated = useDocumentStore((state) => state.hydrated)
  const [dropActive, setDropActive] = useState(false)
  const initializingRef = useRef(false)
  const callbacksRef = useRef(handlers)
  callbacksRef.current = handlers

  useEffect(() => {
    if (initializingRef.current) return
    initializingRef.current = true
    void documentApi
      .restoreSession()
      .then(async (session) => {
        session.documents.forEach(seedRestored)
        useDocumentStore.getState().hydrate(session.documents, session.activeId)
        showDocumentWarnings(
          session.documents.map((restored) => restored.document),
          callbacksRef.current.reportError,
        )
        if (session.documents.length === 0)
          await callbacksRef.current.createDocument('text')
      })
      .catch(async (error) => {
        callbacksRef.current.reportError(error)
        useDocumentStore.getState().hydrate([], null)
        await callbacksRef.current.createDocument('text')
      })
  }, [])

  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    const disposers: Array<() => void> = []
    const register = (dispose: () => void) => {
      if (disposed) dispose()
      else disposers.push(dispose)
    }
    void listen<DocumentSnapshot[]>('documents-opened', (event) => {
      callbacksRef.current.integrateSnapshots(event.payload)
    }).then(register)
    void listen('documents-open-failed', (event) => {
      callbacksRef.current.reportError(event.payload)
    }).then(register)
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
        void callbacksRef.current.reloadFromDisk(document.id, false)
      } else {
        useDocumentStore.getState().setExternalChange(document.id, change.kind)
      }
    }).then(register)
    void listen<AppCommand>('app-command', (event) => {
      if (!processingRef.current && !exitPromptRef.current)
        callbacksRef.current.dispatchCommand(event.payload)
    }).then(register)
    return () => {
      disposed = true
      disposers.forEach((dispose) => dispose())
    }
  }, [hydrated, processingRef, exitPromptRef])

  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const request = () =>
      callbacksRef.current.requestCloseMany(
        useDocumentStore.getState().documentOrder,
        true,
      )
    void listen('exit-requested', request)
      .then(async (dispose) => {
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        if (await documentApi.exitPending()) request()
      })
      .catch((error) => callbacksRef.current.reportError(error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [hydrated])

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
      .catch((error) => callbacksRef.current.reportError(error))
    return () => {
      disposed = true
      dispose?.()
    }
  }, [])

  return dropActive
}
