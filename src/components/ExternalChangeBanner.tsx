import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExternalChangeKind } from '../types'

interface ExternalChangeBannerProps {
  change: ExternalChangeKind
  onReload: () => void
  onOverwrite: () => void
  onSaveAs: () => void
}

export function ExternalChangeBanner({
  change,
  onReload,
  onOverwrite,
  onSaveAs,
}: ExternalChangeBannerProps) {
  const { t } = useTranslation()
  return (
    <div className="external-banner" role="alert">
      <AlertTriangle size={17} />
      <span>
        {change === 'deleted' ? t('externalDeleted') : t('externalModified')}
      </span>
      <span className="banner-spacer" />
      <button type="button" onClick={onReload} disabled={change === 'deleted'}>
        {t('reload')}
      </button>
      <button type="button" onClick={onOverwrite}>
        {t('overwrite')}
      </button>
      <button type="button" onClick={onSaveAs}>
        {t('saveAs')}
      </button>
    </div>
  )
}
