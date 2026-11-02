import { create } from 'zustand'
import type {
  DocumentKindUpdate,
  DocumentSnapshot,
  DocumentTab,
  ExternalChangeKind,
  RestoredDocument,
  ViewMode,
} from '../types'

interface DocumentState {
  documentsById: Record<string, DocumentTab>
  documentOrder: string[]
  activeId: string | null
  hydrated: boolean
  hydrate: (documents: RestoredDocument[], activeId: string | null) => void
  addSnapshots: (documents: DocumentSnapshot[]) => void
  setActive: (documentId: string) => void
  setDirty: (documentId: string, dirty: boolean) => void
  setMaterializedContent: (
    documentId: string,
    content: string,
    byteLength: number,
  ) => void
  setViewMode: (documentId: string, viewMode: ViewMode) => void
  applyKindUpdate: (update: DocumentKindUpdate, viewMode: ViewMode) => void
  applySavedSnapshot: (snapshot: DocumentSnapshot) => void
  applyReloadedSnapshot: (snapshot: DocumentSnapshot) => void
  setExternalChange: (
    documentId: string,
    change: ExternalChangeKind | null,
  ) => void
  closeLocal: (documentId: string) => void
  reset: () => void
}

const initialState = {
  documentsById: {} as Record<string, DocumentTab>,
  documentOrder: [] as string[],
  activeId: null as string | null,
  hydrated: false,
}

function contentByteLength(content: string) {
  return new TextEncoder().encode(content).byteLength
}

function fromSnapshot(snapshot: DocumentSnapshot): DocumentTab {
  return {
    ...snapshot,
    dirty: false,
    viewMode: 'source',
    externalChange: null,
    byteLength: contentByteLength(snapshot.content),
    lastMarkdownViewMode: 'split',
  }
}

function updateDocument(
  state: Pick<DocumentState, 'documentsById'>,
  documentId: string,
  updater: (document: DocumentTab) => DocumentTab,
) {
  const document = state.documentsById[documentId]
  if (!document) return state.documentsById
  const updated = updater(document)
  if (updated === document) return state.documentsById
  return { ...state.documentsById, [documentId]: updated }
}

export const useDocumentStore = create<DocumentState>((set) => ({
  ...initialState,

  hydrate: (restored, requestedActiveId) =>
    set(() => {
      const documentsById: Record<string, DocumentTab> = {}
      const documentOrder: string[] = []
      for (const item of restored) {
        const viewMode =
          item.document.kind === 'text' ? 'source' : item.viewMode
        documentsById[item.document.id] = {
          ...item.document,
          dirty: item.dirty,
          viewMode,
          externalChange: item.externalChange ? 'modified' : null,
          byteLength: contentByteLength(item.document.content),
          lastMarkdownViewMode:
            viewMode === 'split' || viewMode === 'preview' ? viewMode : 'split',
        }
        documentOrder.push(item.document.id)
      }
      const activeId =
        requestedActiveId && documentsById[requestedActiveId]
          ? requestedActiveId
          : (documentOrder[0] ?? null)
      return { documentsById, documentOrder, activeId, hydrated: true }
    }),

  addSnapshots: (snapshots) =>
    set((state) => {
      const documentsById = { ...state.documentsById }
      const documentOrder = [...state.documentOrder]
      let activeId = state.activeId
      for (const snapshot of snapshots) {
        const existingId = documentOrder.find((documentId) => {
          const document = documentsById[documentId]
          return (
            document.id === snapshot.id ||
            (snapshot.path !== null && document.path === snapshot.path)
          )
        })
        if (existingId) {
          activeId = existingId
          continue
        }
        documentsById[snapshot.id] = fromSnapshot(snapshot)
        documentOrder.push(snapshot.id)
        activeId = snapshot.id
      }
      return { documentsById, documentOrder, activeId }
    }),

  setActive: (documentId) =>
    set((state) =>
      state.documentsById[documentId] ? { activeId: documentId } : state,
    ),

  setDirty: (documentId, dirty) =>
    set((state) => ({
      documentsById: updateDocument(state, documentId, (document) =>
        document.dirty === dirty ? document : { ...document, dirty },
      ),
    })),

  setMaterializedContent: (documentId, content, byteLength) =>
    set((state) => ({
      documentsById: updateDocument(state, documentId, (document) =>
        document.content === content && document.byteLength === byteLength
          ? document
          : { ...document, content, byteLength },
      ),
    })),

  setViewMode: (documentId, viewMode) =>
    set((state) => ({
      documentsById: updateDocument(state, documentId, (document) => {
        const resolved = document.kind === 'text' ? 'source' : viewMode
        return {
          ...document,
          viewMode: resolved,
          lastMarkdownViewMode:
            resolved === 'split' || resolved === 'preview'
              ? resolved
              : document.lastMarkdownViewMode,
        }
      }),
    })),

  applyKindUpdate: (update, viewMode) =>
    set((state) => ({
      documentsById: updateDocument(state, update.id, (document) => ({
        ...document,
        displayName: update.displayName,
        kind: update.kind,
        viewMode: update.kind === 'text' ? 'source' : viewMode,
        lastMarkdownViewMode:
          viewMode === 'split' || viewMode === 'preview'
            ? viewMode
            : document.lastMarkdownViewMode,
      })),
    })),

  applySavedSnapshot: (snapshot) =>
    set((state) => ({
      documentsById: updateDocument(state, snapshot.id, (document) => ({
        ...document,
        ...snapshot,
        dirty: false,
        byteLength: contentByteLength(snapshot.content),
        externalChange: null,
        viewMode: snapshot.kind === 'text' ? 'source' : document.viewMode,
      })),
    })),

  applyReloadedSnapshot: (snapshot) =>
    set((state) => ({
      documentsById: updateDocument(state, snapshot.id, (document) => ({
        ...document,
        ...snapshot,
        dirty: false,
        byteLength: contentByteLength(snapshot.content),
        externalChange: null,
        viewMode: snapshot.kind === 'text' ? 'source' : document.viewMode,
      })),
    })),

  setExternalChange: (documentId, externalChange) =>
    set((state) => ({
      documentsById: updateDocument(state, documentId, (document) =>
        document.externalChange === externalChange
          ? document
          : { ...document, externalChange },
      ),
    })),

  closeLocal: (documentId) =>
    set((state) => {
      const index = state.documentOrder.indexOf(documentId)
      if (index < 0) return state
      const documentOrder = state.documentOrder.filter(
        (id) => id !== documentId,
      )
      const documentsById = { ...state.documentsById }
      delete documentsById[documentId]
      const activeId =
        state.activeId === documentId
          ? (documentOrder[Math.min(index, documentOrder.length - 1)] ?? null)
          : state.activeId
      return { documentsById, documentOrder, activeId }
    }),

  reset: () => set(initialState),
}))

export function orderedDocuments(state: DocumentState) {
  return state.documentOrder
    .map((id) => state.documentsById[id])
    .filter(Boolean)
}
