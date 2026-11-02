import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import type { DocumentTab } from '../types'
import { Toolbar } from './Toolbar'

function documentTab(overrides: Partial<DocumentTab> = {}): DocumentTab {
  return {
    id: 'draft',
    displayName: 'Untitled 1.txt',
    path: null,
    kind: 'text',
    content: '# title',
    encoding: 'utf8',
    lineEnding: 'none',
    revision: '',
    readOnly: false,
    normalizationWarning: false,
    dirty: true,
    viewMode: 'source',
    externalChange: null,
    byteLength: 7,
    lastMarkdownViewMode: 'split',
    ...overrides,
  }
}

describe('Toolbar', () => {
  beforeEach(async () => i18n.changeLanguage('en'))

  it('changes the format of an unsaved document', () => {
    const onDocumentKind = vi.fn()
    render(
      <Toolbar
        document={documentTab()}
        onNewText={vi.fn()}
        onOpen={vi.fn()}
        onSave={vi.fn()}
        onDocumentKind={onDocumentKind}
        onViewMode={vi.fn()}
        richViewDisabled={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(onDocumentKind).toHaveBeenCalledWith('markdown')
  })

  it('hides the format toggle for a saved file', () => {
    render(
      <Toolbar
        document={documentTab({ path: '/notes/saved.txt' })}
        onNewText={vi.fn()}
        onOpen={vi.fn()}
        onSave={vi.fn()}
        onDocumentKind={vi.fn()}
        onViewMode={vi.fn()}
        richViewDisabled={false}
      />,
    )

    expect(screen.queryByRole('group', { name: 'Document format' })).toBeNull()
  })
})
