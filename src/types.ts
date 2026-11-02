export type DocumentKind = 'text' | 'markdown'
export type TextEncoding = 'utf8' | 'utf8Bom' | 'utf16Le' | 'utf16Be' | 'cp949'
export type LineEnding = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed'
export type ViewMode = 'source' | 'split' | 'preview'

/** Inclusive 1-based source line range. */
export interface LineRange {
  first: number
  last: number
}
export type ExternalChangeKind = 'modified' | 'deleted'

export interface DocumentSnapshot {
  id: string
  displayName: string
  path: string | null
  kind: DocumentKind
  content: string
  encoding: TextEncoding
  lineEnding: LineEnding
  revision: string
  readOnly: boolean
  warnings?: string[]
  normalizationWarning: boolean
}

export interface RestoredDocument {
  document: DocumentSnapshot
  dirty: boolean
  viewMode: ViewMode
  cursor: number
  scrollTop: number
  externalChange: boolean
}

export interface RestoredSession {
  documents: RestoredDocument[]
  activeId: string | null
}

export interface DocumentTab extends DocumentSnapshot {
  dirty: boolean
  viewMode: ViewMode
  externalChange: ExternalChangeKind | null
  byteLength: number
  lastMarkdownViewMode: Exclude<ViewMode, 'source'>
}

export interface DocumentKindUpdate {
  id: string
  displayName: string
  kind: DocumentKind
}

export interface SaveDocumentRequest {
  documentId: string
  content: string
  expectedRevision: string
}

export interface RecoveryDocumentUpdate {
  documentId: string
  content: string
  dirty: boolean
  viewMode: ViewMode
  cursor: number
  scrollTop: number
}

export interface RecoveryLayoutUpdate {
  documentIds: string[]
  activeId: string | null
}

export interface ExternalChange {
  documentId: string
  kind: ExternalChangeKind
  revision: string | null
}

export type AppCommand =
  | 'new-text'
  | 'new-markdown'
  | 'open'
  | 'save'
  | 'save-as'
  | 'close'
  | 'undo'
  | 'redo'
  | 'find'
  | 'replace'
  | 'view-source'
  | 'view-split'
  | 'view-preview'
  | 'settings'

export interface MenuContextUpdate {
  locale: 'ko' | 'en'
  hasDocument: boolean
  markdown: boolean
  viewMode: ViewMode
}

export interface AssetPayload {
  mimeType: string
  dataUrl: string
}

export interface DocumentError {
  code: string
  message: string
}
