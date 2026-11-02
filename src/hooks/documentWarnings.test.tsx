import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { useDocumentMessages } from '../lib/documentWarnings'
import { asDocumentError, documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { useDocumentStore } from '../stores/documentStore'
import type { DocumentSnapshot } from '../types'
import { useDocumentActions } from './useDocumentActions'
import { useDocumentRecovery } from './useDocumentRecovery'
import { useDocumentRuntime } from './useDocumentRuntime'
import { useWorkspaceEvents } from './useWorkspaceEvents'

vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  documentApi: {
    openDocuments: vi.fn(),
    saveDocument: vi.fn(),
    reloadDocument: vi.fn(),
    restoreSession: vi.fn(),
    updateRecoveryDocument: vi.fn(),
    updateRecoveryLayout: vi.fn(),
    exitPending: vi.fn(),
  },
}))
const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, callback) => {
    listeners.set(name, callback)
    return () => {
      listeners.delete(name)
    }
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: vi.fn(async () => vi.fn()) }),
}))

const document: DocumentSnapshot = {
  id: 'note',
  path: '/notes/note.txt',
  displayName: 'note.txt',
  kind: 'text',
  content: 'base',
  revision: 'r0',
  encoding: 'utf8',
  lineEnding: 'none',
  readOnly: false,
  normalizationWarning: false,
}
const warning = 'File monitoring failed; retry pending.'

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  listeners.clear()
  useDocumentStore.getState().reset()
  editorSessions.reset()
  vi.mocked(documentApi.updateRecoveryDocument).mockResolvedValue(undefined)
  vi.mocked(documentApi.updateRecoveryLayout).mockResolvedValue(undefined)
  vi.mocked(documentApi.exitPending).mockResolvedValue(false)
})
afterEach(() => {
  cleanup()
  editorSessions.reset()
  vi.useRealTimers()
})

function mountActions() {
  editorSessions.seed(document)
  editorSessions.getInitialState(document.id, [])
  useDocumentStore.getState().addSnapshots([document])
  return renderHook(() => {
    const { errorMessage: message, setErrorMessage: setMessage } =
      useDocumentMessages()
    const runtime = useDocumentRuntime()
    const reportError = (error: unknown) =>
      setMessage(asDocumentError(error).message)
    const recovery = useDocumentRecovery(runtime, reportError)
    const actions = useDocumentActions(
      runtime,
      recovery,
      vi.fn(),
      reportError,
      setMessage,
    )
    return { actions, message }
  })
}

it.each(['open', 'event', 'save', 'reload'] as const)(
  'displays %s warnings through the existing message state without rejecting success',
  async (operation) => {
    const snapshot = {
      ...document,
      warnings: [warning, warning, 'Recovery delayed.'],
    }
    vi.mocked(documentApi.openDocuments).mockResolvedValue([snapshot])
    vi.mocked(documentApi.saveDocument).mockResolvedValue(snapshot)
    vi.mocked(documentApi.reloadDocument).mockResolvedValue(snapshot)
    const { result } = mountActions()
    await act(async () => {
      if (operation === 'open') await result.current.actions.openDocuments()
      if (operation === 'event')
        result.current.actions.integrateSnapshots([snapshot, snapshot])
      if (operation === 'save')
        expect(await result.current.actions.performSave(document.id)).toBe(true)
      if (operation === 'reload')
        await result.current.actions.reloadFromDisk(document.id, false)
    })
    expect(result.current.message).toBe(`${warning}\nRecovery delayed.`)
    expect(useDocumentStore.getState().documentsById[document.id].content).toBe(
      'base',
    )
  },
)

it('still displays warnings when typing causes a reload response to be rejected', async () => {
  let resolve!: (snapshot: DocumentSnapshot) => void
  vi.mocked(documentApi.reloadDocument).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const { result } = mountActions()
  let pending!: Promise<void>
  await act(async () => {
    pending = result.current.actions.reloadFromDisk(document.id, false)
    await Promise.resolve()
  })
  await act(async () => {
    editorSessions.replaceContent(document.id, 'new typing', {
      preserveUndo: true,
    })
    useDocumentStore.getState().setDirty(document.id, true)
    resolve({ ...document, content: 'disk', warnings: [warning] })
    await pending
  })
  expect(result.current.message).toBe(warning)
  expect(editorSessions.materialize(document.id).content).toBe('new typing')
})

it('displays restored warnings once while preserving the recovered session', async () => {
  vi.mocked(documentApi.restoreSession).mockResolvedValue({
    activeId: document.id,
    documents: [document, { ...document, id: 'second' }].map((snapshot) => ({
      document: { ...snapshot, warnings: [warning] },
      dirty: true,
      viewMode: 'source',
      cursor: 2,
      scrollTop: 3,
      externalChange: false,
    })),
  })
  const createDocument = vi.fn()
  const { result } = renderHook(() => {
    const { errorMessage: message, setErrorMessage: setMessage } =
      useDocumentMessages()
    const runtime = useDocumentRuntime()
    useWorkspaceEvents(runtime, {
      createDocument,
      integrateSnapshots: vi.fn(),
      reloadFromDisk: vi.fn(),
      requestCloseMany: vi.fn(),
      dispatchCommand: vi.fn(),
      reportError: (error) => setMessage(asDocumentError(error).message),
    })
    return message
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current).toBe(warning)
  expect(useDocumentStore.getState().documentOrder).toEqual([
    document.id,
    'second',
  ])
  expect(useDocumentStore.getState().documentsById[document.id].dirty).toBe(
    true,
  )
  expect(createDocument).not.toHaveBeenCalled()
})

it('a clean response does not erase an existing warning', async () => {
  const { result } = mountActions()
  act(() =>
    result.current.actions.integrateSnapshots([
      { ...document, warnings: [warning] },
    ]),
  )
  act(() => result.current.actions.integrateSnapshots([document]))
  expect(result.current.message).toBe(warning)
})

it.each([
  ['en', false],
  ['en', true],
  ['ko', false],
  ['ko', true],
] as const)(
  'merges partial-open errors and localized monitoring warnings (%s, error first: %s)',
  async (locale, errorFirst) => {
    await i18n.changeLanguage(locale)
    vi.mocked(documentApi.restoreSession).mockResolvedValue({
      activeId: document.id,
      documents: [
        {
          document,
          dirty: false,
          viewMode: 'source',
          cursor: 0,
          scrollTop: 0,
          externalChange: false,
        },
      ],
    })
    const { result } = renderHook(() => {
      const messages = useDocumentMessages()
      const reportError = (error: unknown) =>
        messages.setErrorMessage(asDocumentError(error).message)
      const runtime = useDocumentRuntime()
      const recovery = useDocumentRecovery(runtime, reportError)
      const actions = useDocumentActions(
        runtime,
        recovery,
        vi.fn(),
        reportError,
        messages.setErrorMessage,
      )
      useWorkspaceEvents(runtime, {
        createDocument: actions.createDocument,
        integrateSnapshots: actions.integrateSnapshots,
        reloadFromDisk: actions.reloadFromDisk,
        requestCloseMany: vi.fn(),
        dispatchCommand: vi.fn(),
        reportError,
      })
      return messages
    })
    await act(async () => {
      await Promise.resolve()
    })
    const opened = () =>
      listeners.get('documents-opened')!({
        payload: [
          {
            ...document,
            warnings: [
              { code: 'FILE_MONITORING_FAILED', details: 'watch details' },
              'legacy save warning',
            ],
          },
        ],
      })
    const failed = () =>
      listeners.get('documents-open-failed')!({
        payload: { code: 'NOT_FOUND', message: 'partial open failed' },
      })
    act(() => {
      if (errorFirst) {
        failed()
        opened()
      } else {
        opened()
        failed()
      }
      failed()
    })
    const lines = result.current.errorMessage!.split('\n')
    expect(lines).toContain(
      locale === 'ko'
        ? '파일 변경 감시를 사용할 수 없어 자동으로 재시도 중입니다.'
        : 'File change monitoring is unavailable. Retrying automatically.',
    )
    expect(lines).toContain('watch details')
    expect(lines).toContain('legacy save warning')
    expect(lines.filter((line) => line === 'partial open failed')).toHaveLength(
      1,
    )
    expect(useDocumentStore.getState().documentsById[document.id].content).toBe(
      'base',
    )
    act(() => result.current.dismissError())
    expect(result.current.errorMessage).toBeNull()
  },
)
