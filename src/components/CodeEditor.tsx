import { useEffect, useRef } from 'react'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import {
  Compartment,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  GutterMarker,
  gutterLineClass,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { editorSessions } from '../lib/editorSessions'
import { linkedLines, selectedLines } from '../lib/sourceLines'
import {
  useEditorStatusStore,
  type EditorStatus,
} from '../stores/editorStatusStore'
import type { DocumentKind } from '../types'

interface CodeEditorProps {
  documentId: string
  kind: DocumentKind
  readOnly: boolean
  wordWrap: boolean
  fontSize: number
  hidden?: boolean
  onDocumentChange: (documentId: string, dirty: boolean) => void
  onSessionChange: (documentId: string) => void
  onScrollFractionChange?: (fraction: number) => void
}

function languageExtension(kind: DocumentKind): Extension {
  return kind === 'markdown' ? markdown() : []
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]
}

function fontExtension(fontSize: number) {
  return EditorView.theme({ '&': { fontSize: `${fontSize}px` } })
}

// The native file-drop handler swallows in-webview drops on macOS and Windows,
// so a text drag could never land. Cancelling it turns the gesture into a
// plain mouse selection instead.
const disableTextDrag = EditorView.domEventHandlers({
  dragstart: (event) => {
    event.preventDefault()
    return true
  },
})

function editorStatus(state: EditorState): EditorStatus {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return {
    line: line.number,
    column: head - line.from + 1,
    characters: state.doc.length,
    selectedLines: state.selection.ranges.map((range) =>
      selectedLines(state, range),
    ),
  }
}

const activeLineDecoration = Decoration.line({ class: 'cm-activeLine' })

// Like highlightActiveLine, but highlights every line a selection covers.
// Decorations are limited to the visible ranges so large selections stay cheap.
const highlightSelectedLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView) {
      const { state } = view
      const builder = new RangeSetBuilder<Decoration>()
      let lastAdded = 0
      for (const visible of view.visibleRanges) {
        const visibleFirst = state.doc.lineAt(visible.from).number
        const visibleLast = state.doc.lineAt(visible.to).number
        for (const range of state.selection.ranges) {
          const { first, last } = selectedLines(state, range)
          const from = Math.max(first, visibleFirst, lastAdded + 1)
          for (let line = from; line <= Math.min(last, visibleLast); line++) {
            builder.add(
              state.doc.line(line).from,
              state.doc.line(line).from,
              activeLineDecoration,
            )
            lastAdded = line
          }
        }
      }
      return builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const activeLineGutterMarker = new (class extends GutterMarker {
  elementClass = 'cm-activeLineGutter'
})()

const highlightSelectedLineGutters = gutterLineClass.compute(
  ['selection'],
  (state) => {
    const marks = []
    let lastAdded = 0
    for (const range of state.selection.ranges) {
      const { first, last } = selectedLines(state, range)
      const start = Math.max(first, lastAdded + 1)
      if (start > last) continue
      // Walking lines sequentially is much cheaper than a line lookup per
      // line when a whole large document is selected.
      let position = state.doc.line(start).from
      for (const text of state.doc.iterLines(start, last + 1)) {
        marks.push(activeLineGutterMarker.range(position))
        position += text.length + 1
      }
      lastAdded = last
    }
    return RangeSet.of(marks)
  },
)

export function CodeEditor({
  documentId,
  kind,
  readOnly,
  wordWrap,
  fontSize,
  hidden = false,
  onDocumentChange,
  onSessionChange,
  onScrollFractionChange,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const extensionsRef = useRef<Extension | null>(null)
  const documentIdRef = useRef(documentId)
  const statusFrameRef = useRef<number | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const callbacksRef = useRef({
    onDocumentChange,
    onSessionChange,
    onScrollFractionChange,
  })
  const compartmentsRef = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    wordWrap: new Compartment(),
    font: new Compartment(),
  })

  callbacksRef.current = {
    onDocumentChange,
    onSessionChange,
    onScrollFractionChange,
  }

  useEffect(() => {
    if (!hostRef.current) return
    const compartments = compartmentsRef.current
    const extensions: Extension = [
      lineNumbers(),
      highlightSelectedLineGutters,
      highlightSpecialChars(),
      history(),
      drawSelection(),
      disableTextDrag,
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      highlightSelectedLines,
      linkedLines,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      compartments.language.of(languageExtension(kind)),
      compartments.readOnly.of(readOnlyExtension(readOnly)),
      compartments.wordWrap.of(wordWrap ? EditorView.lineWrapping : []),
      compartments.font.of(fontExtension(fontSize)),
      EditorView.theme({
        '&': {
          height: '100%',
          backgroundColor: 'var(--editor-bg)',
          color: 'var(--text-primary)',
        },
        '.cm-scroller': {
          fontFamily:
            "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
          lineHeight: '1.65',
          overflow: 'auto',
        },
        '.cm-content': {
          padding: '20px 8px 40px',
          caretColor: 'var(--accent)',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--editor-bg)',
          color: 'var(--text-muted)',
          borderRight: '1px solid var(--border)',
        },
        '.cm-activeLine, .cm-activeLineGutter': {
          backgroundColor: 'var(--active-line)',
        },
        '.cm-linkedLine': { backgroundColor: 'var(--linked-source)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: 'var(--selection)',
        },
        '.cm-cursor': { borderLeftColor: 'var(--accent)' },
        '.cm-panels': {
          backgroundColor: 'var(--surface-raised)',
          color: 'var(--text-primary)',
        },
        '.cm-textfield': {
          backgroundColor: 'var(--surface)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-strong)',
        },
      }),
      EditorView.updateListener.of((update) => {
        const id = documentIdRef.current
        const dirty = editorSessions.capture(id, update.state)
        if (update.docChanged) {
          callbacksRef.current.onDocumentChange(id, dirty)
        }
        if (update.selectionSet || update.docChanged) {
          if (statusFrameRef.current !== null) {
            cancelAnimationFrame(statusFrameRef.current)
          }
          statusFrameRef.current = requestAnimationFrame(() => {
            useEditorStatusStore
              .getState()
              .update(id, editorStatus(update.state))
            callbacksRef.current.onSessionChange(id)
          })
        }
      }),
    ]
    extensionsRef.current = extensions

    const initialState = editorSessions.getInitialState(documentId, extensions)
    const view = new EditorView({
      parent: hostRef.current,
      state: initialState,
    })
    viewRef.current = view
    documentIdRef.current = documentId
    editorSessions.activate(view, documentId, initialState)

    const updateScroll = () => {
      const id = documentIdRef.current
      editorSessions.setScrollTop(id, view.scrollDOM.scrollTop)
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }
      scrollFrameRef.current = requestAnimationFrame(() => {
        const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
        callbacksRef.current.onScrollFractionChange?.(
          max > 0 ? view.scrollDOM.scrollTop / max : 0,
        )
        callbacksRef.current.onSessionChange(id)
      })
    }
    view.scrollDOM.addEventListener('scroll', updateScroll, { passive: true })

    useEditorStatusStore.getState().update(documentId, editorStatus(view.state))

    return () => {
      if (statusFrameRef.current !== null) {
        cancelAnimationFrame(statusFrameRef.current)
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }
      view.scrollDOM.removeEventListener('scroll', updateScroll)
      editorSessions.disconnect(view)
      view.destroy()
      viewRef.current = null
    }
    // The EditorView is intentionally created once. Documents and settings are
    // swapped through EditorState and Compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || documentIdRef.current === documentId) return
    documentIdRef.current = documentId
    const extensions = extensionsRef.current
    if (!extensions) return
    const state = editorSessions.getInitialState(documentId, extensions)
    editorSessions.activate(view, documentId, state)
    useEditorStatusStore.getState().update(documentId, editorStatus(state))
    if (!hidden) view.focus()
  }, [documentId, fontSize, hidden, kind, readOnly, wordWrap])

  useEffect(() => {
    const view = viewRef.current
    if (!view || documentIdRef.current !== documentId) return
    const compartments = compartmentsRef.current
    view.dispatch({
      effects: [
        compartments.language.reconfigure(languageExtension(kind)),
        compartments.readOnly.reconfigure(readOnlyExtension(readOnly)),
        compartments.wordWrap.reconfigure(
          wordWrap ? EditorView.lineWrapping : [],
        ),
        compartments.font.reconfigure(fontExtension(fontSize)),
      ],
    })
  }, [documentId, fontSize, kind, readOnly, wordWrap])

  useEffect(() => {
    if (!hidden) viewRef.current?.focus()
  }, [hidden])

  return (
    <div
      className="code-editor"
      ref={hostRef}
      data-testid="code-editor"
      aria-hidden={hidden}
    />
  )
}
