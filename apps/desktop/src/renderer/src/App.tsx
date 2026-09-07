import React, { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Loader2 } from 'lucide-react'
import { Toaster } from 'sonner'
import type { OverlayState } from '@shared/types'
import { Shell, type Route } from './components/Shell'
import { Logo } from './components/Shell'
import { TooltipProvider } from './components/ui/misc'
import { CloudProvider, useCloud } from './hooks/useCloud'
import { SettingsProvider, useSettingsMaybe } from './hooks/useSettings'
import { ThemeProvider } from './hooks/useTheme'
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
      <ThemeProvider>
        <CloudProvider>
          <UpdatesProvider>
            <TooltipProvider delayDuration={300}>
              <MotionConfig reducedMotion="user">
                <Root />
              </MotionConfig>
              <Toaster
                position="bottom-right"
                richColors
                closeButton
                toastOptions={{ className: 'text-sm' }}
              />
            </TooltipProvider>
          </UpdatesProvider>
        </CloudProvider>
      </ThemeProvider>
    </SettingsProvider>
  )
}

/** The screen the app is on before (or instead of) the shell. */
type Stage = 'splash' | 'gate' | 'onboarding' | 'shell'

function Root(): React.JSX.Element | null {
  const { settings, info } = useSettingsMaybe()
  const cloud = useCloud()
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

  if (!settings || !cloud.config) return null

  const mode = cloud.config.accountMode
  const accountWanted =
    mode === 'required' || (mode === 'optional' && !settings.cloud.accountSkipped)
  let stage: Stage = 'shell'
  if (accountWanted && !cloud.clerk.signedIn) {
    // Offline but previously signed in on this device: keep dictating from the local mirror.
    const offlineFallback = cloud.clerk.failed && !!settings.cloud.lastSignedInUserId
    if (!offlineFallback) stage = !cloud.clerk.loaded && !cloud.clerk.failed ? 'splash' : 'gate'
  }
  if (stage === 'shell' && !settings.onboardingComplete) stage = 'onboarding'

  // The big moves (signing in, finishing setup) dissolve from one screen to the next.
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stage}
        className="h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.24, ease: 'easeOut' } }}
        exit={{ opacity: 0, transition: { duration: 0.16, ease: 'easeIn' } }}
      >
        {stage === 'splash' && <Splash />}
        {stage === 'gate' && (
          <AccountGate
            mode={mode}
            clerk={cloud.clerk}
            platform={info?.platform}
            onSkip={mode === 'optional' ? () => void window.murmur.cloud.skipAccount() : undefined}
          />
        )}
        {stage === 'onboarding' && <Onboarding />}
        {stage === 'shell' && (
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
        )}
      </motion.div>
    </AnimatePresence>
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
