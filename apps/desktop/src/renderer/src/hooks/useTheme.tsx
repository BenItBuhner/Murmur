import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildTheme,
  resolveSeed,
  type AppearanceSettings,
  type ResolvedTheme,
  type ThemeMode
} from '@shared/theme'
import { applyTheme } from '@renderer/lib/apply-theme'
import { useSettingsMaybe } from './useSettings'

interface Ctx {
  theme: ResolvedTheme
  dark: boolean
  /** `#rrggbb` accent the OS publishes, or null when it has none (used by the appearance settings). */
  systemAccent: string | null
}

const ThemeContext = createContext<Ctx | null>(null)

/** Chromium's `prefers-color-scheme`, which main pins to the user's choice via nativeTheme. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function resolveMode(theme: AppearanceSettings['theme'], systemDark: boolean): ThemeMode {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}

/**
 * Builds the palette from the appearance settings, the OS accent and the OS light/dark state, and
 * keeps <html> in sync. Mount it inside SettingsProvider; before settings load it renders the
 * neutral palette for the current mode so nothing flashes.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { settings } = useSettingsMaybe()
  const systemDark = useSystemDark()
  const [systemAccent, setSystemAccent] = useState<string | null>(null)

  useEffect(() => {
    void window.murmur.theme.systemAccent().then(setSystemAccent)
    return window.murmur.theme.onSystemAccentChanged(setSystemAccent)
  }, [])

  const g = settings?.general
  const themeSetting = g?.theme ?? 'system'
  const accent = g?.accent ?? 'neutral'
  const accentColor = g?.accentColor ?? '#ff5a36'
  const tinted = g?.tintedSurfaces ?? false

  const theme = useMemo(
    () =>
      buildTheme({
        mode: resolveMode(themeSetting, systemDark),
        seed: resolveSeed({ accent, accentColor }, systemAccent),
        tinted
      }),
    [themeSetting, accent, accentColor, tinted, systemAccent, systemDark]
  )

  const loaded = !!g
  const settled = useRef(false)
  useEffect(() => {
    const root = document.documentElement
    // Crossfade between palettes the user picks, not on the initial paint or when the saved
    // settings first replace the neutral placeholder.
    let timer: number | undefined
    if (settled.current) {
      root.classList.add('theme-transition')
      timer = window.setTimeout(() => root.classList.remove('theme-transition'), 320)
    }
    settled.current = loaded
    applyTheme(root, theme)
    void window.murmur.theme.report({
      mode: theme.mode,
      background: theme.hex.background,
      foreground: theme.hex.foreground
    })
    return () => {
      if (timer) window.clearTimeout(timer)
    }
  }, [theme, loaded])

  const value = useMemo<Ctx>(
    () => ({ theme, dark: theme.mode === 'dark', systemAccent }),
    [theme, systemAccent]
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}
