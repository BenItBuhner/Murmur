import React, { useState } from 'react'
import { ClerkLoaded, ClerkLoading, SignIn, SignUp } from '@clerk/electron/react'
import { BookA, Check, KeyRound, Loader2, RefreshCw, Smartphone, WifiOff, Zap } from 'lucide-react'
import type { AccountMode } from '@shared/cloud'
import { Button } from '@renderer/components/ui/button'
import { Segmented } from '@renderer/components/ui/misc'
import { Logo } from '@renderer/components/Shell'
import { clerkAppearance, type ClerkView } from '@renderer/hooks/useCloud'
import { useTheme } from '@renderer/hooks/useTheme'
import { cn } from '@renderer/lib/utils'

type Tab = 'sign-in' | 'sign-up'

interface Props {
  mode: AccountMode
  clerk: ClerkView
  platform?: string
  /** Only offered in `optional` mode. */
  onSkip?: () => void
}

/**
 * The front door of the production instance: nobody reaches onboarding without an account. Clerk
 * renders the actual forms; Murmur supplies the framing, the sign-in/sign-up switch and offline
 * handling.
 */
export function AccountGate({ mode, clerk, platform, onSkip }: Props): React.JSX.Element {
  const [tab, setTabState] = useState<Tab>('sign-up')
  const { theme } = useTheme()
  const appearance = clerkAppearance(theme)
  const setTab = (next: Tab): void => {
    // Both forms use hash routing; drop any in-progress step of the other form when switching.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    setTabState(next)
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex items-center justify-between px-8',
          platform === 'win32' ? 'h-10 drag-region' : 'h-14'
        )}
      >
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Murmur</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        <div className="mx-auto grid max-w-4xl items-start gap-10 pt-6 md:grid-cols-[1fr_400px] animate-fade-in">
          <div className="space-y-6 pt-6">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
              <Logo className="size-9 rounded-xl [&>svg]:size-5" />
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Speak. It types.</h1>
              <p className="mt-2 max-w-md text-[15px] text-muted-foreground">
                Hold one key anywhere on your computer, say what you mean, let go. Murmur
                transcribes it, cleans up the ums and self-corrections, and drops finished text
                right where your cursor is.
              </p>
            </div>
            <div className="grid max-w-md gap-2 text-[13px]">
              {[
                {
                  icon: <BookA className="size-4 text-success" />,
                  text: 'One dictionary for every device you sign in on'
                },
                {
                  icon: <Zap className="size-4 text-success" />,
                  text: 'Snippets, style rules and preferences follow you'
                },
                {
                  icon: <Smartphone className="size-4 text-success" />,
                  text: 'Desktop and Android share the same account'
                },
                {
                  icon: <KeyRound className="size-4 text-success" />,
                  text: 'Speech-model API keys never leave this device'
                }
              ].map((item) => (
                <div
                  key={item.text}
                  className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2"
                >
                  {item.icon} {item.text}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex justify-center">
              <Segmented<Tab>
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'sign-up', label: 'Create account' },
                  { value: 'sign-in', label: 'Sign in' }
                ]}
              />
            </div>
            {clerk.failed ? (
              <OfflineCard />
            ) : (
              <>
                <ClerkLoading>
                  <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-xl border bg-card text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" /> Connecting to Murmur…
                  </div>
                </ClerkLoading>
                <ClerkLoaded>
                  {tab === 'sign-in' ? (
                    <SignIn routing="hash" appearance={appearance} />
                  ) : (
                    <SignUp routing="hash" appearance={appearance} />
                  )}
                </ClerkLoaded>
              </>
            )}
            {mode === 'optional' && onSkip && (
              <div className="text-center">
                <Button variant="link" size="sm" onClick={onSkip}>
                  Continue without an account
                </Button>
                <p className="text-[12px] text-muted-foreground">
                  Everything stays on this device. You can sign in later from Account.
                </p>
              </div>
            )}
            <p className="px-2 text-center text-[12px] text-muted-foreground">
              <Check className="mr-1 inline size-3" />
              Your account holds your dictionary, snippets and style. Recordings are sent only to
              the speech model you configure.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function OfflineCard(): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-xl border bg-card px-6 py-8 text-center">
      <WifiOff className="mx-auto size-6 text-muted-foreground" />
      <div className="text-sm font-medium">Can&apos;t reach Murmur sign-in</div>
      <p className="text-[13px] text-muted-foreground">
        Check your connection and try again. If you have signed in on this computer before, your
        dictionary keeps working offline once you are back in.
      </p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        <RefreshCw /> Try again
      </Button>
    </div>
  )
}
