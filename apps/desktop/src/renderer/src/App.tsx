import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Toaster } from 'sonner'
import type { OverlayState } from '@shared/types'
import { Shell, type Route } from './components/Shell'
import { Logo } from './components/Shell'
import { TooltipProvider } from './components/ui/misc'
import { CloudProvider, useCloud } from './hooks/useCloud'
import { SettingsProvider, useSettingsMaybe } from './hooks/useSettings'
import { UpdatesProvider } from './hooks/useUpdates'
import { AccountPage } from './pages/Account'
import { AccountGate } from './pages/AccountGate'
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
  'general',
  'account'
])

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <CloudProvider>
        <UpdatesProvider>
          <TooltipProvider delayDuration={300}>
            <Root />
            <Toaster
              position="bottom-right"
              richColors
              closeButton
              toastOptions={{ className: 'text-sm' }}
            />
          </TooltipProvider>
        </UpdatesProvider>
      </CloudProvider>
    </SettingsProvider>
  )
}

function Root(): React.JSX.Element | null {
  const { settings, info } = useSettingsMaybe()
  const cloud = useCloud()
  const [route, setRoute] = useState<Route>('home')
  const [state, setState] = useState<OverlayState>({ phase: 'idle' })
  const [enabled, setEnabled] = useState(true)
  const [dark, setDark] = useState(false)

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
      const isDark =
        settings.general.theme === 'dark' || (settings.general.theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', isDark)
      setDark(isDark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings])

  if (!settings || !cloud.config) return null

  const mode = cloud.config.accountMode
  const accountWanted =
    mode === 'required' || (mode === 'optional' && !settings.cloud.accountSkipped)
  if (accountWanted && !cloud.clerk.signedIn) {
    // Offline but previously signed in on this device: keep dictating from the local mirror.
    const offlineFallback = cloud.clerk.failed && !!settings.cloud.lastSignedInUserId
    if (!offlineFallback) {
      if (!cloud.clerk.loaded && !cloud.clerk.failed) return <Splash />
      return (
        <AccountGate
          mode={mode}
          clerk={cloud.clerk}
          platform={info?.platform}
          dark={dark}
          onSkip={mode === 'optional' ? () => void window.murmur.cloud.skipAccount() : undefined}
        />
      )
    }
  }

  if (!settings.onboardingComplete) return <Onboarding />

  return (
    <Shell
      route={route}
      onNavigate={setRoute}
      state={state}
      enabled={enabled}
      platform={info?.platform ?? 'linux'}
      showAccount={cloud.enabled}
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
      {route === 'account' && cloud.enabled && <AccountPage />}
    </Shell>
  )
}

function Splash(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <Logo className="size-10 rounded-xl [&>svg]:size-6" />
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Starting Murmur…
      </div>
    </div>
  )
}
