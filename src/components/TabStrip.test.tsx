import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import type { DocumentTab } from '../types'
import { TabStrip } from './TabStrip'

function tab(id: string): DocumentTab {
  return {
    id,
    displayName: `${id}.txt`,
    path: null,
    kind: 'text',
    content: '',
    encoding: 'utf8',
    lineEnding: 'none',
    revision: '',
    readOnly: false,
    normalizationWarning: false,
    dirty: false,
    viewMode: 'source',
    externalChange: null,
    byteLength: 0,
    lastMarkdownViewMode: 'split',
  }
}

describe('TabStrip', () => {
  beforeEach(async () => i18n.changeLanguage('en'))

  it('uses roving tabindex and activates tabs with arrow keys', () => {
    const onActivate = vi.fn()
    render(
      <TabStrip
        documents={[tab('one'), tab('two')]}
        activeId="one"
        onActivate={onActivate}
        onClose={vi.fn()}
        onCloseMany={vi.fn()}
      />,
    )

    const [first, second] = screen.getAllByRole('tab')
    expect(first).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(onActivate).toHaveBeenCalledWith('two')
  })

  it('offers close actions from the context menu', () => {
    const onCloseMany = vi.fn()
    render(
      <TabStrip
        documents={[tab('one'), tab('two')]}
        activeId="one"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseMany={onCloseMany}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('tab', { name: /one.txt/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Others' }))
    expect(onCloseMany).toHaveBeenCalledWith(['two'])
  })
})
