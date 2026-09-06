import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ClerkProvider, useAuth, useUser } from '@clerk/electron/react'
import type { CloudConfig, RendererAuthState, SyncStatus } from '@shared/cloud'

/** How long Clerk may take to load before the UI treats the device as offline. */
const CLERK_LOAD_TIMEOUT_MS = 8000

export interface ClerkView {
  /** Clerk finished loading (session restored or confirmed absent). */
  loaded: boolean
  /** Clerk did not load in time: usually no network. */
  failed: boolean
  signedIn: boolean
  userId?: string
  name?: string
  firstName?: string
  email?: string
  imageUrl?: string
}

interface Ctx {
  config: CloudConfig | null
  status: SyncStatus | null
  clerk: ClerkView
  /** True when this build talks to a cloud instance at all. */
  enabled: boolean
}

const NO_CLERK: ClerkView = { loaded: true, failed: false, signedIn: false }

const CloudContext = createContext<Ctx | null>(null)

/**
 * Owns the renderer half of the cloud integration: mounts Clerk when the main process says a cloud
 * instance is configured, reports the session to main and answers its token requests, and exposes
 * the sync status main broadcasts.
 */
export function CloudProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element | null {
  const [config, setConfig] = useState<CloudConfig | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)

  useEffect(() => {
    void window.murmur.cloud.config().then(setConfig)
    void window.murmur.cloud.status().then(setStatus)
    return window.murmur.cloud.onStatus(setStatus)
  }, [])

  if (!config) return null
  if (config.accountMode === 'off') {
    return (
      <CloudContext.Provider value={{ config, status, clerk: NO_CLERK, enabled: false }}>
        {children}
      </CloudContext.Provider>
    )
  }
  return (
    <ClerkErrorBoundary
      fallback={
        <CloudContext.Provider
          value={{
            config,
            status,
            clerk: { loaded: false, failed: true, signedIn: false },
            enabled: true
          }}
        >
          {children}
        </CloudContext.Provider>
      }
    >
      <ClerkProvider
        publishableKey={config.clerkPublishableKey}
        telemetry={{ disabled: true }}
        afterSignOutUrl="/"
      >
        <ClerkBridge config={config} status={status}>
          {children}
        </ClerkBridge>
      </ClerkProvider>
    </ClerkErrorBoundary>
  )
}

/**
 * Clerk hot-loads its UI bundle from the Frontend API host and may throw while rendering when that
 * host is unreachable. The app must keep working offline, so the failure degrades to the offline
 * state instead of unmounting everything.
 */
class ClerkErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.warn('Clerk failed to initialise; continuing offline', error)
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function ClerkBridge({
  config,
  status,
  children
}: {
  config: CloudConfig
  status: SyncStatus | null
  children: React.ReactNode
}): React.JSX.Element {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth()
  const { user } = useUser()
  const [timedOut, setTimedOut] = useState(false)
  const latest = useRef({ isSignedIn: false, getToken })
  useEffect(() => {
    latest.current = { isSignedIn: !!isSignedIn, getToken }
  }, [isSignedIn, getToken])

  // Offline detection: Clerk that never finishes loading means the sign-in service is unreachable.
  useEffect(() => {
    if (isLoaded) return
    const timer = setTimeout(() => setTimedOut(true), CLERK_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [isLoaded])
  const failed = !isLoaded && timedOut

  const email = user?.primaryEmailAddress?.emailAddress ?? undefined
  const name = user?.fullName ?? undefined
  const firstName = user?.firstName ?? undefined
  const imageUrl = user?.imageUrl ?? undefined

  // Tell the main process who is signed in. Only a loaded Clerk is authoritative: a session that
  // could not be restored because we are offline must not look like a sign-out.
  useEffect(() => {
    if (!isLoaded) return
    const state: RendererAuthState = isSignedIn
      ? { signedIn: true, userId: userId ?? undefined, email, name, imageUrl }
      : { signedIn: false }
    void window.murmur.cloud.reportAuth(state)
  }, [isLoaded, isSignedIn, userId, email, name, imageUrl])

  // Main asks for Convex JWTs (minted from the Clerk JWT template) whenever it needs one.
  useEffect(() => {
    return window.murmur.cloud.onTokenRequest(async ({ id, forceRefresh }) => {
      const { isSignedIn: signedIn, getToken: fetchToken } = latest.current
      if (!signedIn) {
        window.murmur.cloud.respondToken({ id, token: null })
        return
      }
      try {
        const token = await fetchToken({ template: config.jwtTemplate, skipCache: forceRefresh })
        window.murmur.cloud.respondToken({ id, token })
      } catch (err) {
        window.murmur.cloud.respondToken({
          id,
          token: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  }, [config.jwtTemplate])

  const clerk = useMemo<ClerkView>(
    () => ({
      loaded: isLoaded,
      failed,
      signedIn: isLoaded && !!isSignedIn,
      userId: userId ?? undefined,
      name,
      firstName,
      email,
      imageUrl
    }),
    [isLoaded, failed, isSignedIn, userId, name, firstName, email, imageUrl]
  )

  const value = useMemo<Ctx>(
    () => ({ config, status, clerk, enabled: true }),
    [config, status, clerk]
  )
  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}

export function useCloud(): Ctx {
  const ctx = useContext(CloudContext)
  if (!ctx) throw new Error('useCloud outside CloudProvider')
  return ctx
}

/** Colors for Clerk's prebuilt components so they read as part of Murmur. */
export function clerkAppearance(dark: boolean): {
  variables: Record<string, string>
  elements: Record<string, string | Record<string, string>>
} {
  // Same paper and ink as globals.css.
  return {
    variables: {
      colorPrimary: dark ? '#F1EDE6' : '#17151A',
      colorBackground: dark ? '#18171B' : '#FCFBF8',
      colorText: dark ? '#F1EDE6' : '#17151A',
      colorTextSecondary: dark ? '#9B968E' : '#6F6A64',
      colorInputBackground: dark ? '#0F0E10' : '#FCFBF8',
      colorInputText: dark ? '#F1EDE6' : '#17151A',
      colorNeutral: dark ? '#F1EDE6' : '#17151A',
      colorDanger: dark ? '#E98B76' : '#B9463C',
      colorSuccess: dark ? '#86D3A3' : '#3F8F63',
      borderRadius: '0.875rem',
      fontFamily: 'var(--font-sans)',
      fontSize: '14px'
    },
    elements: {
      rootBox: 'w-full',
      cardBox: 'w-full shadow-none border border-border rounded-2xl',
      card: 'shadow-none bg-card px-6 py-6 gap-5',
      headerTitle: 'serif-display text-[26px]',
      headerSubtitle: 'text-[13px]',
      formButtonPrimary: 'h-9 rounded-full text-sm font-medium shadow-none',
      formFieldInput: 'h-9 rounded-xl shadow-none',
      socialButtonsBlockButton: 'h-9 rounded-full shadow-none',
      // Murmur switches between sign in and sign up with its own tabs.
      footerAction: { display: 'none' }
    }
  }
}
