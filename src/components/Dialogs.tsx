import { useEffect, useId, useRef, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ModalDialogProps {
  title: string
  description: string
  onCancel?: () => void
  alert?: boolean
  children: ReactNode
}

function ModalDialog({
  title,
  description,
  onCancel,
  alert = false,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    const onCancelEvent = (event: Event) => {
      event.preventDefault()
      onCancel?.()
    }
    dialog.addEventListener('cancel', onCancelEvent)
    requestAnimationFrame(() => {
      const autofocus = dialog.querySelector<HTMLElement>('[autofocus]')
      const first = dialog.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
      )
      ;(autofocus ?? first)?.focus()
    })
    return () => {
      dialog.removeEventListener('cancel', onCancelEvent)
      previous?.focus()
    }
  }, [onCancel])

  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        className="dialog"
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        role={alert ? 'alertdialog' : 'dialog'}
      >
        <AlertTriangle
          className={`dialog-icon ${alert ? '' : 'warning'}`}
          size={28}
        />
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        {children}
      </dialog>
    </div>
  )
}

interface UnsavedDialogProps {
  count: number
  documentName?: string
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function UnsavedDialog({
  count,
  documentName,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedDialogProps) {
  const { t } = useTranslation()
  return (
    <ModalDialog
      title={t('closeDirtyTitle')}
      description={
        documentName
          ? t('closeDirtyTab', { name: documentName })
          : t('closeDirtyWindow', { count })
      }
      onCancel={onCancel}
    >
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button className="danger-button" type="button" onClick={onDiscard}>
          {documentName ? t('discard') : t('discardAll')}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={onSave}
          autoFocus
        >
          {documentName ? t('save') : t('saveAll')}
        </button>
      </div>
    </ModalDialog>
  )
}

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <ModalDialog title={title} description={message} onCancel={onCancel}>
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button
          className={danger ? 'danger-button' : 'primary-button'}
          type="button"
          onClick={onConfirm}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </ModalDialog>
  )
}

interface ErrorDialogProps {
  message: string
  onClose: () => void
}

export function ErrorDialog({ message, onClose }: ErrorDialogProps) {
  const { t } = useTranslation()
  return (
    <ModalDialog
      title={t('errorTitle')}
      description={message}
      onCancel={onClose}
      alert
    >
      <div className="dialog-actions">
        <button
          className="primary-button"
          type="button"
          onClick={onClose}
          autoFocus
        >
          {t('dismiss')}
        </button>
      </div>
    </ModalDialog>
  )
}
