import { useEffect, useRef, useState } from 'react'
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
  generation: number
}

interface CloseRequest extends PendingClose {
  // Lifecycle changes on unmount; epoch changes only when window exit takes over.
  lifecycle: number
  epoch: number
  phase: 'waiting' | 'prompt' | 'saving' | 'committing'
}

type DiscardVersions = Map<string, number | undefined>

function documentVersion(documentId: string) {
  return editorSessions.has(documentId)
    ? editorSessions.getMetrics(documentId).version
    : undefined
}

function needsConfirmation(documentId: string, versions?: DiscardVersions) {
  const document = useDocumentStore.getState().documentsById[documentId]
  if (!document) return false
  return versions
    ? !versions.has(documentId) ||
        versions.get(documentId) !== documentVersion(documentId)
    : document.dirty
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
  const [closingDocumentIds, setClosingDocumentIds] = useState<string[]>([])
  const mounted = useRef(true)
  const lifecycle = useRef(0)
  const epoch = useRef(0)
  const sequence = useRef(0)
  const tabs = useRef(new Map<number, CloseRequest>())
  const owners = useRef(new Map<string, CloseRequest>())
  const prompts = useRef<CloseRequest[]>([])
  const windowRequest = useRef<CloseRequest | null>(null)
  const committed = useRef(new Set<Promise<void>>())
  const locks = useRef(new Map<string, () => void>())
  const replacing = useRef(false)

  const isLive = (request: CloseRequest) =>
    mounted.current && request.lifecycle === lifecycle.current
  const isCurrent = (request: CloseRequest) =>
    isLive(request) &&
    (request.window
      ? windowRequest.current === request
      : request.epoch === epoch.current &&
        tabs.current.get(request.generation) === request)

  // Independent tab requests own their documents; only window exit supersedes them.
  function publish() {
    if (!mounted.current) return
    const window = windowRequest.current
    prompts.current = prompts.current.filter(
      (request) =>
        isCurrent(request) &&
        (request.phase === 'prompt' || request.phase === 'saving'),
    )
    const prompt = window
      ? window.phase === 'prompt' || window.phase === 'saving'
        ? window
        : null
      : prompts.current[0]
    const busy = window
      ? window.phase !== 'prompt'
      : [...tabs.current.values()].some((request) => request.phase === 'saving')
    processingRef.current = busy
    exitPromptRef.current = window !== null
    setProcessing(busy)
    setPendingClose(
      prompt
        ? {
            documentIds: [...prompt.documentIds],
            window: prompt.window,
            generation: prompt.generation,
          }
        : null,
    )
    setClosingDocumentIds([...locks.current.keys()])
  }

  function confirm(request: CloseRequest, documentIds = request.documentIds) {
    if (!isCurrent(request)) return
    request.documentIds = documentIds
    request.phase = 'prompt'
    if (!prompts.current.includes(request)) prompts.current.push(request)
    const paused = closingRef.current
    closingRef.current = false
    publish()
    if (paused)
      useDocumentStore
        .getState()
        .documentOrder.forEach((id) => scheduleRecoveryDocument(id))
  }

  function finishTab(request: CloseRequest) {
    if (!isCurrent(request)) return
    tabs.current.delete(request.generation)
    for (const [id, owner] of owners.current) {
      if (owner === request) owners.current.delete(id)
    }
    publish()
  }

  async function finishWindow(request: CloseRequest, cancel: boolean) {
    if (!isCurrent(request)) return
    windowRequest.current = null
    closingRef.current = false
    publish()
    if (cancel) {
      try {
        await documentApi.cancelExit()
      } catch (error) {
        if (isLive(request)) reportError(error)
      }
      if (
        isLive(request) &&
        request.epoch === epoch.current &&
        !windowRequest.current
      ) {
        useDocumentStore
          .getState()
          .documentOrder.forEach((id) => scheduleRecoveryDocument(id))
      }
    }
  }

  async function ensureReplacement(request: CloseRequest) {
    if (
      !isLive(request) ||
      windowRequest.current ||
      replacing.current ||
      useDocumentStore.getState().documentOrder.length
    )
      return
    replacing.current = true
    try {
      await createDocument('text')
    } finally {
      replacing.current = false
    }
  }

  async function closeTabs(request: CloseRequest, versions?: DiscardVersions) {
    if (!isCurrent(request)) return
    request.phase = 'waiting'
    publish()
    for (const [index, id] of request.documentIds.entries()) {
      if (!isCurrent(request)) return
      if (!useDocumentStore.getState().documentsById[id]) continue
      try {
        const closed = await tasks.run(id, async () => {
          if (!isCurrent(request)) return false
          if (needsConfirmation(id, versions)) {
            confirm(request, request.documentIds.slice(index))
            return false
          }
          // No event can edit this document between the final check and IPC.
          const unlock = editorSessions.lockEditing(id)
          locks.current.set(id, unlock)
          request.phase = 'committing'
          publish()
          const commit = (async () => {
            try {
              try {
                await documentApi.closeDocument(id)
              } catch (error) {
                if (asDocumentError(error).code !== 'NOT_FOUND') throw error
              }
              // A committed close settles before any cancellable window prompt.
              // Unmounted instances must never delete a replacement instance's state.
              if (!isLive(request)) return
              useDocumentStore.getState().closeLocal(id)
              editorSessions.remove(id)
              useEditorStatusStore.getState().remove(id)
              clearManualPreview(id)
            } finally {
              unlock()
              if (locks.current.get(id) === unlock) locks.current.delete(id)
              if (isLive(request)) publish()
            }
          })()
          committed.current.add(commit)
          try {
            await commit
          } finally {
            committed.current.delete(commit)
          }
          return true
        })
        if (!closed || !isCurrent(request)) return
        owners.current.delete(id)
        request.phase = 'waiting'
      } catch (error) {
        if (isLive(request)) reportError(error)
        finishTab(request)
        return
      }
    }
    finishTab(request)
    await ensureReplacement(request)
  }

  async function closeWindow(
    request: CloseRequest,
    versions?: DiscardVersions,
  ) {
    if (!isCurrent(request)) return
    request.phase = 'committing'
    publish()
    try {
      pauseRecovery()
      await flushRecovery()
      if (!isCurrent(request)) return
      const ids = useDocumentStore.getState().documentOrder
      if (ids.some((id) => needsConfirmation(id, versions))) {
        confirm(request, ids)
        return
      }
      await documentApi.completeExit()
      await finishWindow(request, false)
    } catch (error) {
      await finishWindow(request, true)
      if (isLive(request)) reportError(error)
    }
  }

  function prepareWindow(request: CloseRequest) {
    if (!isCurrent(request)) return
    const ids = useDocumentStore.getState().documentOrder
    request.documentIds = [...ids]
    if (ids.some((id) => needsConfirmation(id))) confirm(request)
    else void closeWindow(request)
  }

  const requestCloseMany = (documentIds: string[], windowClose = false) => {
    if (!mounted.current || windowRequest.current) return
    if (windowClose) {
      epoch.current += 1
      tabs.current.clear()
      owners.current.clear()
      prompts.current = []
    }
    const state = useDocumentStore.getState()
    const ids = [
      ...new Set(windowClose ? state.documentOrder : documentIds),
    ].filter(
      (id) =>
        state.documentsById[id] && (windowClose || !owners.current.has(id)),
    )
    if (!windowClose && !ids.length) return
    const request: CloseRequest = {
      documentIds: ids,
      window: windowClose,
      generation: ++sequence.current,
      lifecycle: lifecycle.current,
      epoch: epoch.current,
      phase: 'waiting',
    }
    if (windowClose) {
      windowRequest.current = request
      if (committed.current.size) {
        // Native close is irreversible once dispatched. Present window Cancel
        // only after those commits have reconciled local state and unlocked.
        publish()
        void Promise.allSettled([...committed.current]).then(() =>
          prepareWindow(request),
        )
      } else prepareWindow(request)
    } else {
      tabs.current.set(request.generation, request)
      ids.forEach((id) => owners.current.set(id, request))
      if (ids.some((id) => needsConfirmation(id))) confirm(request)
      else void closeTabs(request)
    }
  }

  const requestTabClose = (documentId: string) => requestCloseMany([documentId])

  function selectedRequest() {
    const request = pendingClose?.window
      ? windowRequest.current
      : pendingClose
        ? tabs.current.get(pendingClose.generation)
        : null
    return request &&
      isCurrent(request) &&
      request.generation === pendingClose?.generation &&
      request.phase === 'prompt'
      ? request
      : null
  }

  const handlePendingSave = async () => {
    const request = selectedRequest()
    if (!request || processingRef.current) return
    request.phase = 'saving'
    publish()
    try {
      await tasks.drain()
      if (!isCurrent(request)) return
      for (const id of request.window
        ? useDocumentStore.getState().documentOrder
        : request.documentIds) {
        if (
          useDocumentStore.getState().documentsById[id]?.dirty &&
          !(await performSave(id))
        ) {
          if (request.window) await finishWindow(request, true)
          else finishTab(request)
          return
        }
        if (!isCurrent(request)) return
      }
      if (request.window) await closeWindow(request)
      else await closeTabs(request)
    } catch (error) {
      if (request.window) await finishWindow(request, true)
      else finishTab(request)
      if (isLive(request)) reportError(error)
    }
  }

  const handlePendingDiscard = async () => {
    const request = selectedRequest()
    if (!request || processingRef.current) return
    const ids = request.window
      ? useDocumentStore.getState().documentOrder
      : request.documentIds
    const versions = new Map(ids.map((id) => [id, documentVersion(id)]))
    if (request.window) await closeWindow(request, versions)
    else await closeTabs(request, versions)
  }

  const cancelPendingClose = () => {
    const request = selectedRequest()
    if (!request || processingRef.current) return
    if (request.window) void finishWindow(request, true)
    else finishTab(request)
  }

  useEffect(() => {
    mounted.current = true
    const tabRequests = tabs.current
    const documentOwners = owners.current
    const editLocks = locks.current
    const nativeCommits = committed.current
    return () => {
      mounted.current = false
      lifecycle.current += 1
      epoch.current += 1
      const cancelExit = windowRequest.current !== null || exitPromptRef.current
      windowRequest.current = null
      tabRequests.clear()
      documentOwners.clear()
      prompts.current = []
      editLocks.forEach((unlock) => unlock())
      editLocks.clear()
      nativeCommits.clear()
      processingRef.current = false
      closingRef.current = false
      exitPromptRef.current = false
      if (cancelExit) void documentApi.cancelExit().catch(() => undefined)
    }
  }, [closingRef, exitPromptRef, processingRef])

  const requestReload = (id: string) => {
    if (editorSessions.isEditingLocked(id)) return
    const document = useDocumentStore.getState().documentsById[id]
    if (!document) return
    if (document.dirty)
      setPendingDestructive({ kind: 'reload', documentId: id })
    else void reloadFromDisk(id, false)
  }

  const executeDestructive = async () => {
    if (processingRef.current || exitPromptRef.current) return
    const pending = pendingDestructive
    if (!pending || editorSessions.isEditingLocked(pending.documentId)) return
    setPendingDestructive(null)
    if (pending.kind === 'reload')
      await reloadFromDisk(pending.documentId, true)
    else await performSave(pending.documentId, 'force')
  }

  return {
    pendingClose,
    pendingDestructive,
    processing,
    closingDocumentIds,
    requestCloseMany,
    requestTabClose,
    requestReload,
    requestOverwrite: (documentId: string) =>
      setPendingDestructive({ kind: 'overwrite', documentId }),
    handlePendingSave,
    handlePendingDiscard,
    executeDestructive,
    cancelPendingClose,
    cancelDestructive: () => setPendingDestructive(null),
  }
}

export type DocumentClose = ReturnType<typeof useDocumentClose>
