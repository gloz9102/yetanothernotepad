import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import i18n from './i18n'
import App from './App'
import { useDocumentStore } from './stores/documentStore'
import { editorSessions } from './lib/editorSessions'
import type { DocumentSnapshot } from './types'

const { listeners, dragDrop, api } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  dragDrop: {
    handler: undefined as
      | ((event: { payload: { type: string; paths?: string[] } }) => void)
      | undefined,
  },
  api: {
    restoreSession: vi.fn(),
    updateRecoveryDocument: vi.fn(),
    updateRecoveryLayout: vi.fn(),
    updateMenuContext: vi.fn(),
    cancelExit: vi.fn(),
    completeExit: vi.fn(),
    exitPending: vi.fn(),
    saveDocument: vi.fn(),
    saveDocumentAs: vi.fn(),
    newDocument: vi.fn(),
    closeDocument: vi.fn(),
  },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, callback) => {
    listeners.set(name, callback)
    return () => {
      if (listeners.get(name) === callback) listeners.delete(name)
    }
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async (handler: typeof dragDrop.handler) => {
      dragDrop.handler = handler
      return () => {}
    },
  }),
}))
vi.mock('./lib/api', async (original) => ({
  ...(await original<typeof import('./lib/api')>()),
  documentApi: api,
}))
vi.mock('./components/CodeEditor', () => ({
  CodeEditor: ({
    documentId,
    readOnly,
    onDocumentChange,
  }: {
    documentId: string
    readOnly: boolean
    onDocumentChange: (id: string, dirty: boolean) => void
  }) => (
    <textarea
      aria-label="test editor"
      readOnly={readOnly}
      onChange={(event) => {
        editorSessions.replaceContent(documentId, event.target.value, {
          preserveUndo: false,
        })
        onDocumentChange(documentId, true)
      }}
    />
  ),
}))

const snapshot: DocumentSnapshot = {
  id: 'test-note',
  path: '/test/note.txt',
  displayName: 'note.txt',
  kind: 'text',
  content: 'draft',
  encoding: 'utf8',
  lineEnding: 'lf',
  revision: 'old',
  readOnly: false,
  normalizationWarning: false,
}
async function mount(dirty = true, document = snapshot) {
  api.restoreSession.mockResolvedValue({
    documents: [
      {
        document,
        dirty,
        viewMode: 'source',
        cursor: 0,
        scrollTop: 0,
        externalChange: false,
      },
    ],
    activeId: document.id,
  })
  render(<App />)
  await screen.findByLabelText('test editor')
  await waitFor(() => expect(listeners.has('exit-requested')).toBe(true))
}
function requestExit() {
  act(() => listeners.get('exit-requested')?.({ payload: null }))
}

beforeEach(() => {
  useDocumentStore.getState().reset()
  editorSessions.remove(snapshot.id)
  listeners.clear()
  for (const mock of Object.values(api))
    mock.mockReset().mockResolvedValue(undefined)
  api.exitPending.mockResolvedValue(false)
  api.saveDocument.mockImplementation(async (request) => ({
    ...snapshot,
    content: request.content,
    revision: 'new',
  }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('exit and recovery flow', () => {
  it('merges repeated exit requests and keeps editing when cancelled', async () => {
    await mount()
    requestExit()
    requestExit()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      }),
    )
    await waitFor(() => expect(api.cancelExit).toHaveBeenCalledOnce())
    expect(api.completeExit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('test editor')).not.toHaveAttribute('readonly')
  })
  it('does not exit when the save dialog is cancelled', async () => {
    api.saveDocument.mockResolvedValue(null)
    await mount()
    requestExit()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }),
    )
    await waitFor(() => expect(api.cancelExit).toHaveBeenCalled())
    expect(api.completeExit).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().documentsById[snapshot.id].dirty).toBe(
      true,
    )
  })
  it('keeps unsaved text when saving fails', async () => {
    api.saveDocument.mockRejectedValue({
      code: 'PERMISSION_DENIED',
      message: 'Read only',
    })
    await mount()
    requestExit()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }),
    )
    await waitFor(() => expect(api.cancelExit).toHaveBeenCalled())
    expect(api.completeExit).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().documentsById[snapshot.id].dirty).toBe(
      true,
    )
  })
  it('aborts exit when the final recovery flush fails', async () => {
    api.updateRecoveryDocument.mockRejectedValue(
      new Error('Recovery disk full'),
    )
    await mount()
    requestExit()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Discard',
      }),
    )
    await waitFor(() => expect(api.cancelExit).toHaveBeenCalled())
    expect(api.completeExit).not.toHaveBeenCalled()
  })
  it('waits for save and flushes recovery before exit approval', async () => {
    let finish!: (value: DocumentSnapshot) => void
    api.saveDocument.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await mount()
    requestExit()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }),
    )
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalled())
    expect(screen.getByLabelText('test editor')).toHaveAttribute('readonly')
    expect(api.completeExit).not.toHaveBeenCalled()
    await act(async () => finish({ ...snapshot, revision: 'new' }))
    await waitFor(() => expect(api.completeExit).toHaveBeenCalledOnce())
    expect(
      api.updateRecoveryDocument.mock.invocationCallOrder.at(-1)!,
    ).toBeLessThan(api.completeExit.mock.invocationCallOrder[0])
  })
  it('retains dirty state and resumes editing if moving recovery to Trash fails', async () => {
    api.completeExit.mockRejectedValue(new Error('Trash unavailable'))
    await mount()
    requestExit()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Discard',
      }),
    )
    await waitFor(() => expect(api.cancelExit).toHaveBeenCalled())
    expect(await screen.findByText('Trash unavailable')).toBeVisible()
    expect(useDocumentStore.getState().documentsById[snapshot.id].dirty).toBe(
      true,
    )
  })
  it('checkpoints continuous typing within five seconds', async () => {
    await mount(false)
    vi.useFakeTimers()
    for (let index = 0; index < 12; index++) {
      fireEvent.change(screen.getByLabelText('test editor'), {
        target: { value: `typing ${index}` },
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
    }
    expect(api.updateRecoveryDocument).toHaveBeenCalled()
    expect(api.updateRecoveryDocument.mock.calls[0][0].content).toContain(
      'typing',
    )
  })
})

describe('file drop', () => {
  it('shows the drop overlay only for dragged files', async () => {
    await mount(false)
    const overlay = () => screen.queryByText(/Drop text or Markdown files/)

    act(() => dragDrop.handler?.({ payload: { type: 'enter', paths: [] } }))
    act(() => dragDrop.handler?.({ payload: { type: 'over' } }))
    expect(overlay()).toBeNull()

    act(() =>
      dragDrop.handler?.({
        payload: { type: 'enter', paths: ['/test/readme.md'] },
      }),
    )
    act(() => dragDrop.handler?.({ payload: { type: 'over' } }))
    expect(overlay()).not.toBeNull()

    act(() => dragDrop.handler?.({ payload: { type: 'leave' } }))
    expect(overlay()).toBeNull()
  })

  it('reports files that could not be opened', async () => {
    await mount(false)
    await waitFor(() =>
      expect(listeners.has('documents-open-failed')).toBe(true),
    )
    act(() =>
      listeners.get('documents-open-failed')?.({
        payload: {
          code: 'BINARY_FILE',
          message: 'The selected file appears to be binary.',
        },
      }),
    )
    expect(
      await screen.findByText('The selected file appears to be binary.'),
    ).not.toBeNull()
  })
})

describe('view mode shortcuts', () => {
  const viewMode = () =>
    useDocumentStore.getState().documentsById[snapshot.id]?.viewMode
  const press = (code: string, options: KeyboardEventInit = {}) =>
    act(() => {
      fireEvent.keyDown(window, { code, ctrlKey: true, ...options })
    })

  it('switches markdown documents with Ctrl+Alt+1/2/3', async () => {
    await mount(false, {
      ...snapshot,
      path: '/test/note.md',
      displayName: 'note.md',
      kind: 'markdown',
    })

    press('Digit2', { altKey: true, key: '™' })
    expect(viewMode()).toBe('split')
    press('Digit3', { altKey: true, key: '£' })
    expect(viewMode()).toBe('preview')
    press('Digit1', { altKey: true, key: '¡' })
    expect(viewMode()).toBe('source')
    press('Digit2', { altKey: true, shiftKey: true })
    expect(viewMode()).toBe('source')
  })

  it('keeps text documents in source mode', async () => {
    await mount(false)
    press('Digit3', { altKey: true })
    expect(viewMode()).toBe('source')
  })
})

describe('tab shortcuts', () => {
  it('cycles tabs with Ctrl+Tab and Cmd+Shift+] / [', async () => {
    const second = { ...snapshot, id: 'second', displayName: 'second.txt' }
    api.restoreSession.mockResolvedValue({
      documents: [snapshot, second].map((document) => ({
        document,
        dirty: false,
        viewMode: 'source',
        cursor: 0,
        scrollTop: 0,
        externalChange: false,
      })),
      activeId: snapshot.id,
    })
    render(<App />)
    await screen.findByLabelText('test editor')
    const activeId = () => useDocumentStore.getState().activeId
    const press = (init: KeyboardEventInit) =>
      act(() => {
        fireEvent.keyDown(window, init)
      })

    press({ code: 'BracketRight', key: '}', metaKey: true, shiftKey: true })
    expect(activeId()).toBe('second')
    press({ code: 'BracketLeft', key: '{', metaKey: true, shiftKey: true })
    expect(activeId()).toBe(snapshot.id)
    press({ code: 'Tab', key: 'Tab', ctrlKey: true })
    expect(activeId()).toBe('second')
    press({ code: 'BracketLeft', key: '{', ctrlKey: true, shiftKey: true })
    expect(activeId()).toBe('second')
  })
})

describe('native listener lifecycle', () => {
  it('keeps native registrations stable across edits and language changes', async () => {
    await mount(false)
    const registered = vi.mocked(listen).mock.calls.length
    fireEvent.change(screen.getByLabelText('test editor'), {
      target: { value: 'edited' },
    })
    await act(async () => {
      await i18n.changeLanguage('ko')
    })
    expect(listen).toHaveBeenCalledTimes(registered)
  })

  it('dispatches current command handlers after the language changes', async () => {
    await mount(false, { ...snapshot, normalizationWarning: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      await act(async () => {
        await i18n.changeLanguage('ko')
      })
      act(() => listeners.get('app-command')?.({ payload: 'save' }))
      await waitFor(() => expect(api.saveDocument).toHaveBeenCalledOnce())
      expect(confirm).toHaveBeenCalledWith(i18n.t('mixedLineWarning'))
    } finally {
      confirm.mockRestore()
    }
  })

  it('disposes native registrations that finish after unmount', async () => {
    let finish!: (dispose: () => void) => void
    const dispose = vi.fn()
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await mount(false)
    cleanup()
    await act(async () => {
      finish(dispose)
    })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
