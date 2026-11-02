import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useSettingsStore,
  type LocalePreference,
  type ThemePreference,
} from '../stores/settingsStore'

interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation()
  const settings = useSettingsStore()
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    panelRef.current?.querySelector<HTMLElement>('select, input')?.focus()
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <aside
      className="settings-panel"
      id="settings-panel"
      ref={panelRef}
      aria-label={t('settings')}
    >
      <h2>{t('settings')}</h2>
      <label>
        <span>{t('theme')}</span>
        <select
          value={settings.theme}
          onChange={(event) =>
            settings.setTheme(event.target.value as ThemePreference)
          }
        >
          <option value="system">{t('themeSystem')}</option>
          <option value="light">{t('themeLight')}</option>
          <option value="dark">{t('themeDark')}</option>
        </select>
      </label>
      <label>
        <span>{t('language')}</span>
        <select
          value={settings.locale}
          onChange={(event) =>
            settings.setLocale(event.target.value as LocalePreference)
          }
        >
          <option value="system">{t('languageSystem')}</option>
          <option value="ko">{t('korean')}</option>
          <option value="en">{t('english')}</option>
        </select>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.wordWrap}
          onChange={(event) => settings.setWordWrap(event.target.checked)}
        />
        <span>{t('wordWrap')}</span>
      </label>
      <label>
        <span>{t('fontSize')}</span>
        <input
          type="number"
          min="11"
          max="24"
          value={settings.fontSize}
          onChange={(event) => settings.setFontSize(Number(event.target.value))}
        />
      </label>
    </aside>
  )
}
