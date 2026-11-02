import type { DocumentSnapshot } from '../types'
import { useCallback, useState } from 'react'
import i18n from '../i18n'

export function mergeDocumentMessages(
  previous: string | null,
  message: string,
) {
  return [
    ...new Set(
      [...(previous?.split('\n') ?? []), ...message.split('\n')].filter(
        Boolean,
      ),
    ),
  ].join('\n')
}

// Separate IPC channels can deliver partial-open errors and warnings in either order.
export function useDocumentMessages() {
  const [errorMessage, setMessage] = useState<string | null>(null)
  const setErrorMessage = useCallback((message: string) => {
    setMessage((previous) => mergeDocumentMessages(previous, message))
  }, [])
  const dismissError = useCallback(() => setMessage(null), [])
  return { errorMessage, setErrorMessage, dismissError }
}

export function showDocumentWarnings(
  documents: readonly Pick<DocumentSnapshot, 'warnings'>[],
  showMessage: (message: string) => void,
) {
  const warnings = [
    ...new Set(
      documents
        .flatMap((document) => document.warnings ?? [])
        .map((warning) =>
          typeof warning === 'string'
            ? warning
            : i18n.t('fileMonitoringFailed', { details: warning.details }),
        ),
    ),
  ]
  if (warnings.length) showMessage(warnings.join('\n'))
}
