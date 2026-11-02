import { create } from 'zustand'
import type { LineRange } from '../types'

export interface EditorStatus {
  line: number
  column: number
  characters: number
  selectedLines: LineRange[]
}

interface EditorStatusState {
  byDocumentId: Record<string, EditorStatus>
  update: (documentId: string, status: EditorStatus) => void
  remove: (documentId: string) => void
  reset: () => void
}

export const useEditorStatusStore = create<EditorStatusState>((set) => ({
  byDocumentId: {},
  update: (documentId, status) =>
    set((state) => ({
      byDocumentId: { ...state.byDocumentId, [documentId]: status },
    })),
  remove: (documentId) =>
    set((state) => {
      const byDocumentId = { ...state.byDocumentId }
      delete byDocumentId[documentId]
      return { byDocumentId }
    }),
  reset: () => set({ byDocumentId: {} }),
}))
