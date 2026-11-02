import { mockIPC } from '@tauri-apps/api/mocks'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DocumentSnapshot, RestoredSession } from '../types'
import { asDocumentError, documentApi } from './api'

const opened: DocumentSnapshot = {
  id: 'document-1',
  displayName: 'note.md',
  path: '/notes/note.md',
  kind: 'markdown',
  content: '# Note',
  encoding: 'utf8',
  lineEnding: 'lf',
  revision: 'revision-1',
  readOnly: false,
  normalizationWarning: false,
}

describe('document IPC', () => {
  beforeEach(() => {
    mockIPC((command, args) => {
      if (command === 'pick_and_open_documents') return [opened]
      if (command === 'save_document') {
        const request = (args as Record<string, unknown>).request as {
          expectedRevision?: string
        }
        if (request.expectedRevision !== opened.revision) {
          throw { code: 'EXTERNAL_CONFLICT', message: 'Disk file changed.' }
        }
        return { ...opened, revision: 'revision-2' }
      }
      if (command === 'restore_session') {
        return {
          documents: [
            {
              document: opened,
              dirty: true,
              viewMode: 'split',
              cursor: 8,
              scrollTop: 20,
              externalChange: false,
            },
          ],
          activeId: opened.id,
        } satisfies RestoredSession
      }
      if (command === 'set_document_kind') {
        return {
          id: opened.id,
          displayName: 'Untitled 1.md',
          kind: 'markdown',
        }
      }
      return null
    })
  })

  it('opens documents through the narrow Rust command surface', async () => {
    await expect(documentApi.openDocuments()).resolves.toEqual([opened])
  })

  it('sends only id, content, and expected revision when saving', async () => {
    await expect(
      documentApi.saveDocument({
        documentId: opened.id,
        content: '# Updated',
        expectedRevision: opened.revision,
      }),
    ).resolves.toMatchObject({ revision: 'revision-2' })
  })

  it('preserves the external conflict error code', async () => {
    try {
      await documentApi.saveDocument({
        documentId: opened.id,
        content: '# Updated',
        expectedRevision: 'stale-revision',
      })
      throw new Error('expected save to reject')
    } catch (error) {
      expect(asDocumentError(error)).toEqual({
        code: 'EXTERNAL_CONFLICT',
        message: 'Disk file changed.',
      })
    }
  })

  it('restores recovery metadata and updates recovery incrementally', async () => {
    await expect(documentApi.restoreSession()).resolves.toMatchObject({
      activeId: opened.id,
      documents: [{ dirty: true, viewMode: 'split', cursor: 8 }],
    })
    await expect(
      documentApi.updateRecoveryDocument({
        documentId: opened.id,
        content: '# Draft',
        dirty: true,
        viewMode: 'split',
        cursor: 7,
        scrollTop: 10,
      }),
    ).resolves.toBeNull()
    await expect(
      documentApi.updateRecoveryLayout({
        documentIds: [opened.id],
        activeId: opened.id,
      }),
    ).resolves.toBeNull()
    await expect(documentApi.cancelExit()).resolves.toBeNull()
  })

  it('changes an unsaved document kind through metadata-only IPC', async () => {
    await expect(
      documentApi.setDocumentKind(opened.id, 'markdown'),
    ).resolves.toEqual({
      id: opened.id,
      displayName: 'Untitled 1.md',
      kind: 'markdown',
    })
  })
})
