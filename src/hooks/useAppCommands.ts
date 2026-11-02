import { useCallback, useEffect, useRef } from 'react'
import { editorSessions } from '../lib/editorSessions'
import { useDocumentStore } from '../stores/documentStore'
import type { AppCommand, ViewMode } from '../types'
import type { DocumentRuntime } from './useDocumentRuntime'
import type { DocumentActions } from './useDocumentActions'
import type { DocumentClose } from './useDocumentClose'
import type { DocumentPreview } from './useDocumentPreview'

const VIEW_MODE_SHORTCUTS: Partial<Record<string, ViewMode>> = {
  Digit1: 'source',
  Digit2: 'split',
  Digit3: 'preview',
}

export function useAppCommands(
  { processingRef, exitPromptRef }: DocumentRuntime,
  { createDocument, openDocuments, performSave }: DocumentActions,
  requestTabClose: DocumentClose['requestTabClose'],
  setViewMode: DocumentPreview['setViewMode'],
  toggleSettings: () => void,
) {
  const handlers: Record<AppCommand, () => void> = {
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
    settings: () => toggleSettings(),
  }

  const callbacksRef = useRef({
    handlers,
    createDocument,
    openDocuments,
    performSave,
    requestTabClose,
    setViewMode,
    toggleSettings,
  })
  callbacksRef.current = {
    handlers,
    createDocument,
    openDocuments,
    performSave,
    requestTabClose,
    setViewMode,
    toggleSettings,
  }
  const dispatchCommand = useCallback((command: AppCommand) => {
    callbacksRef.current.handlers[command]?.()
  }, [])

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
          callbacksRef.current.setViewMode(mode)
        }
        return
      }
      // WebKitGTK reports Shift+Tab as key="Unidentified", code="Tab".
      if (event.code === 'Tab' || event.key === 'Tab') {
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
        callbacksRef.current.toggleSettings()
      } else if (key === 'n') {
        event.preventDefault()
        void callbacksRef.current.createDocument(
          event.shiftKey ? 'markdown' : 'text',
        )
      } else if (key === 'o') {
        event.preventDefault()
        void callbacksRef.current.openDocuments()
      } else if (key === 's') {
        event.preventDefault()
        const id = useDocumentStore.getState().activeId
        if (id)
          void callbacksRef.current.performSave(
            id,
            event.shiftKey ? 'saveAs' : 'save',
          )
      } else if (key === 'w') {
        event.preventDefault()
        const id = useDocumentStore.getState().activeId
        if (id) callbacksRef.current.requestTabClose(id)
      } else if (key === 'm' && event.shiftKey) {
        event.preventDefault()
        const state = useDocumentStore.getState()
        const document = state.activeId
          ? state.documentsById[state.activeId]
          : null
        if (document?.kind === 'markdown') {
          callbacksRef.current.setViewMode(
            document.viewMode === 'source' ? 'preview' : 'source',
          )
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [processingRef, exitPromptRef])

  return dispatchCommand
}
