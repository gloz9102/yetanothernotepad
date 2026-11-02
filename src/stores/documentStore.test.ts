import { beforeEach, describe, expect, it } from 'vitest'
import type { DocumentSnapshot } from '../types'
import { useDocumentStore } from './documentStore'

function snapshot(
  id: string,
  overrides: Partial<DocumentSnapshot> = {},
): DocumentSnapshot {
  return {
    id,
    displayName: `${id}.md`,
    path: `/notes/${id}.md`,
    kind: 'markdown',
    content: '# Initial',
    encoding: 'utf8',
    lineEnding: 'lf',
    revision: `revision-${id}`,
    readOnly: false,
    normalizationWarning: false,
    ...overrides,
  }
}

describe('document store', () => {
  beforeEach(() => useDocumentStore.getState().reset())

  it('creates tabs and activates the latest tab', () => {
    useDocumentStore.getState().addSnapshots([snapshot('one'), snapshot('two')])

    const state = useDocumentStore.getState()
    expect(state.documentOrder).toEqual(['one', 'two'])
    expect(state.activeId).toBe('two')
  })

  it('activates an existing tab instead of opening the same path twice', () => {
    useDocumentStore.getState().addSnapshots([snapshot('one')])
    useDocumentStore
      .getState()
      .addSnapshots([snapshot('duplicate', { path: '/notes/one.md' })])

    const state = useDocumentStore.getState()
    expect(state.documentOrder).toHaveLength(1)
    expect(state.activeId).toBe('one')
  })

  it('tracks dirty content and clears it after a successful save', () => {
    useDocumentStore.getState().addSnapshots([snapshot('one')])
    useDocumentStore.getState().setDirty('one', true)
    useDocumentStore.getState().setMaterializedContent('one', '# Changed', 9)
    expect(useDocumentStore.getState().documentsById.one.dirty).toBe(true)

    useDocumentStore
      .getState()
      .applySavedSnapshot(
        snapshot('one', { content: '# Changed', revision: 'revision-new' }),
      )

    const document = useDocumentStore.getState().documentsById.one
    expect(document.dirty).toBe(false)
    expect(document.content).toBe('# Changed')
    expect(document.revision).toBe('revision-new')
  })

  it('allows rich modes only for Markdown documents', () => {
    useDocumentStore
      .getState()
      .addSnapshots([
        snapshot('markdown'),
        snapshot('text', { kind: 'text', path: '/notes/text.txt' }),
      ])

    useDocumentStore.getState().setViewMode('markdown', 'split')
    useDocumentStore.getState().setViewMode('text', 'preview')

    const { markdown, text } = useDocumentStore.getState().documentsById
    expect(markdown.viewMode).toBe('split')
    expect(text.viewMode).toBe('source')
  })

  it('keeps external changes visible until a reload is applied', () => {
    useDocumentStore.getState().addSnapshots([snapshot('one')])
    useDocumentStore.getState().setExternalChange('one', 'modified')
    expect(useDocumentStore.getState().documentsById.one.externalChange).toBe(
      'modified',
    )

    useDocumentStore
      .getState()
      .applyReloadedSnapshot(
        snapshot('one', { content: '# Disk', revision: 'revision-disk' }),
      )
    expect(useDocumentStore.getState().documentsById.one).toMatchObject({
      content: '# Disk',
      dirty: false,
      externalChange: null,
    })
  })

  it('selects a neighboring tab when the active tab closes', () => {
    useDocumentStore.getState().addSnapshots([snapshot('one'), snapshot('two')])
    useDocumentStore.getState().closeLocal('two')

    expect(useDocumentStore.getState().activeId).toBe('one')
  })

  it('changes only unsaved document metadata to Markdown', () => {
    useDocumentStore.getState().addSnapshots([
      snapshot('draft', {
        path: null,
        kind: 'text',
        displayName: 'Untitled 1.txt',
      }),
    ])

    useDocumentStore.getState().applyKindUpdate(
      {
        id: 'draft',
        displayName: 'Untitled 1.md',
        kind: 'markdown',
      },
      'split',
    )

    expect(useDocumentStore.getState().documentsById.draft).toMatchObject({
      kind: 'markdown',
      displayName: 'Untitled 1.md',
      viewMode: 'split',
    })
  })
})
