import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n'
import { documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { useDocumentStore } from '../stores/documentStore'
import type { DocumentSnapshot } from '../types'
import { useDocumentRuntime } from './useDocumentRuntime'
import { useDocumentRecovery } from './useDocumentRecovery'
import { useDocumentActions } from './useDocumentActions'

vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  documentApi: {
    reloadDocument: vi.fn(),
    updateRecoveryDocument: vi.fn(),
    updateRecoveryLayout: vi.fn(),
  },
}))

const opened: DocumentSnapshot = {
  id: 'note',
  path: '/notes/note.txt',
  displayName: 'note.txt',
  kind: 'text',
  content: 'base',
  revision: 'old-revision',
  encoding: 'utf8',
  lineEnding: 'none',
  readOnly: false,
  normalizationWarning: false,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  useDocumentStore.getState().reset()
  editorSessions.reset()
  editorSessions.seed(opened)
  editorSessions.getInitialState(opened.id, [])
  useDocumentStore.getState().addSnapshots([opened])
  vi.mocked(documentApi.updateRecoveryDocument).mockResolvedValue(undefined)
  vi.mocked(documentApi.updateRecoveryLayout).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  editorSessions.reset()
  vi.useRealTimers()
})

it.each([false, true])(
  'checkpoints the editor baseline after reload (typed during reload: %s)',
  async (typeDuringReload) => {
    let resolveReload!: (snapshot: DocumentSnapshot) => void
    vi.mocked(documentApi.reloadDocument).mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve
      }),
    )
    const reportError = vi.fn()
    const { result } = renderHook(() => {
      const runtime = useDocumentRuntime()
      const recovery = useDocumentRecovery(runtime, reportError)
      return useDocumentActions(
        runtime,
        recovery,
        vi.fn(),
        reportError,
        vi.fn(),
      )
    })
    let reload!: Promise<void>
    await act(async () => {
      reload = result.current.reloadFromDisk(opened.id, false)
      await Promise.resolve()
    })
    expect(documentApi.reloadDocument).toHaveBeenCalledWith(opened.id)
    if (typeDuringReload) {
      act(() => {
        editorSessions.replaceContent(opened.id, 'typed on old base', {
          preserveUndo: true,
        })
        useDocumentStore.getState().setDirty(opened.id, true)
      })
    }
    await act(async () => {
      resolveReload({
        ...opened,
        content: 'external edit',
        revision: 'new-revision',
      })
      await reload
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentId: opened.id,
        content: typeDuringReload ? 'typed on old base' : 'external edit',
        baseRevision: typeDuringReload ? 'old-revision' : 'new-revision',
        dirty: typeDuringReload,
      }),
    )
    expect(reportError).not.toHaveBeenCalled()
  },
)
