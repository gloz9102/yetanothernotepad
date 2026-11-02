import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePreference = 'system' | 'light' | 'dark'
export type LocalePreference = 'system' | 'ko' | 'en'

interface SettingsState {
  theme: ThemePreference
  locale: LocalePreference
  wordWrap: boolean
  fontSize: number
  splitRatio: number
  setTheme: (theme: ThemePreference) => void
  setLocale: (locale: LocalePreference) => void
  setWordWrap: (wordWrap: boolean) => void
  setFontSize: (fontSize: number) => void
  setSplitRatio: (splitRatio: number) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      locale: 'system',
      wordWrap: true,
      fontSize: 15,
      splitRatio: 50,
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setFontSize: (fontSize) =>
        set({ fontSize: Math.min(24, Math.max(11, fontSize)) }),
      setSplitRatio: (splitRatio) =>
        set({ splitRatio: Math.min(75, Math.max(25, splitRatio)) }),
    }),
    {
      name: 'yet-another-notepad-settings',
    },
  ),
)
