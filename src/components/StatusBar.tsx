import { useTranslation } from 'react-i18next'
import { useEditorStatusStore } from '../stores/editorStatusStore'
import type { DocumentTab } from '../types'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'reloaded'

interface StatusBarProps {
  document: DocumentTab | null
  saveStatus: SaveStatus
  onUndoReload: () => void
}

const encodingLabels = {
  utf8: 'UTF-8',
  utf8Bom: 'UTF-8 BOM',
  utf16Le: 'UTF-16 LE',
  utf16Be: 'UTF-16 BE',
  cp949: 'CP949',
}

export function StatusBar({
  document,
  saveStatus,
  onUndoReload,
}: StatusBarProps) {
  const { t } = useTranslation()
  const editorStatus = useEditorStatusStore((state) =>
    document ? state.byDocumentId[document.id] : undefined,
  )
  if (!document) return <div className="status-bar" />

  const words = document.content.trim()
    ? document.content.trim().split(/\s+/u).length
    : 0
  const lineEndingLabel =
    document.lineEnding === 'mixed'
      ? t('mixed')
      : document.lineEnding === 'none'
        ? '—'
        : document.lineEnding.toUpperCase()

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <span>{document.kind === 'markdown' ? 'Markdown' : t('plainText')}</span>
      {document.readOnly && <span>{t('readOnly')}</span>}
      {saveStatus !== 'idle' && (
        <span className={`save-status ${saveStatus}`}>
          {saveStatus === 'reloaded' ? (
            <>
              {t('reloadedStatus')}
              <button type="button" onClick={onUndoReload}>
                {t('undo')}
              </button>
            </>
          ) : (
            t(`saveStatus.${saveStatus}`)
          )}
        </span>
      )}
      <span className="status-spacer" />
      <span>{t('words', { count: words })}</span>
      <span>
        {t('characters', {
          count: editorStatus?.characters ?? document.content.length,
        })}
      </span>
      <span>
        {t('lineColumn', {
          line: editorStatus?.line ?? 1,
          column: editorStatus?.column ?? 1,
        })}
      </span>
      <span title={t('lineEnding')}>{lineEndingLabel}</span>
      <span title={t('encoding')}>{encodingLabels[document.encoding]}</span>
    </div>
  )
}
