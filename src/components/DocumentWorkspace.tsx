import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useSplitLayout } from '../hooks/useSplitLayout'
import type { DocumentPreview } from '../hooks/useDocumentPreview'
import type { DocumentRecovery } from '../hooks/useDocumentRecovery'
import { previewPolicy } from '../lib/documentPolicy'
import { useSettingsStore } from '../stores/settingsStore'
import type { DocumentTab } from '../types'
import { CodeEditor } from './CodeEditor'
import { MarkdownPreview } from './MarkdownPreview'

interface DocumentWorkspaceProps {
  activeDocument: DocumentTab | null
  locked: boolean
  manualPreviews: DocumentPreview['manualPreviews']
  handleEditorChange: DocumentPreview['handleEditorChange']
  refreshManualPreview: DocumentPreview['refreshManualPreview']
  scheduleRecoveryDocument: DocumentRecovery['scheduleRecoveryDocument']
  reportError: (error: unknown) => void
}

export function DocumentWorkspace({
  activeDocument,
  locked,
  manualPreviews,
  handleEditorChange,
  refreshManualPreview,
  scheduleRecoveryDocument,
  reportError,
}: DocumentWorkspaceProps) {
  const { t } = useTranslation()
  const wordWrap = useSettingsStore((state) => state.wordWrap)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const { previewTooLarge, previewNeedsManual } = previewPolicy(
    activeDocument?.byteLength ?? 0,
  )
  // Line linking needs a preview rendered from the live content.
  const linkSourceLines =
    activeDocument?.viewMode === 'split' && !previewNeedsManual
  const {
    splitRatio,
    previewPaneRef,
    workspaceRef,
    handleEditorScroll,
    handlePreviewScroll,
    handleSeparatorPointerDown,
    handleSourceLinesSelect,
    adjustSplitRatio,
  } = useSplitLayout(activeDocument, linkSourceLines)
  const previewContent = activeDocument
    ? previewNeedsManual
      ? manualPreviews[activeDocument.id]
      : activeDocument.content
    : undefined
  const workspaceStyle = { '--split-ratio': `${splitRatio}%` } as CSSProperties

  return (
    <section
      className={`workspace mode-${activeDocument?.viewMode ?? 'source'}`}
      ref={workspaceRef}
      style={workspaceStyle}
      role="tabpanel"
      id={activeDocument ? `panel-${activeDocument.id}` : undefined}
      aria-labelledby={activeDocument ? `tab-${activeDocument.id}` : undefined}
    >
      {activeDocument && (
        <div
          className={`editor-pane ${activeDocument.viewMode === 'preview' ? 'pane-hidden' : ''}`}
        >
          <CodeEditor
            documentId={activeDocument.id}
            kind={activeDocument.kind}
            readOnly={activeDocument.readOnly || locked}
            wordWrap={wordWrap}
            fontSize={fontSize}
            hidden={activeDocument.viewMode === 'preview'}
            onDocumentChange={handleEditorChange}
            onSessionChange={scheduleRecoveryDocument}
            onScrollFractionChange={handleEditorScroll}
          />
        </div>
      )}

      {activeDocument?.kind === 'markdown' &&
        activeDocument.viewMode === 'split' && (
          <div
            className="split-separator"
            role="separator"
            aria-label={t('splitSeparator')}
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(splitRatio)}
            tabIndex={0}
            onPointerDown={handleSeparatorPointerDown}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                adjustSplitRatio(splitRatio - 5)
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                adjustSplitRatio(splitRatio + 5)
              } else if (event.key === 'Home') {
                event.preventDefault()
                adjustSplitRatio(25)
              } else if (event.key === 'End') {
                event.preventDefault()
                adjustSplitRatio(75)
              }
            }}
          />
        )}

      {activeDocument?.kind === 'markdown' &&
        activeDocument.viewMode !== 'source' && (
          <div
            className="preview-pane"
            ref={previewPaneRef}
            onScroll={handlePreviewScroll}
          >
            {previewTooLarge ? (
              <div className="preview-empty">{t('previewUnavailable')}</div>
            ) : previewNeedsManual && previewContent === undefined ? (
              <div className="preview-manual">
                <p>{t('previewManual')}</p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={refreshManualPreview}
                >
                  {t('refreshPreview')}
                </button>
              </div>
            ) : (
              <>
                {previewNeedsManual && (
                  <div className="preview-refresh-bar">
                    <span>{t('previewManual')}</span>
                    <button type="button" onClick={refreshManualPreview}>
                      {t('refreshPreview')}
                    </button>
                  </div>
                )}
                <MarkdownPreview
                  documentId={activeDocument.id}
                  content={previewContent ?? ''}
                  onError={reportError}
                  onSourceLinesSelect={
                    linkSourceLines ? handleSourceLinesSelect : undefined
                  }
                />
              </>
            )}
          </div>
        )}
    </section>
  )
}
