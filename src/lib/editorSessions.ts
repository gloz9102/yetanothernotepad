import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import {
  EditorSelection,
  EditorState,
  Text,
  Transaction,
  type Extension,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  DocumentKind,
  DocumentSnapshot,
  LineRange,
  ViewMode,
} from '../types'
import { setLinkedLines } from './sourceLines'

interface MaterializedDocument {
  content: string
  byteLength: number
  version: number
}

interface EditorSession {
  documentId: string
  kind: DocumentKind
  state: EditorState | null
  seedContent: string
  seedCursor: number
  savedDoc: Text | null
  scrollTop: number
  version: number
  materialized: MaterializedDocument
  lastMarkdownViewMode: Exclude<ViewMode, 'source'>
}

type EditorCommand = 'undo' | 'redo' | 'find' | 'replace'

function byteLength(content: string) {
  return new TextEncoder().encode(content).byteLength
}

class EditorSessionRegistry {
  private sessions = new Map<string, EditorSession>()
  private activeView: EditorView | null = null
  private activeDocumentId: string | null = null

  seed(
    snapshot: DocumentSnapshot,
    options: {
      dirty?: boolean
      cursor?: number
      scrollTop?: number
      viewMode?: ViewMode
    } = {},
  ) {
    const existing = this.sessions.get(snapshot.id)
    if (existing) return existing

    const content = snapshot.content
    const text = Text.of(content.split('\n'))
    const session: EditorSession = {
      documentId: snapshot.id,
      kind: snapshot.kind,
      state: null,
      seedContent: content,
      seedCursor: Math.min(Math.max(0, options.cursor ?? 0), content.length),
      savedDoc: options.dirty ? null : text,
      scrollTop: options.scrollTop ?? 0,
      version: 0,
      materialized: {
        content,
        byteLength: byteLength(content),
        version: 0,
      },
      lastMarkdownViewMode:
        options.viewMode === 'preview' || options.viewMode === 'split'
          ? options.viewMode
          : 'split',
    }
    this.sessions.set(snapshot.id, session)
    return session
  }

  has(documentId: string) {
    return this.sessions.has(documentId)
  }

  getInitialState(documentId: string, extensions: Extension) {
    const session = this.require(documentId)
    if (!session.state) {
      const state = EditorState.create({
        doc: session.seedContent,
        selection: EditorSelection.cursor(session.seedCursor),
        extensions,
      })
      session.state = state
      if (session.savedDoc && !state.doc.eq(session.savedDoc)) {
        session.savedDoc = state.doc
      }
    }
    return session.state
  }

  activate(view: EditorView, documentId: string, state: EditorState) {
    if (this.activeDocumentId && this.activeDocumentId !== documentId) {
      const previous = this.sessions.get(this.activeDocumentId)
      if (previous) {
        previous.state = view.state
        previous.scrollTop = view.scrollDOM.scrollTop
      }
    }
    this.activeView = view
    this.activeDocumentId = documentId
    const session = this.require(documentId)
    session.state = state
    if (view.state !== state) view.setState(state)
    requestAnimationFrame(() => {
      if (this.activeDocumentId === documentId) {
        view.scrollDOM.scrollTop = session.scrollTop
      }
    })
  }

  disconnect(view: EditorView) {
    if (this.activeView !== view) return
    if (this.activeDocumentId) {
      const session = this.sessions.get(this.activeDocumentId)
      if (session) {
        session.state = view.state
        session.scrollTop = view.scrollDOM.scrollTop
      }
    }
    this.activeView = null
    this.activeDocumentId = null
  }

  capture(documentId: string, state: EditorState) {
    const session = this.require(documentId)
    const changed = session.state ? !state.doc.eq(session.state.doc) : true
    session.state = state
    if (changed) session.version += 1
    return session.savedDoc ? !state.doc.eq(session.savedDoc) : true
  }

  setScrollTop(documentId: string, scrollTop: number) {
    const session = this.sessions.get(documentId)
    if (session) session.scrollTop = scrollTop
  }

  getMetrics(documentId: string) {
    const session = this.require(documentId)
    const state = session.state
    return {
      cursor: state?.selection.main.head ?? session.seedCursor,
      scrollTop: session.scrollTop,
      length: state?.doc.length ?? session.seedContent.length,
      version: session.version,
    }
  }

  materialize(documentId: string): MaterializedDocument {
    const session = this.require(documentId)
    if (session.materialized.version === session.version) {
      return session.materialized
    }
    const content = session.state?.doc.toString() ?? session.seedContent
    session.materialized = {
      content,
      byteLength: byteLength(content),
      version: session.version,
    }
    return session.materialized
  }

  markSaved(documentId: string, content: string) {
    const session = this.require(documentId)
    const state = session.state
    if (state && state.doc.toString() === content) {
      session.savedDoc = state.doc
      session.materialized = {
        content,
        byteLength: byteLength(content),
        version: session.version,
      }
      return false
    } else {
      const text = Text.of(content.split('\n'))
      session.savedDoc = text
      session.seedContent = content
      return state ? !state.doc.eq(text) : false
    }
  }

  replaceContent(
    documentId: string,
    content: string,
    options: { preserveUndo: boolean },
  ) {
    const session = this.require(documentId)
    const state = session.state
    if (!state) {
      session.seedContent = content
      session.seedCursor = Math.min(session.seedCursor, content.length)
      session.savedDoc = Text.of(content.split('\n'))
      session.version += 1
    } else {
      const previousVersion = session.version
      const previousDoc = state.doc
      const spec = {
        changes: { from: 0, to: state.doc.length, insert: content },
        selection: EditorSelection.cursor(
          Math.min(state.selection.main.head, content.length),
        ),
        annotations: options.preserveUndo
          ? undefined
          : Transaction.addToHistory.of(false),
      }
      if (this.activeDocumentId === documentId && this.activeView) {
        this.activeView.dispatch(spec)
        session.state = this.activeView.state
        if (
          session.version === previousVersion &&
          !session.state.doc.eq(previousDoc)
        ) {
          session.version += 1
        }
      } else {
        session.state = state.update(spec).state
        session.version += 1
      }
      session.savedDoc = session.state.doc
    }
    session.materialized = {
      content,
      byteLength: byteLength(content),
      version: session.version,
    }
  }

  setKind(documentId: string, kind: DocumentKind) {
    this.require(documentId).kind = kind
  }

  getLastMarkdownViewMode(documentId: string) {
    return this.require(documentId).lastMarkdownViewMode
  }

  setLastMarkdownViewMode(
    documentId: string,
    viewMode: Exclude<ViewMode, 'source'>,
  ) {
    this.require(documentId).lastMarkdownViewMode = viewMode
  }

  run(command: EditorCommand) {
    const view = this.activeView
    if (!view) return false
    const result =
      command === 'undo'
        ? undo(view)
        : command === 'redo'
          ? redo(view)
          : openSearchPanel(view)
    if (this.activeDocumentId) this.capture(this.activeDocumentId, view.state)
    return result
  }

  focus() {
    this.activeView?.focus()
  }

  showLinkedLines(range: LineRange | null) {
    this.activeView?.dispatch({ effects: setLinkedLines.of(range) })
  }

  getScrollFraction() {
    const view = this.activeView
    if (!view) return 0
    const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
    return max > 0 ? view.scrollDOM.scrollTop / max : 0
  }

  setScrollFraction(fraction: number) {
    const view = this.activeView
    if (!view) return
    const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
    view.scrollDOM.scrollTop =
      Math.max(0, Math.min(1, fraction)) * Math.max(0, max)
  }

  remove(documentId: string) {
    this.sessions.delete(documentId)
    if (this.activeDocumentId === documentId) {
      this.activeDocumentId = null
    }
  }

  reset() {
    this.sessions.clear()
    this.activeDocumentId = null
    this.activeView = null
  }

  private require(documentId: string) {
    const session = this.sessions.get(documentId)
    if (!session) throw new Error(`Editor session not found: ${documentId}`)
    return session
  }
}

export const editorSessions = new EditorSessionRegistry()
