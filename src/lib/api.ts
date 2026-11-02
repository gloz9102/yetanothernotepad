import { invoke } from '@tauri-apps/api/core'
import type {
  AssetPayload,
  DocumentError,
  DocumentKindUpdate,
  DocumentKind,
  DocumentSnapshot,
  MenuContextUpdate,
  RecoveryDocumentUpdate,
  RecoveryLayoutUpdate,
  RestoredSession,
  SaveDocumentRequest,
} from '../types'

export const documentApi = {
  newDocument: (kind: DocumentKind) =>
    invoke<DocumentSnapshot>('new_document', { kind }),

  openDocuments: () => invoke<DocumentSnapshot[]>('pick_and_open_documents'),

  openDocumentPaths: (paths: string[]) =>
    invoke<DocumentSnapshot[]>('open_document_paths', { paths }),

  setDocumentKind: (documentId: string, kind: DocumentKind) =>
    invoke<DocumentKindUpdate>('set_document_kind', { documentId, kind }),

  saveDocument: (request: SaveDocumentRequest) =>
    invoke<DocumentSnapshot | null>('save_document', { request }),

  saveDocumentAs: (request: SaveDocumentRequest) =>
    invoke<DocumentSnapshot | null>('save_document_as', { request }),

  forceSaveDocument: (request: SaveDocumentRequest) =>
    invoke<DocumentSnapshot | null>('force_save_document', { request }),

  reloadDocument: (documentId: string) =>
    invoke<DocumentSnapshot>('reload_document', { documentId }),

  closeDocument: (documentId: string) =>
    invoke<void>('close_document', { documentId }),

  restoreSession: () => invoke<RestoredSession>('restore_session'),

  updateRecoveryDocument: (request: RecoveryDocumentUpdate) =>
    invoke<void>('update_recovery_document', { request }),

  updateRecoveryLayout: (request: RecoveryLayoutUpdate) =>
    invoke<void>('update_recovery_layout', { request }),

  updateMenuContext: (request: MenuContextUpdate) =>
    invoke<void>('update_menu_context', { request }),

  cancelExit: () => invoke<void>('cancel_exit'),
  completeExit: () => invoke<void>('complete_exit'),
  exitPending: () => invoke<boolean>('exit_pending'),

  readLocalAsset: (documentId: string, relativePath: string) =>
    invoke<AssetPayload>('read_local_asset', {
      documentId,
      relativePath,
    }),
}

export function asDocumentError(error: unknown): DocumentError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  ) {
    return {
      code: String(error.code),
      message: String(error.message),
    }
  }
  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  }
}
