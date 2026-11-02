import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStatusStore } from '../stores/editorStatusStore'
import type { LineRange } from '../types'
import { MarkdownPreview } from './MarkdownPreview'

const { openUrl, readLocalAsset } = vi.hoisted(() => ({
  openUrl: vi.fn(),
  readLocalAsset: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))
vi.mock('../lib/api', () => ({
  documentApi: { readLocalAsset },
}))

describe('MarkdownPreview', () => {
  beforeEach(() => {
    openUrl.mockReset().mockResolvedValue(undefined)
    readLocalAsset.mockReset()
  })

  it('renders GFM without rendering raw HTML', () => {
    render(
      <MarkdownPreview
        documentId="document-1"
        content={
          '- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>'
        }
      />,
    )

    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('table')).toBeVisible()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.queryByText('alert(1)')).toBeNull()
  })

  it('blocks javascript links and remote images', () => {
    render(
      <MarkdownPreview
        documentId="document-1"
        content={
          '[unsafe](javascript:alert(1))\n\n![tracking](https://example.com/pixel.png)'
        }
      />,
    )

    const unsafeLink = screen.getByText('unsafe').closest('a')
    expect(unsafeLink).not.toBeNull()
    expect(unsafeLink).not.toHaveAttribute('href', 'javascript:alert(1)')
    fireEvent.click(unsafeLink!)
    expect(openUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
    expect(readLocalAsset).not.toHaveBeenCalled()
  })

  it('opens only permitted external links with the OS opener', () => {
    render(
      <MarkdownPreview
        documentId="document-1"
        content="[site](https://example.com)"
      />,
    )

    fireEvent.click(screen.getByRole('link', { name: 'site' }))
    expect(openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('reports an OS opener failure to the error dialog owner', async () => {
    const onError = vi.fn()
    openUrl.mockRejectedValue(new Error('No handler'))
    render(
      <MarkdownPreview
        documentId="document-1"
        content="[mail](mailto:test@example.com)"
        onError={onError}
      />,
    )
    fireEvent.click(screen.getByRole('link', { name: 'mail' }))
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'No handler' }),
      ),
    )
  })

  it('loads relative images through the Rust asset command', async () => {
    readLocalAsset.mockResolvedValue({
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
    })
    render(
      <MarkdownPreview
        documentId="document-1"
        content="![diagram](assets/diagram.png)"
      />,
    )

    await waitFor(() =>
      expect(readLocalAsset).toHaveBeenCalledWith(
        'document-1',
        'assets/diagram.png',
      ),
    )
    expect(await screen.findByRole('img', { name: 'diagram' })).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2U=',
    )
  })

  it('rejects malformed encoded image paths without invoking Rust', () => {
    render(
      <MarkdownPreview
        documentId="document-1"
        content="![broken](assets/%E0%A4%A.png)"
      />,
    )

    expect(screen.queryByRole('img')).toBeNull()
    expect(readLocalAsset).not.toHaveBeenCalled()
  })

  it('supports safe links to headings inside the preview', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(
      <MarkdownPreview
        documentId="document-1"
        content={'[Jump](#section)\n\n## Section'}
      />,
    )

    fireEvent.click(screen.getByRole('link', { name: 'Jump' }))
    expect(document.getElementById('user-content-section')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(openUrl).not.toHaveBeenCalled()
  })
})

describe('MarkdownPreview source line linking', () => {
  const source = [
    '# Title',
    '',
    'Para one',
    'continues',
    '',
    '- item',
    '  - nested',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```',
    'code',
    '```',
  ].join('\n')
  const blocks = () =>
    [...document.querySelectorAll<HTMLElement>('[data-source-start]')].map(
      (block) =>
        `${block.tagName.toLowerCase()} ${block.dataset.sourceStart}-${block.dataset.sourceEnd}`,
    )
  const linked = () =>
    [...document.querySelectorAll('.source-linked')].map((block) =>
      block.tagName.toLowerCase(),
    )
  const selectLines = (selectedLines: LineRange[]) =>
    act(() =>
      useEditorStatusStore.getState().update('linked', {
        line: 1,
        column: 1,
        characters: source.length,
        selectedLines,
      }),
    )

  beforeEach(() => useEditorStatusStore.getState().reset())

  it('tags rendered blocks with their source lines', () => {
    render(<MarkdownPreview documentId="linked" content={source} />)
    expect(blocks()).toEqual([
      'h1 1-1',
      'p 3-4',
      'li 6-6',
      'li 7-7',
      'tr 9-9',
      'tr 11-11',
      'pre 13-15',
    ])
  })

  it('highlights blocks covering the editor selection only when linked', () => {
    const { rerender } = render(
      <MarkdownPreview documentId="linked" content={source} />,
    )
    selectLines([{ first: 4, last: 7 }])
    expect(linked()).toEqual([])

    rerender(
      <MarkdownPreview
        documentId="linked"
        content={source}
        onSourceLinesSelect={() => {}}
      />,
    )
    expect(linked()).toEqual(['p', 'li', 'li'])

    selectLines([{ first: 14, last: 14 }])
    expect(linked()).toEqual(['pre'])
  })

  it('reports the source lines of the selected preview blocks', () => {
    const onSourceLinesSelect = vi.fn()
    render(
      <MarkdownPreview
        documentId="linked"
        content={source}
        onSourceLinesSelect={onSourceLinesSelect}
      />,
    )
    const article = screen.getByTestId('markdown-preview')
    const select = (start: Node, end: Node = start) => {
      const range = document.createRange()
      range.setStart(start, 0)
      range.setEnd(end, end.textContent?.length ?? 0)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      fireEvent.mouseUp(article)
    }

    select(screen.getByText('nested').firstChild!)
    expect(onSourceLinesSelect).toHaveBeenLastCalledWith({ first: 7, last: 7 })

    select(
      screen.getByText('Title').firstChild!,
      screen.getByText(/Para one/).firstChild!,
    )
    expect(onSourceLinesSelect).toHaveBeenLastCalledWith({ first: 1, last: 4 })

    document.getSelection()?.collapse(article, 0)
    fireEvent.mouseUp(article)
    expect(onSourceLinesSelect).toHaveBeenLastCalledWith(null)
  })
})
