import {
  Columns2,
  Eye,
  FilePlus2,
  FolderOpen,
  Save,
  TextCursorInput,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DocumentKind, DocumentTab, ViewMode } from '../types'

interface ToolbarProps {
  document: DocumentTab | null
  onNewText: () => void
  onOpen: () => void
  onSave: () => void
  onDocumentKind: (kind: DocumentKind) => void
  onViewMode: (mode: ViewMode) => void
  richViewDisabled: boolean
}

const viewShortcutPrefix = navigator.userAgent.includes('Mac')
  ? '⌥⌘'
  : 'Ctrl+Alt+'

function ToolButton({
  label,
  shortcut,
  onClick,
  disabled,
  children,
  active,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      className={`tool-button ${active ? 'active' : ''}`}
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function Toolbar({
  document,
  onNewText,
  onOpen,
  onSave,
  onDocumentKind,
  onViewMode,
  richViewDisabled,
}: ToolbarProps) {
  const { t } = useTranslation()
  const markdown = document?.kind === 'markdown'

  return (
    <div className="toolbar" role="toolbar" aria-label={t('mainToolbar')}>
      <div className="toolbar-group">
        <ToolButton label={t('newText')} onClick={onNewText}>
          <FilePlus2 size={17} />
        </ToolButton>
        <ToolButton label={t('open')} onClick={onOpen}>
          <FolderOpen size={17} />
        </ToolButton>
        <ToolButton
          label={t('save')}
          disabled={!document || document.readOnly}
          onClick={onSave}
        >
          <Save size={17} />
        </ToolButton>
      </div>

      {document?.path === null && (
        <div
          className="format-toggle"
          role="group"
          aria-label={t('documentFormat')}
        >
          <button
            type="button"
            className={document.kind === 'text' ? 'active' : ''}
            aria-pressed={document.kind === 'text'}
            onClick={() => onDocumentKind('text')}
          >
            TXT
          </button>
          <button
            type="button"
            className={document.kind === 'markdown' ? 'active' : ''}
            aria-pressed={document.kind === 'markdown'}
            onClick={() => onDocumentKind('markdown')}
          >
            Markdown
          </button>
        </div>
      )}

      {markdown && (
        <div className="toolbar-group view-modes" aria-label={t('viewMode')}>
          <ToolButton
            label={t('source')}
            shortcut={`${viewShortcutPrefix}1`}
            active={document.viewMode === 'source'}
            onClick={() => onViewMode('source')}
          >
            <TextCursorInput size={17} />
          </ToolButton>
          <ToolButton
            label={t('split')}
            shortcut={`${viewShortcutPrefix}2`}
            disabled={richViewDisabled}
            active={document.viewMode === 'split'}
            onClick={() => onViewMode('split')}
          >
            <Columns2 size={17} />
          </ToolButton>
          <ToolButton
            label={t('preview')}
            shortcut={`${viewShortcutPrefix}3`}
            disabled={richViewDisabled}
            active={document.viewMode === 'preview'}
            onClick={() => onViewMode('preview')}
          >
            <Eye size={17} />
          </ToolButton>
        </div>
      )}
    </div>
  )
}
