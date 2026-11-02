import { history } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocumentSnapshot } from '../types'
import { editorSessions } from './editorSessions'

function snapshot(id: string, content = 'saved'): DocumentSnapshot {
  return {
    id,
    displayName: `${id}.txt`,
    path: null,
    kind: 'text',
    content,
    encoding: 'utf8',
    lineEnding: 'none',
    revision: '',
    readOnly: false,
    normalizationWarning: false,
  }
}

describe('editor sessions', () => {
  afterEach(() => editorSessions.reset())

  it('keeps undo history when a reload is explicitly undoable', () => {
    editorSessions.seed(snapshot('one', 'local'))
    const parent = document.createElement('div')
    document.body.append(parent)
    const state = editorSessions.getInitialState('one', [history()])
    const view = new EditorView({ parent, state })
    editorSessions.activate(view, 'one', state)

    editorSessions.replaceContent('one', 'disk', { preserveUndo: true })
    expect(editorSessions.materialize('one').content).toBe('disk')
    expect(editorSessions.run('undo')).toBe(true)
    expect(editorSessions.materialize('one').content).toBe('local')

    editorSessions.disconnect(view)
    view.destroy()
    parent.remove()
  })

  it('preserves each document state while one view switches tabs', () => {
    editorSessions.seed(snapshot('one', 'first'))
    editorSessions.seed(snapshot('two', 'second'))
    const parent = document.createElement('div')
    document.body.append(parent)
    const first = editorSessions.getInitialState('one', [])
    const view = new EditorView({ parent, state: first })
    editorSessions.activate(view, 'one', first)
    view.dispatch({ changes: { from: first.doc.length, insert: ' changed' } })
    editorSessions.capture('one', view.state)

    const second = editorSessions.getInitialState('two', [])
    editorSessions.activate(view, 'two', second)
    const restored = editorSessions.getInitialState('one', [])
    editorSessions.activate(view, 'one', restored)

    expect(view.state.doc.toString()).toBe('first changed')
    editorSessions.disconnect(view)
    view.destroy()
    parent.remove()
  })

  it('changes the editing kind without changing materialized content', () => {
    editorSessions.seed(snapshot('one', '# title'))
    editorSessions.setKind('one', 'markdown')
    expect(editorSessions.materialize('one').content).toBe('# title')
    expect(editorSessions.getLastMarkdownViewMode('one')).toBe('split')
  })

  it('becomes clean again when undo reaches the saved document', () => {
    editorSessions.seed(snapshot('one', 'saved'))
    const parent = document.createElement('div')
    document.body.append(parent)
    const state = editorSessions.getInitialState('one', [history()])
    const view = new EditorView({ parent, state })
    editorSessions.activate(view, 'one', state)
    view.dispatch({ changes: { from: state.doc.length, insert: ' edit' } })
    expect(editorSessions.capture('one', view.state)).toBe(true)

    editorSessions.run('undo')
    expect(editorSessions.capture('one', view.state)).toBe(false)

    editorSessions.disconnect(view)
    view.destroy()
    parent.remove()
  })

  it('stays dirty when another edit arrives while saving', () => {
    editorSessions.seed(snapshot('one', 'saved'))
    const parent = document.createElement('div')
    document.body.append(parent)
    const state = editorSessions.getInitialState('one', [history()])
    const view = new EditorView({ parent, state })
    editorSessions.activate(view, 'one', state)
    view.dispatch({ changes: { from: state.doc.length, insert: ' first' } })
    editorSessions.capture('one', view.state)
    const sent = editorSessions.materialize('one').content

    view.dispatch({
      changes: { from: view.state.doc.length, insert: ' second' },
    })
    editorSessions.capture('one', view.state)
    expect(editorSessions.markSaved('one', sent)).toBe(true)
    expect(editorSessions.materialize('one').content).toBe('saved first second')

    editorSessions.disconnect(view)
    view.destroy()
    parent.remove()
  })
})
