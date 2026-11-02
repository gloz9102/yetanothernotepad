/**
 * SAVE / RECOVERY AUDIT — 8c517a8 compared with e7bda77 (2026-11-02)
 *
 * Scope: tests only; no production fixes or commits. SAFE below means the
 * specified service or mocked-IPC behavior is tested, not native GUI E2E.
 * Recovery is ONE atomically replaced session.json, not per-document files.
 *
 * | Scenario | Verdict / evidence | Existing / refactor regression |
 * | --- | --- | --- |
 * | Two saves, same document/revision | SAFE: Rust concurrent_saves (threads + mutex); one success, one EXTERNAL_CONFLICT | — |
 * | save / saveAs / force queue; next expectedRevision | SAFE: parameterized frontend serializes tests; second request uses r1 | — |
 * | Save waits for in-flight recovery | SAFE: waits for an in-flight recovery write | — |
 * | Typing during save | SAFE: newer text remains dirty; checkpoint uses newer text; next save uses returned revision | — |
 * | Save As targets another open tab | SAFE: save_as_rejects, including force=true | — |
 * | Own save vs later external write | SAFE: own_save_is_suppressed; subsequent real change detected; ordinary save rejected, force succeeds | — |
 * | External write between revision check and atomic rename | UNTESTABLE-here: no deterministic scheduling seam; service.rs:182-216 has a TOCTOU interval; mutex does not lock external processes | — |
 * | OS watcher event delivery/debounce during native save | UNTESTABLE-here: tests cover revision filtering, not notify/Tauri event delivery | — |
 * | Reload updates content/revision and clears checkpoint | SAFE: reload_clears_recovery_payload_and_refreshes_revision | — |
 * | Typing during reload, before restart | SAFE: frontend preserves editor content/old revision and marks external conflict | — |
 * | Typing during reload, then crash/restore | BUG B1: conflict baseline lost; ignored Rust repro fails | Existing (static comparison) |
 * | set_document_kind on unsaved draft | SAFE: kind_change_preserves_unsaved_checkpoint_content | — |
 * | Dirty tab discard waits for pending save | SAFE: closes a tab only after its pending save; later timers cannot resurrect it | — |
 * | Clean tab close waits for save, then receives typing | BUG B2: silently closes newly dirty tab; skipped frontend repro fails | Existing (old App E2E-style mocked-IPC repro also fails) |
 * | Exit while save pending | SAFE: drains save, cancels timers, flushes documents/layout, then completeExit | — |
 * | Older layout IPC pending at exit | SAFE: waits for older layout before final flush layout | — |
 * | Recovery creation/update timing | SAFE: actual hook fake timers prove 1s debounce / 5s maximum under continuous typing | — |
 * | Recovery write failure/retry | SAFE: retries failed recovery with latest editor text | — |
 * | Save/Save As/close/discard recovery lifetime | SAFE: save_as_moves_recovery_identity_and_close_removes_the_draft; payload cleared on save, ID retained on Save As, close removes draft | — |
 * | Concurrent document/layout checkpoint writes | SAFE: recovery_and_layout_writers_share_one_consistent_session (threads, final order/content, no sidecars) | — |
 * | Stale layout excludes newly created document | BUG B3: later document checkpoints omit it; ignored Rust repro fails | Existing (identical function body) |
 * | Close fails to persist session | BUG B4: document already removed from memory; retry/save unavailable; ignored Rust repro fails | Existing (identical function body) |
 * | Deleted dirty / never-saved documents after crash | SAFE: deleted_dirty_and_never_saved survive; deleted clean tab is skipped; ordinary save of deleted dirty file conflicts | — |
 * | Stale dirty checkpoint vs newer disk | SAFE normally: dirty_restore_flags_newer_disk_and_rejects_stale_save; disk untouched | — |
 * | Clean checkpoint vs newer disk | SAFE: clean_restore_reads_newer_disk; restored revision matches disk | — |
 * | Trash failure at exit | SAFE at mocked IPC boundary: rejection cancels exit, retains dirty text, resumes checkpoints | — |
 * | Actual native Trash recycle / OS failure injection | UNTESTABLE-here: no Tauri AppHandle/Trash injection seam; complete_exit commands.rs:217 propagates discard failure before approving exit | — |
 * | Save succeeds but recovery write fails | SAFE: existing saved_revision_survives_recovery_failure checks warning + next revision | — |
 *
 * BUG roots and suggested fixes (not implemented):
 * B1 service.rs:430-446 updates recovery content but carries no editor baseline
 * revision. reload_document already replaced the record with the disk revision;
 * useDocumentActions.ts:164-169 rejects that response after typing, preserving
 * the frontend's OLD revision. A checkpoint then inherits the backend's NEW
 * revision, so restart loses the conflict and can permit overwriting disk.
 * Fix: carry/validate the editor's base revision in RecoveryDocumentUpdate,
 * or separate the recovery baseline from the backend's loaded disk revision.
 * Old: document/mod.rs:440,556 and App.tsx:467-478; same relevant behavior.
 *
 * B2 useDocumentClose.ts:111 checks dirty before tasks.run at :73; the close
 * callback never checks again and the editor stays writable during the wait.
 * Fix: gate editing while closing or recheck dirty/version inside the queued
 * close operation, distinguishing explicit discard from a formerly clean tab.
 * Old: App.tsx:405,446. Applied an App-level test to e7bda77: clean save pending,
 * close button, editable textarea, type, resolve save => closeDocument called.
 * Both historical and current repros fail the expected no-close assertion.
 *
 * B3 service.rs:453 replaces document_order with unversioned incoming IDs;
 * :469 persists only those IDs. Layout IPC bypasses DocumentTasks and its
 * spawn_blocking lock acquisition can run after a newer workspace mutation.
 * Fix: preserve every open document independently of layout order, reject stale
 * layout generations, and serialize workspace/layout changes.
 * Old: document/mod.rs:572; normalized function body identical.
 *
 * B4 service.rs:361 removes the document before write_recovery at :367 can
 * fail. Frontend retains its tab on the error but backend now returns NOT_FOUND.
 * Fix: persist candidate state before committing removal, or roll back on error.
 * Old: document/mod.rs:485; normalized function body identical.
 *
 * Verification:
 * cargo fmt --check PASS; cargo clippy --all-targets --all-features -- -D warnings PASS.
 * cargo test --all-features PASS: 33 passed, 3 ignored (new Rust: 10 pass + 3 BUG).
 * Explicit --ignored run: all 3 BUG tests FAIL at the intended assertions.
 * pnpm lint / typecheck / format:check PASS.
 * pnpm test PASS: 79 passed, 1 skipped (new frontend: 12 pass + 1 BUG).
 * Temporarily enabled frontend BUG: FAIL at unexpected closeDocument call;
 * restored it.skip afterward. Historical App repro likewise FAILS.
 * Node is 22.23.3 (package requests 24.x); pnpm reports an engine warning.
 * Historical /tmp/yan-pre worktree was removed after testing/comparison.
 *
 * Added Rust tests: lifecycle_tests in src-tauri/src/document/service.rs:
 * concurrent_saves_with_the_same_revision_have_only_one_winner;
 * save_as_rejects_another_tabs_path_even_when_forced;
 * save_as_moves_recovery_identity_and_close_removes_the_draft;
 * reload_clears_recovery_payload_and_refreshes_revision;
 * kind_change_preserves_unsaved_checkpoint_content;
 * own_save_is_suppressed_but_following_external_write_is_reported;
 * dirty_restore_flags_newer_disk_and_rejects_stale_save;
 * clean_restore_reads_newer_disk_instead_of_stale_session_metadata;
 * deleted_dirty_and_never_saved_documents_survive_but_deleted_clean_tab_is_skipped;
 * recovery_and_layout_writers_share_one_consistent_session;
 * stale_layout_must_not_orphan_a_new_document_checkpoint (BUG);
 * edits_during_reload_must_keep_the_old_conflict_baseline_after_restart (BUG);
 * failed_close_must_leave_document_available_for_retry (BUG).
 * All 13 frontend cases are in this file; three are save/saveAs/force variants.
 *
 * Frontend follow-up (2026-11-02): B2 is fixed; its repro is enabled below.
 * Added save/discard/cancel coverage for late edits during tab and window close,
 * Discard follow-up: approval is version-bounded; later edits must prompt again.
 * Window exits supersede tab-close generations and release their gate on every
 * terminal save/discard/cancel/error path.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import { documentApi } from '../lib/api'
import { editorSessions } from '../lib/editorSessions'
import { useDocumentStore } from '../stores/documentStore'
import type { DocumentSnapshot } from '../types'
import { useDocumentRuntime } from './useDocumentRuntime'
import { useDocumentRecovery } from './useDocumentRecovery'
import { useDocumentActions } from './useDocumentActions'
import { useDocumentClose } from './useDocumentClose'

vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  documentApi: {
    saveDocument: vi.fn(),
    saveDocumentAs: vi.fn(),
    forceSaveDocument: vi.fn(),
    reloadDocument: vi.fn(),
    setDocumentKind: vi.fn(),
    newDocument: vi.fn(),
    updateRecoveryDocument: vi.fn(),
    updateRecoveryLayout: vi.fn(),
    closeDocument: vi.fn(),
    completeExit: vi.fn(),
    cancelExit: vi.fn(),
  },
}))

const note: DocumentSnapshot = {
  id: 'one',
  path: '/notes/one.txt',
  displayName: 'one.txt',
  kind: 'text',
  content: 'base',
  encoding: 'utf8',
  lineEnding: 'none',
  revision: 'r0',
  readOnly: false,
  normalizationWarning: false,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function addNotes(...ids: string[]) {
  act(() => {
    const snapshots = ids.map((id) => ({
      ...note,
      id,
      path: `/notes/${id}.txt`,
    }))
    snapshots.forEach((snapshot) => editorSessions.seed(snapshot))
    useDocumentStore.getState().addSnapshots(snapshots)
  })
}
function edit(content: string) {
  editorSessions.replaceContent(note.id, content, { preserveUndo: true })
  useDocumentStore.getState().setDirty(note.id, true)
}
function mount(snapshot = note) {
  editorSessions.seed(snapshot)
  editorSessions.getInitialState(snapshot.id, [])
  useDocumentStore.getState().addSnapshots([snapshot])
  const reportError = vi.fn()
  const hook = renderHook(() => {
    const runtime = useDocumentRuntime()
    const recovery = useDocumentRecovery(runtime, reportError)
    const actions = useDocumentActions(
      runtime,
      recovery,
      vi.fn(),
      reportError,
      vi.fn(),
    )
    const close = useDocumentClose(
      runtime,
      recovery,
      actions,
      vi.fn(),
      reportError,
    )
    return { runtime, recovery, actions, close }
  })
  return { ...hook, reportError }
}
async function tick() {
  await act(async () => {
    await Promise.resolve()
  })
}

async function closeCleanTabDuringSave(windowClose = false) {
  const hook = mount()
  const { result } = hook
  const other = { ...note, id: 'two', path: '/notes/two.txt' }
  act(() => {
    useDocumentStore.getState().addSnapshots([other])
    editorSessions.seed(other)
  })
  const pending = deferred<DocumentSnapshot>()
  vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
  let save!: Promise<boolean>
  act(() => {
    save = result.current.actions.performSave('one')
  })
  await tick()
  act(() => result.current.close.requestCloseMany(['one'], windowClose))
  await tick()
  expect(documentApi.closeDocument).not.toHaveBeenCalled()
  expect(documentApi.completeExit).not.toHaveBeenCalled()
  act(() => edit('typed while waiting'))
  await act(async () => {
    pending.resolve({ ...note, revision: 'r1' })
    await save
    await result.current.runtime.tasks.drain()
  })
  await tick()
  return hook
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  useDocumentStore.getState().reset()
  editorSessions.reset()
  vi.mocked(documentApi.updateRecoveryDocument).mockResolvedValue(undefined)
  vi.mocked(documentApi.updateRecoveryLayout).mockResolvedValue(undefined)
  vi.mocked(documentApi.cancelExit).mockResolvedValue(undefined)
  vi.mocked(documentApi.completeExit).mockResolvedValue(undefined)
  vi.mocked(documentApi.closeDocument).mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  editorSessions.reset()
  vi.useRealTimers()
})

describe('save and recovery lifecycle integration', () => {
  it('waits for an older layout IPC before writing the final exit layout', async () => {
    const { result } = mount()
    const pending = deferred<void>()
    vi.mocked(documentApi.updateRecoveryLayout).mockReturnValueOnce(
      pending.promise,
    )
    act(() => useDocumentStore.setState({ hydrated: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(documentApi.updateRecoveryLayout).toHaveBeenCalledTimes(1)
    let flush!: Promise<void>
    act(() => {
      result.current.recovery.pauseRecovery()
      flush = result.current.recovery.flushRecovery()
    })
    await tick()
    expect(documentApi.updateRecoveryDocument).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve()
      await flush
    })
    expect(documentApi.updateRecoveryLayout).toHaveBeenCalledTimes(2)
    expect(documentApi.updateRecoveryLayout).toHaveBeenLastCalledWith({
      documentIds: ['one'],
      activeId: 'one',
    })
  })

  it('rechecks dirty state when a clean tab receives edits while close waits for save', async () => {
    const { result } = await closeCleanTabDuringSave()
    expect(documentApi.closeDocument).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().documentsById.one?.dirty).toBe(true)
    expect(result.current.close.pendingClose).toEqual({
      documentIds: ['one'],
      window: false,
      generation: expect.any(Number),
    })
  })

  describe.each([false, true])(
    'late dirty close (window=%s)',
    (windowClose) => {
      it.each(['save', 'discard', 'cancel'] as const)(
        'honors %s after edits arrive during the pending save',
        async (choice) => {
          const { result } = await closeCleanTabDuringSave(windowClose)
          expect(result.current.close.pendingClose).toMatchObject({
            window: windowClose,
          })
          expect(result.current.close.processing).toBe(false)
          expect(documentApi.completeExit).not.toHaveBeenCalled()
          expect(result.current.runtime.closingRef.current).toBe(false)
          vi.mocked(documentApi.saveDocument).mockImplementation(
            async (request) => ({
              ...note,
              content: request.content,
              revision: 'r2',
            }),
          )
          await act(async () => {
            if (choice === 'save')
              await result.current.close.handlePendingSave()
            else if (choice === 'discard')
              await result.current.close.handlePendingDiscard()
            else result.current.close.cancelPendingClose()
          })
          expect(result.current.close.pendingClose).toBeNull()
          expect(documentApi.saveDocument).toHaveBeenCalledTimes(
            choice === 'save' ? 2 : 1,
          )
          if (choice === 'save') {
            expect(documentApi.saveDocument).toHaveBeenLastCalledWith({
              documentId: 'one',
              content: 'typed while waiting',
              expectedRevision: 'r1',
            })
          }
          if (choice === 'cancel') {
            expect(documentApi.closeDocument).not.toHaveBeenCalled()
            expect(documentApi.completeExit).not.toHaveBeenCalled()
            expect(editorSessions.materialize('one').content).toBe(
              'typed while waiting',
            )
            expect(useDocumentStore.getState().documentsById.one.dirty).toBe(
              true,
            )
            expect(result.current.runtime.exitPromptRef.current).toBe(false)
          } else if (windowClose) {
            expect(documentApi.completeExit).toHaveBeenCalledTimes(1)
            expect(result.current.runtime.exitPromptRef.current).toBe(false)
          } else {
            expect(documentApi.closeDocument).toHaveBeenCalledWith('one')
            expect(
              useDocumentStore.getState().documentsById.one,
            ).toBeUndefined()
          }
        },
      )
    },
  )

  it.each(['save', 'saveAs', 'force'] as const)(
    'serializes %s with subsequent save and takes the latest revision',
    async (mode) => {
      const { result } = mount()
      edit('first')
      const pending = deferred<DocumentSnapshot>()
      const firstApi =
        mode === 'saveAs'
          ? documentApi.saveDocumentAs
          : mode === 'force'
            ? documentApi.forceSaveDocument
            : documentApi.saveDocument
      vi.mocked(firstApi).mockReturnValueOnce(pending.promise)
      vi.mocked(documentApi.saveDocument).mockImplementationOnce(
        async (request) => ({
          ...note,
          content: request.content,
          revision: 'r2',
        }),
      )
      let first!: Promise<boolean>
      let second!: Promise<boolean>
      act(() => {
        first = result.current.actions.performSave('one', mode)
      })
      await tick()
      act(() => {
        edit('second')
        second = result.current.actions.performSave('one')
      })
      await tick()
      expect(firstApi).toHaveBeenCalledTimes(1)
      await act(async () => {
        pending.resolve({ ...note, content: 'first', revision: 'r1' })
        expect(await first).toBe(false)
        expect(await second).toBe(true)
      })
      expect(documentApi.saveDocument).toHaveBeenLastCalledWith({
        documentId: 'one',
        content: 'second',
        expectedRevision: 'r1',
      })
      expect(useDocumentStore.getState().documentsById.one).toMatchObject({
        content: 'second',
        revision: 'r2',
        dirty: false,
      })
    },
  )

  it('keeps typing during save dirty and checkpoints the newer text with the saved revision', async () => {
    const { result } = mount()
    edit('first')
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
    })
    await tick()
    act(() => edit('newer'))
    await act(async () => {
      pending.resolve({ ...note, content: 'first', revision: 'r1' })
      expect(await save).toBe(false)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useDocumentStore.getState().documentsById.one).toMatchObject({
      content: 'newer',
      dirty: true,
      revision: 'r1',
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'newer', dirty: true }),
    )
  })

  it('waits for an in-flight recovery write before saving', async () => {
    const { result } = mount()
    edit('draft')
    const pending = deferred<void>()
    vi.mocked(documentApi.updateRecoveryDocument).mockReturnValueOnce(
      pending.promise,
    )
    vi.mocked(documentApi.saveDocument).mockResolvedValue({
      ...note,
      content: 'draft',
      revision: 'r1',
    })
    let recovery!: Promise<void>
    let save!: Promise<boolean>
    act(() => {
      recovery = result.current.recovery.persistRecoveryDocument('one')
      save = result.current.actions.performSave('one')
    })
    await tick()
    expect(documentApi.saveDocument).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve()
      await recovery
      await save
    })
    expect(documentApi.saveDocument).toHaveBeenCalledTimes(1)
  })

  it('debounces recovery for one second and checkpoints continuous typing by five seconds', async () => {
    const { result } = mount()
    act(() => {
      edit('0')
      result.current.recovery.scheduleRecoveryDocument('one')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(documentApi.updateRecoveryDocument).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenCalledTimes(1)
    vi.mocked(documentApi.updateRecoveryDocument).mockClear()
    act(() => result.current.recovery.scheduleRecoveryDocument('one'))
    for (let n = 1; n <= 6; n++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800)
      })
      act(() => {
        edit(String(n))
        result.current.recovery.scheduleRecoveryDocument('one')
      })
    }
    expect(documentApi.updateRecoveryDocument).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: '6', dirty: true }),
    )
  })

  it('retries failed recovery with current text', async () => {
    const { result, reportError } = mount()
    vi.mocked(documentApi.updateRecoveryDocument).mockRejectedValueOnce(
      new Error('full'),
    )
    act(() => {
      edit('old')
      result.current.recovery.scheduleRecoveryDocument('one')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(reportError).toHaveBeenCalledTimes(1)
    act(() => edit('latest'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'latest' }),
    )
  })

  it('closes a tab only after its pending save and prevents later checkpoint resurrection', async () => {
    const { result } = mount()
    const other = { ...note, id: 'two', path: '/notes/two.txt' }
    act(() => {
      useDocumentStore.getState().addSnapshots([other])
      editorSessions.seed(other)
      edit('draft')
    })
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
      result.current.close.requestTabClose('one')
    })
    await tick()
    let close!: Promise<void>
    act(() => {
      close = result.current.close.handlePendingDiscard()
    })
    await tick()
    expect(documentApi.closeDocument).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve({ ...note, content: 'draft', revision: 'r1' })
      await save
      await close
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(documentApi.closeDocument).toHaveBeenCalledWith('one')
    expect(result.current.close.pendingClose).toBeNull()
    expect(editorSessions.has('one')).toBe(false)
    expect(useDocumentStore.getState().documentsById.one).toBeUndefined()
    expect(documentApi.updateRecoveryDocument).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'reconfirms edits made after discard approval while save waits (window=%s)',
    async (windowClose) => {
      const { result } = mount()
      const other = { ...note, id: 'two', path: '/notes/two.txt' }
      act(() => {
        useDocumentStore.getState().addSnapshots([other])
        editorSessions.seed(other)
        edit('draft')
      })
      const pending = deferred<DocumentSnapshot>()
      vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
      let save!: Promise<boolean>
      act(() => {
        save = result.current.actions.performSave('one')
        result.current.close.requestCloseMany(['one'], windowClose)
      })
      await tick()
      let close!: Promise<void>
      act(() => {
        close = result.current.close.handlePendingDiscard()
      })
      await tick()
      act(() => edit('typed after choosing discard'))
      await act(async () => {
        pending.resolve({ ...note, content: 'draft', revision: 'r1' })
        await save
        await close
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(documentApi.closeDocument).not.toHaveBeenCalled()
      expect(documentApi.completeExit).not.toHaveBeenCalled()
      expect(result.current.close.pendingClose).toMatchObject({
        window: windowClose,
      })
      expect(result.current.close.processing).toBe(false)
      expect(editorSessions.materialize('one').content).toBe(
        'typed after choosing discard',
      )
      expect(useDocumentStore.getState().documentsById.one.dirty).toBe(true)
      expect(documentApi.updateRecoveryDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'typed after choosing discard',
          dirty: true,
        }),
      )
      // A second approval with no further edits is still allowed to discard.
      await act(async () => {
        await result.current.close.handlePendingDiscard()
      })
      expect(result.current.close.pendingClose).toBeNull()
      expect(result.current.runtime.exitPromptRef.current).toBe(false)
      if (windowClose) expect(documentApi.completeExit).toHaveBeenCalledTimes(1)
      else expect(documentApi.closeDocument).toHaveBeenCalledWith('one')
    },
  )

  it.each([
    'save',
    'discard',
    'cancel',
    'error',
    'save-error',
    'cancel-error',
  ] as const)(
    'keeps window exit ahead of a queued tab recheck and releases the gate on %s',
    async (choice) => {
      const { result, reportError } = mount()
      const other = { ...note, id: 'two', path: '/notes/two.txt' }
      act(() => {
        useDocumentStore.getState().addSnapshots([other])
        editorSessions.seed(other)
      })
      const pending = deferred<DocumentSnapshot>()
      vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
      let save!: Promise<boolean>
      act(() => {
        save = result.current.actions.performSave('one')
      })
      await tick()
      act(() => result.current.close.requestTabClose('one'))
      await tick()
      act(() => {
        edit('typed during tab close')
        result.current.close.requestCloseMany(['one', 'two'], true)
      })
      const windowPrompt = result.current.close.pendingClose
      expect(windowPrompt?.window).toBe(true)
      act(() => {
        result.current.close.requestTabClose('one')
        result.current.close.requestCloseMany(['one', 'two'], true)
      })
      expect(result.current.close.pendingClose).toEqual(windowPrompt)
      await act(async () => {
        pending.resolve({ ...note, revision: 'r1' })
        await save
        await result.current.runtime.tasks.drain()
      })
      expect(documentApi.closeDocument).not.toHaveBeenCalled()
      expect(result.current.close.pendingClose).toEqual(windowPrompt)
      expect(result.current.runtime.exitPromptRef.current).toBe(true)
      vi.mocked(documentApi.saveDocument).mockImplementation(
        async (request) => ({
          ...note,
          content: request.content,
          revision: 'r2',
        }),
      )
      const failure = { code: 'WRITE_FAILED', message: 'exit failed' }
      if (choice === 'error')
        vi.mocked(documentApi.completeExit).mockRejectedValueOnce(failure)
      if (choice === 'save-error')
        vi.mocked(documentApi.saveDocument).mockRejectedValueOnce(failure)
      if (choice === 'cancel-error')
        vi.mocked(documentApi.cancelExit).mockRejectedValueOnce(failure)
      await act(async () => {
        if (choice === 'save' || choice === 'save-error')
          await result.current.close.handlePendingSave()
        else if (choice === 'cancel' || choice === 'cancel-error')
          result.current.close.cancelPendingClose()
        else await result.current.close.handlePendingDiscard()
      })
      expect(result.current.close.pendingClose).toBeNull()
      expect(result.current.runtime.exitPromptRef.current).toBe(false)
      expect(result.current.runtime.processingRef.current).toBe(false)
      expect(documentApi.completeExit).toHaveBeenCalledTimes(
        choice === 'cancel' ||
          choice === 'save-error' ||
          choice === 'cancel-error'
          ? 0
          : 1,
      )
      if (choice === 'error' || choice === 'cancel-error')
        expect(reportError).toHaveBeenCalledWith(failure)
      if (
        choice === 'cancel' ||
        choice === 'error' ||
        choice === 'save-error' ||
        choice === 'cancel-error'
      )
        expect(documentApi.cancelExit).toHaveBeenCalledTimes(1)
      // A terminal outcome must not cause later native exit requests to vanish.
      act(() => {
        edit('another exit request')
        result.current.close.requestCloseMany(['one', 'two'], true)
      })
      expect(result.current.close.pendingClose?.window).toBe(true)
      await act(async () => result.current.close.cancelPendingClose())
      expect(result.current.runtime.exitPromptRef.current).toBe(false)
    },
  )

  it('lets window exit supersede a tab Save already in progress', async () => {
    const { result } = mount()
    act(() => {
      edit('draft')
      result.current.close.requestTabClose('one')
    })
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<void>
    act(() => {
      save = result.current.close.handlePendingSave()
    })
    await tick()
    expect(result.current.runtime.processingRef.current).toBe(true)
    expect(documentApi.saveDocument).toHaveBeenCalledTimes(1)
    act(() => result.current.close.requestCloseMany(['one'], true))
    const windowPrompt = result.current.close.pendingClose
    expect(windowPrompt?.window).toBe(true)
    await act(async () => {
      pending.resolve({ ...note, content: 'draft', revision: 'r1' })
      await save
    })
    expect(result.current.close.pendingClose).toEqual(windowPrompt)
    expect(result.current.runtime.exitPromptRef.current).toBe(true)
    expect(documentApi.closeDocument).not.toHaveBeenCalled()
    expect(documentApi.completeExit).not.toHaveBeenCalled()
    await act(async () => result.current.close.cancelPendingClose())
    expect(result.current.runtime.exitPromptRef.current).toBe(false)
  })

  it('invalidates an in-flight tab discard when a newer window exit is cancelled', async () => {
    const { result } = mount()
    act(() => edit('draft'))
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
      result.current.close.requestTabClose('one')
    })
    await tick()
    let discard!: Promise<void>
    act(() => {
      discard = result.current.close.handlePendingDiscard()
    })
    act(() => result.current.close.requestCloseMany(['one'], true))
    expect(result.current.close.pendingClose?.window).toBe(true)
    await act(async () => result.current.close.cancelPendingClose())
    act(() => edit('kept after cancelling window exit'))
    await act(async () => {
      pending.resolve({ ...note, content: 'draft', revision: 'r1' })
      await save
      await discard
    })
    expect(documentApi.closeDocument).not.toHaveBeenCalled()
    expect(documentApi.completeExit).not.toHaveBeenCalled()
    expect(result.current.close.pendingClose).toBeNull()
    expect(result.current.runtime.exitPromptRef.current).toBe(false)
    expect(editorSessions.materialize('one').content).toBe(
      'kept after cancelling window exit',
    )
  })

  it('locks edits during native close and merges repeated closes of the same tab', async () => {
    const { result } = mount()
    addNotes('two')
    const native = deferred<void>()
    vi.mocked(documentApi.closeDocument).mockReturnValueOnce(native.promise)
    act(() => result.current.close.requestTabClose('one'))
    await tick()
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(1)
    expect(editorSessions.isEditingLocked('one')).toBe(true)
    expect(result.current.close.closingDocumentIds).toEqual(['one'])
    act(() => {
      editorSessions.replaceContent('one', 'input during native close', {
        preserveUndo: true,
      })
      result.current.close.requestTabClose('one')
      result.current.close.requestTabClose('one')
    })
    expect(editorSessions.materialize('one').content).toBe('base')
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(1)
    await act(async () => {
      native.resolve()
      await result.current.runtime.tasks.drain()
    })
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(1)
    expect(useDocumentStore.getState().documentsById.one).toBeUndefined()
    expect(editorSessions.isEditingLocked('one')).toBe(false)
  })

  it('unlocks and retains the tab when native close fails, allowing a retry', async () => {
    const { result, reportError } = mount()
    addNotes('two')
    const native = deferred<void>()
    const failure = { code: 'WRITE_FAILED', message: 'close failed' }
    vi.mocked(documentApi.closeDocument).mockReturnValueOnce(native.promise)
    act(() => result.current.close.requestTabClose('one'))
    await tick()
    expect(editorSessions.isEditingLocked('one')).toBe(true)
    await act(async () => {
      native.reject(failure)
      await result.current.runtime.tasks.drain()
    })
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(editorSessions.isEditingLocked('one')).toBe(false)
    expect(result.current.close.closingDocumentIds).toEqual([])
    expect(useDocumentStore.getState().documentsById.one).toBeDefined()
    act(() => {
      edit('editable after close failure')
      result.current.close.requestTabClose('one')
    })
    expect(editorSessions.materialize('one').content).toBe(
      'editable after close failure',
    )
    await act(async () => result.current.close.handlePendingDiscard())
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(2)
    expect(useDocumentStore.getState().documentsById.one).toBeUndefined()
  })

  it('settles a committed native close before presenting a cancellable window exit', async () => {
    const { result } = mount()
    addNotes('two')
    act(() => useDocumentStore.getState().setDirty('two', true))
    const native = deferred<void>()
    vi.mocked(documentApi.closeDocument).mockReturnValueOnce(native.promise)
    act(() => result.current.close.requestTabClose('one'))
    await tick()
    act(() => {
      result.current.close.requestCloseMany(['one', 'two'], true)
      result.current.close.cancelPendingClose()
      editorSessions.replaceContent('one', 'input after attempted cancel', {
        preserveUndo: true,
      })
    })
    expect(result.current.close.pendingClose).toBeNull()
    expect(result.current.close.processing).toBe(true)
    expect(editorSessions.isEditingLocked('one')).toBe(true)
    expect(editorSessions.materialize('one').content).toBe('base')
    await act(async () => {
      native.resolve()
      await result.current.runtime.tasks.drain()
    })
    await tick()
    expect(result.current.close.pendingClose).toMatchObject({
      window: true,
      documentIds: ['two'],
    })
    expect(editorSessions.isEditingLocked('one')).toBe(false)
    expect(useDocumentStore.getState().documentsById.one).toBeUndefined()
    await act(async () => result.current.close.cancelPendingClose())
    const retained = useDocumentStore.getState().documentsById.two
    await tick()
    expect(useDocumentStore.getState().documentsById.two).toBe(retained)
    expect(result.current.runtime.exitPromptRef.current).toBe(false)
    expect(documentApi.completeExit).not.toHaveBeenCalled()
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(1)
  })

  it('does not close a queued tab when its pending save resolves after unmount', async () => {
    const { result, unmount } = mount()
    addNotes('two')
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
    })
    await tick()
    act(() => result.current.close.requestTabClose('one'))
    const runtime = result.current.runtime
    unmount()
    await act(async () => {
      pending.resolve({ ...note, revision: 'r1' })
      await save
      await runtime.tasks.drain()
    })
    expect(documentApi.closeDocument).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().documentsById.one).toBeDefined()
  })

  it.each(['save', 'flush'] as const)(
    'cancels window exit on unmount and never completes after pending %s resolves',
    async (phase) => {
      const { result, unmount } = mount()
      const saved = deferred<DocumentSnapshot>()
      const checkpoint = deferred<void>()
      let save!: Promise<void>
      if (phase === 'save') {
        vi.mocked(documentApi.saveDocument).mockReturnValueOnce(saved.promise)
        act(() => {
          edit('draft')
          result.current.close.requestCloseMany(['one'], true)
        })
        act(() => {
          save = result.current.close.handlePendingSave()
        })
      } else {
        vi.mocked(documentApi.updateRecoveryDocument).mockReturnValueOnce(
          checkpoint.promise,
        )
        act(() => result.current.close.requestCloseMany(['one'], true))
      }
      await tick()
      const runtime = result.current.runtime
      unmount()
      expect(documentApi.cancelExit).toHaveBeenCalledTimes(1)
      expect(runtime.exitPromptRef.current).toBe(false)
      expect(runtime.processingRef.current).toBe(false)
      await act(async () => {
        if (phase === 'save') {
          saved.resolve({ ...note, content: 'draft', revision: 'r1' })
          await save
        } else checkpoint.resolve()
        await runtime.tasks.drain()
      })
      await tick()
      expect(documentApi.completeExit).not.toHaveBeenCalled()
      expect(documentApi.closeDocument).not.toHaveBeenCalled()
      expect(useDocumentStore.getState().documentsById.one).toBeDefined()
    },
  )

  it('releases native-close locks on unmount and ignores the previous response', async () => {
    const { result, unmount } = mount()
    addNotes('two')
    const native = deferred<void>()
    vi.mocked(documentApi.closeDocument).mockReturnValueOnce(native.promise)
    act(() => result.current.close.requestTabClose('one'))
    await tick()
    expect(editorSessions.isEditingLocked('one')).toBe(true)
    const runtime = result.current.runtime
    unmount()
    expect(editorSessions.isEditingLocked('one')).toBe(false)
    await act(async () => {
      native.resolve()
      await runtime.tasks.drain()
    })
    expect(useDocumentStore.getState().documentsById.one).toBeDefined()
    expect(editorSessions.has('one')).toBe(true)
  })

  it('preserves A close while its save waits and B closes independently', async () => {
    const { result } = mount()
    addNotes('two', 'three')
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
    })
    await tick()
    act(() => result.current.close.requestTabClose('one'))
    await tick()
    act(() => result.current.close.requestTabClose('two'))
    await tick()
    expect(documentApi.closeDocument).toHaveBeenCalledWith('two')
    expect(useDocumentStore.getState().documentsById.one).toBeDefined()
    await act(async () => {
      pending.resolve({ ...note, revision: 'r1' })
      await save
      await result.current.runtime.tasks.drain()
    })
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(2)
    expect(documentApi.closeDocument).toHaveBeenCalledWith('one')
    expect(useDocumentStore.getState().documentOrder).toEqual(['three'])
  })

  it('queues independent dirty tab prompts without overwriting or losing either request', async () => {
    const { result } = mount()
    addNotes('two', 'three')
    act(() => {
      edit('A draft')
      useDocumentStore.getState().setDirty('two', true)
      result.current.close.requestTabClose('one')
    })
    const first = result.current.close.pendingClose
    act(() => {
      result.current.close.requestTabClose('two')
      result.current.close.requestTabClose('two')
    })
    expect(result.current.close.pendingClose).toEqual(first)
    act(() => result.current.close.cancelPendingClose())
    expect(result.current.close.pendingClose).toMatchObject({
      documentIds: ['two'],
      window: false,
    })
    await act(async () => result.current.close.handlePendingDiscard())
    expect(documentApi.closeDocument).toHaveBeenCalledTimes(1)
    expect(documentApi.closeDocument).toHaveBeenCalledWith('two')
    expect(useDocumentStore.getState().documentsById.one?.dirty).toBe(true)
    expect(result.current.close.pendingClose).toBeNull()
  })

  it('drains an already pending save before exit flush and cancels timers', async () => {
    const { result } = mount()
    edit('draft')
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.saveDocument).mockReturnValueOnce(pending.promise)
    let save!: Promise<boolean>
    act(() => {
      save = result.current.actions.performSave('one')
      result.current.recovery.scheduleRecoveryDocument('one')
      result.current.close.requestCloseMany(['one'], true)
    })
    await tick()
    let exit!: Promise<void>
    act(() => {
      exit = result.current.close.handlePendingDiscard()
    })
    await tick()
    expect(documentApi.completeExit).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve({ ...note, content: 'draft', revision: 'r1' })
      await save
      await exit
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'draft', dirty: false }),
    )
    expect(documentApi.completeExit).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(documentApi.completeExit).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(documentApi.updateRecoveryLayout).mock.invocationCallOrder[0],
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenCalledTimes(1)
  })

  it('aborts exit and resumes checkpoints when recycling recovery fails', async () => {
    const { result, reportError } = mount()
    edit('draft')
    const failure = { code: 'WRITE_FAILED', message: 'trash failed' }
    vi.mocked(documentApi.completeExit).mockRejectedValueOnce(failure)
    act(() => result.current.close.requestCloseMany(['one'], true))
    await act(async () => {
      await result.current.close.handlePendingDiscard()
    })
    expect(documentApi.cancelExit).toHaveBeenCalledTimes(1)
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(result.current.runtime.closingRef.current).toBe(false)
    expect(useDocumentStore.getState().documentsById.one.dirty).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenCalledTimes(2)
  })

  it('preserves edits arriving during reload and checkpoints them', async () => {
    const { result } = mount()
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(documentApi.reloadDocument).mockReturnValueOnce(pending.promise)
    let reload!: Promise<void>
    act(() => {
      reload = result.current.actions.reloadFromDisk('one', false)
    })
    await tick()
    act(() => edit('typed during reload'))
    await act(async () => {
      pending.resolve({ ...note, content: 'external', revision: 'r1' })
      await reload
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(editorSessions.materialize('one').content).toBe(
      'typed during reload',
    )
    expect(useDocumentStore.getState().documentsById.one).toMatchObject({
      dirty: true,
      externalChange: 'modified',
      revision: 'r0',
    })
    expect(documentApi.updateRecoveryDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'typed during reload', dirty: true }),
    )
  })
})
