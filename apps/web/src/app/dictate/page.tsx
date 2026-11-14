import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import { AccountProviders } from '@/components/account/providers'
import { AccountUnavailable } from '@/components/account/unavailable'
import { DictateView } from '@/components/dictate/dictate-view'
import { PageHeader, Section } from '@/components/ui/section'
import { accountsSetup, clerkPublishableKey, convexUrl } from '@/lib/env'

export const metadata: Metadata = {
  title: 'Dictate',
  description:
    'Murmur in the browser: hold the shortcut, speak, and copy the text. Your account, dictionary and formatting settings, installable as an app.',
  manifest: '/dictate.webmanifest',
  appleWebApp: { capable: true, title: 'Murmur', statusBarStyle: 'default' },
  icons: { apple: '/dictate/apple-touch-icon.png' }
}

/*
 * Murmur's web dictation (an installable PWA scoped to /dictate): the same sign-in, gateway,
 * dictionary, snippets and synced formatting settings as the desktop and Android apps. Like the
 * account and microphone pages, Clerk and Convex load here only.
 */
export default function DictatePage() {
  const setup = accountsSetup()
  return (
    <Section className="dictate-section">
      <div className="dictate-header">
        <PageHeader
          eyebrow="Dictate"
          title="Speak, then copy."
          lede="Murmur in your browser. Install it as an app, or keep a small window open next to your work."
        />
      </div>
      <div className="dictate-body mx-auto mt-section max-w-2xl">
        {setup.configured ? (
          <ClerkProvider
            publishableKey={clerkPublishableKey}
            appearance={{
              variables: {
                colorPrimary: '#2b2926',
                borderRadius: '0.75rem',
                fontFamily: 'var(--font-sans)'
              }
            }}
          >
            <AccountProviders convexUrl={convexUrl}>
              <DictateView />
            </AccountProviders>
          </ClerkProvider>
        ) : (
          <AccountUnavailable setup={setup} />
        )}
      </div>
    </Section>
  )
}
