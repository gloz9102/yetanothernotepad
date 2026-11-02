import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { UnsavedDialog } from './Dialogs'

describe('UnsavedDialog', () => {
  it('asks before discarding a dirty tab', () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(
      <UnsavedDialog
        count={1}
        documentName="draft.md"
        onSave={onSave}
        onDiscard={onDiscard}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Save changes to draft.md?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('renders Korean UI after a manual language change', async () => {
    await i18n.changeLanguage('ko')
    render(
      <UnsavedDialog
        count={2}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      '2개 문서에 저장하지 않은 변경 사항이 있습니다.',
    )
    expect(screen.getByRole('button', { name: '모두 저장' })).toBeVisible()
  })

  it('cancels with Escape and exposes an accessible description', async () => {
    await i18n.changeLanguage('en')
    const onCancel = vi.fn()
    render(
      <UnsavedDialog
        count={1}
        documentName="draft.md"
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={onCancel}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleDescription('Save changes to draft.md?')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
