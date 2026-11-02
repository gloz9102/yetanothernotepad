import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { editorSessions } from '../lib/editorSessions'
import { CodeEditor } from './CodeEditor'

afterEach(() => editorSessions.reset())

function renderEditor(content: string) {
  editorSessions.seed({
    id: 'editor',
    displayName: 'editor.txt',
    path: null,
    kind: 'text',
    content,
    encoding: 'utf8',
    lineEnding: 'none',
    revision: '',
    readOnly: false,
    normalizationWarning: false,
  })
  const { container } = render(
    <CodeEditor
      documentId="editor"
      kind="text"
      readOnly={false}
      wordWrap={false}
      fontSize={14}
      onDocumentChange={() => {}}
      onSessionChange={() => {}}
    />,
  )
  const editor = container.querySelector<HTMLElement>('.cm-editor')
  const view = editor && EditorView.findFromDOM(editor)
  if (!view) throw new Error('editor view not mounted')
  return { container, view }
}

it('cancels native text drags that the file-drop handler would swallow', () => {
  const { container } = renderEditor('move me')

  const content = container.querySelector('.cm-content')
  expect(content).not.toBeNull()
  const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
  content?.dispatchEvent(dragStart)
  expect(dragStart.defaultPrevented).toBe(true)
})

describe('selected line highlight', () => {
  const lines = 'one\ntwo\nthree\nfour'
  const highlighted = (container: HTMLElement) => ({
    lines: [...container.querySelectorAll('.cm-line.cm-activeLine')].map(
      (line) => line.textContent,
    ),
    gutters: [
      ...container.querySelectorAll('.cm-gutterElement.cm-activeLineGutter'),
    ].map((gutter) => gutter.textContent),
  })
  const select = (view: EditorView, selection: EditorSelection) =>
    act(() => view.dispatch({ selection }))

  it('highlights only the cursor line without a selection', () => {
    const { container, view } = renderEditor(lines)
    select(view, EditorSelection.single(5))
    expect(highlighted(container)).toEqual({
      lines: ['two'],
      gutters: ['2'],
    })
  })

  it('highlights every line covered by a selection', () => {
    const { container, view } = renderEditor(lines)
    select(view, EditorSelection.single(1, 10))
    expect(highlighted(container)).toEqual({
      lines: ['one', 'two', 'three'],
      gutters: ['1', '2', '3'],
    })
  })

  it('skips the line where a selection ends at column zero', () => {
    const { container, view } = renderEditor(lines)
    select(view, EditorSelection.single(0, 8))
    expect(highlighted(container)).toEqual({
      lines: ['one', 'two'],
      gutters: ['1', '2'],
    })
  })

  it('highlights the lines of each selection range', () => {
    const { container, view } = renderEditor(lines)
    select(
      view,
      EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.range(9, 16),
      ]),
    )
    expect(highlighted(container)).toEqual({
      lines: ['one', 'three', 'four'],
      gutters: ['1', '3', '4'],
    })
  })
})

describe('linked preview lines', () => {
  const linked = (container: HTMLElement) =>
    [...container.querySelectorAll('.cm-line.cm-linkedLine')].map(
      (line) => line.textContent,
    )

  it('highlights lines picked in the preview until the selection moves', () => {
    const { container, view } = renderEditor('one\ntwo\nthree\nfour')

    act(() => editorSessions.showLinkedLines({ first: 2, last: 3 }))
    expect(linked(container)).toEqual(['two', 'three'])

    act(() => editorSessions.showLinkedLines({ first: 4, last: 99 }))
    expect(linked(container)).toEqual(['four'])

    act(() => view.dispatch({ selection: EditorSelection.single(1) }))
    expect(linked(container)).toEqual([])
  })
})
