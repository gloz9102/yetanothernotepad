import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { documentApi } from '../lib/api'
import { useSettingsStore } from '../stores/settingsStore'
import type { DocumentTab } from '../types'

export function useAppAppearance(activeDocument: DocumentTab | null) {
  const { t } = useTranslation()
  const theme = useSettingsStore((state) => state.theme)
  const localePreference = useSettingsStore((state) => state.locale)
  const menuHasDocument = Boolean(activeDocument)
  const menuMarkdown = activeDocument?.kind === 'markdown'
  const menuViewMode = activeDocument?.viewMode ?? 'source'
  const dirty = activeDocument?.dirty
  const displayName = activeDocument?.displayName
  const resolvedLocale: 'ko' | 'en' =
    localePreference === 'system'
      ? navigator.language.toLowerCase().startsWith('ko')
        ? 'ko'
        : 'en'
      : localePreference

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const resolved =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [theme])

  useEffect(() => {
    void i18n.changeLanguage(resolvedLocale)
    document.documentElement.lang = resolvedLocale
  }, [resolvedLocale])

  useEffect(() => {
    document.title = menuHasDocument
      ? `${dirty ? '● ' : ''}${displayName} — ${t('appName')}`
      : t('appName')
  }, [menuHasDocument, dirty, displayName, t])

  useEffect(() => {
    void documentApi
      .updateMenuContext({
        locale: resolvedLocale,
        hasDocument: menuHasDocument,
        markdown: menuMarkdown,
        viewMode: menuViewMode,
      })
      .catch((error) => console.error('Failed to update native menu', error))
  }, [menuHasDocument, menuMarkdown, menuViewMode, resolvedLocale])
}
