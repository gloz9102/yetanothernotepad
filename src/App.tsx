import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppDialogs } from './components/AppDialogs'
import { DocumentTabs } from './components/DocumentTabs'
import { DocumentWorkspace } from './components/DocumentWorkspace'
import { ExternalChangeBanner } from './components/ExternalChangeBanner'
import { SettingsPanel } from './components/SettingsPanel'
import { StatusBar } from './components/StatusBar'
import { Toolbar } from './components/Toolbar'
import { useAppAppearance } from './hooks/useAppAppearance'
import { useAppCommands } from './hooks/useAppCommands'
import { useDocumentActions } from './hooks/useDocumentActions'
import { useDocumentClose } from './hooks/useDocumentClose'
import { useDocumentPreview } from './hooks/useDocumentPreview'
import { useDocumentRecovery } from './hooks/useDocumentRecovery'
import { useDocumentRuntime } from './hooks/useDocumentRuntime'
import { useWorkspaceEvents } from './hooks/useWorkspaceEvents'
import { asDocumentError } from './lib/api'
import { previewPolicy } from './lib/documentPolicy'
import { useDocumentStore } from './stores/documentStore'
import './styles.css'

export default function App() {
  const { t } = useTranslation()
  const activeDocument = useDocumentStore((state) =>
    state.activeId ? (state.documentsById[state.activeId] ?? null) : null,
  )
  const hydrated = useDocumentStore((state) => state.hydrated)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const reportError = useCallback((error: unknown) => {
    setErrorMessage(asDocumentError(error).message)
  }, [])
  const dismissError = useCallback(() => setErrorMessage(null), [])
  const toggleSettings = useCallback(() => setSettingsOpen((open) => !open), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const runtime = useDocumentRuntime()
  const recovery = useDocumentRecovery(runtime, reportError)
  const preview = useDocumentPreview(
    recovery.scheduleRecoveryDocument,
    setErrorMessage,
  )
  const actions = useDocumentActions(
    runtime,
    recovery,
    preview.clearManualPreview,
    reportError,
    setErrorMessage,
  )
  const close = useDocumentClose(
    runtime,
    recovery,
    actions,
    preview.clearManualPreview,
    reportError,
  )
  const dispatchCommand = useAppCommands(
    runtime,
    actions,
    close.requestTabClose,
    preview.setViewMode,
    toggleSettings,
  )
  const dropActive = useWorkspaceEvents(runtime, {
    createDocument: actions.createDocument,
    integrateSnapshots: actions.integrateSnapshots,
    reloadFromDisk: actions.reloadFromDisk,
    requestCloseMany: close.requestCloseMany,
    dispatchCommand,
    reportError,
  })
  useAppAppearance(activeDocument)

  if (!hydrated) return <main className="loading-screen">{t('loading')}</main>

  const locked = close.processing || Boolean(close.pendingClose?.window)
  const { previewTooLarge } = previewPolicy(activeDocument?.byteLength ?? 0)

  return (
    <main className="app-shell">
      <div className="interaction-content" inert={locked}>
        <DocumentTabs
          onClose={close.requestTabClose}
          onCloseMany={close.requestCloseMany}
        />
        <Toolbar
          document={activeDocument}
          richViewDisabled={previewTooLarge}
          onNewText={() => void actions.createDocument('text')}
          onOpen={() => void actions.openDocuments()}
          onSave={() =>
            activeDocument && void actions.performSave(activeDocument.id)
          }
          onDocumentKind={(kind) => void actions.changeDocumentKind(kind)}
          onViewMode={preview.setViewMode}
        />
        {settingsOpen && <SettingsPanel onClose={closeSettings} />}
        {activeDocument?.externalChange && (
          <ExternalChangeBanner
            change={activeDocument.externalChange}
            onReload={() => close.requestReload(activeDocument.id)}
            onOverwrite={() => close.requestOverwrite(activeDocument.id)}
            onSaveAs={() =>
              void actions.performSave(activeDocument.id, 'saveAs')
            }
          />
        )}
        <DocumentWorkspace
          activeDocument={activeDocument}
          locked={locked}
          manualPreviews={preview.manualPreviews}
          handleEditorChange={preview.handleEditorChange}
          refreshManualPreview={preview.refreshManualPreview}
          scheduleRecoveryDocument={recovery.scheduleRecoveryDocument}
          reportError={reportError}
        />
        <StatusBar
          document={activeDocument}
          saveStatus={actions.saveStatus}
          onUndoReload={actions.undoReload}
        />
        {dropActive && <div className="drop-overlay">{t('dropFiles')}</div>}
      </div>
      <AppDialogs
        close={close}
        errorMessage={errorMessage}
        dismissError={dismissError}
      />
    </main>
  )
}
