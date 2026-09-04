import React, { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import type { OverlayState } from '@shared/types'
import { Shell, type Route } from './components/Shell'
import { TooltipProvider } from './components/ui/misc'
import { SettingsProvider, useSettingsMaybe } from './hooks/useSettings'
import { AudioPage } from './pages/Audio'
import { DictionaryPage } from './pages/Dictionary'
import { GeneralPage } from './pages/General'
import { HistoryPage } from './pages/History'
import { HomePage } from './pages/Home'
import { Onboarding } from './pages/Onboarding'
import { ProvidersPage } from './pages/Providers'
import { ShortcutsPage } from './pages/Shortcuts'
import { SnippetsPage } from './pages/Snippets'
import { StylePage } from './pages/Style'

const ROUTES = new Set<Route>([
  'home',
  'history',
  'dictionary',
  'snippets',
  'style',
  'shortcuts',
  'audio',
  'providers',
  'general'
])

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <TooltipProvider delayDuration={300}>
        <Root />
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ className: 'text-sm' }}
        />
      </TooltipProvider>
    </SettingsProvider>
  )
}

function Root(): React.JSX.Element | null {
  const { settings, info } = useSettingsMaybe()
  const [route, setRoute] = useState<Route>('home')
  const [state, setState] = useState<OverlayState>({ phase: 'idle' })
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const unsubs = [
      window.murmur.dictation.onState((e) => setState(e.state)),
      window.murmur.app.onEnabledChanged(setEnabled),
      window.murmur.app.onNavigate((r) => ROUTES.has(r as Route) && setRoute(r as Route))
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // Theme: follow the setting, or the OS when set to system.
  useEffect(() => {
    if (!settings) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark =
        settings.general.theme === 'dark' || (settings.general.theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings])

  if (!settings) return null
  if (!settings.onboardingComplete) return <Onboarding />

  return (
    <Shell
      route={route}
      onNavigate={setRoute}
      state={state}
      enabled={enabled}
      platform={info?.platform ?? 'linux'}
    >
      {route === 'home' && <HomePage state={state} onNavigate={setRoute} />}
      {route === 'history' && <HistoryPage />}
      {route === 'dictionary' && <DictionaryPage />}
      {route === 'snippets' && <SnippetsPage />}
      {route === 'style' && <StylePage />}
      {route === 'shortcuts' && <ShortcutsPage />}
      {route === 'audio' && <AudioPage />}
      {route === 'providers' && <ProvidersPage />}
      {route === 'general' && <GeneralPage />}
    </Shell>
  )
}
