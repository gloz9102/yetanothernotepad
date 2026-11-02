import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { DocumentClose } from '../hooks/useDocumentClose'
import { useDocumentStore } from '../stores/documentStore'
import { ConfirmDialog, ErrorDialog, UnsavedDialog } from './Dialogs'

interface AppDialogsProps {
  close: DocumentClose
  errorMessage: string | null
  dismissError: () => void
}

export function AppDialogs({
  close,
  errorMessage,
  dismissError,
}: AppDialogsProps) {
  const { t } = useTranslation()
  const {
    pendingClose,
    pendingDestructive,
    handlePendingSave,
    handlePendingDiscard,
    cancelPendingClose,
    executeDestructive,
    cancelDestructive,
  } = close
  const closeDocuments = useDocumentStore(
    useShallow((state) =>
      pendingClose
        ? pendingClose.documentIds
            .map((id) => state.documentsById[id])
            .filter(Boolean)
        : [],
    ),
  )
  const singleCloseName =
    closeDocuments.length === 1 ? closeDocuments[0].displayName : undefined
  return (
    <>
      {pendingClose && (
        <UnsavedDialog
          count={closeDocuments.filter((document) => document.dirty).length}
          documentName={singleCloseName}
          onSave={() => void handlePendingSave()}
          onDiscard={() => void handlePendingDiscard()}
          onCancel={cancelPendingClose}
        />
      )}
      {pendingDestructive && (
        <ConfirmDialog
          title={
            pendingDestructive.kind === 'reload'
              ? t('reloadConfirmTitle')
              : t('overwriteConfirmTitle')
          }
          message={
            pendingDestructive.kind === 'reload'
              ? t('reloadConfirmMessage')
              : t('overwriteConfirmMessage')
          }
          confirmLabel={
            pendingDestructive.kind === 'reload' ? t('reload') : t('overwrite')
          }
          danger
          onConfirm={() => void executeDestructive()}
          onCancel={cancelDestructive}
        />
      )}
      {errorMessage && (
        <ErrorDialog message={errorMessage} onClose={dismissError} />
      )}
    </>
  )
}
