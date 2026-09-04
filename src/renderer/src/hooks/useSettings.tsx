import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { AppInfo } from '@shared/types'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends Array<unknown>
      ? T[K]
      : DeepPartial<T[K]>
    : T[K]
}
export type SettingsPatch = DeepPartial<Settings>

interface Ctx {
  settings: Settings | null
  info: AppInfo | null
  patch: (p: SettingsPatch) => Promise<void>
  refreshInfo: () => Promise<void>
}

const SettingsContext = createContext<Ctx | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  const refreshInfo = useCallback(async () => setInfo(await window.murmur.app.info()), [])

  useEffect(() => {
    void window.murmur.settings.get().then(setSettings)
    void refreshInfo()
    return window.murmur.settings.onChange(setSettings)
  }, [refreshInfo])

  const patch = useCallback(async (p: SettingsPatch) => {
    // Optimistic local merge so controls feel instant; the authoritative copy arrives via onChange.
    setSettings((prev) => (prev ? (merge(prev, p) as Settings) : prev))
    await window.murmur.settings.patch(p)
  }, [])

  const value = useMemo(
    () => ({ settings, info, patch, refreshInfo }),
    [settings, info, patch, refreshInfo]
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

function merge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) return patch
  if (
    patch &&
    typeof patch === 'object' &&
    base &&
    typeof base === 'object' &&
    !Array.isArray(base)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = merge(out[k], v)
    return out
  }
  return patch === undefined ? base : patch
}

export function useSettings(): Ctx & { settings: Settings } {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings outside provider')
  if (!ctx.settings) throw new Error('settings not loaded')
  return ctx as Ctx & { settings: Settings }
}

export function useSettingsMaybe(): Ctx {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings outside provider')
  return ctx
}
