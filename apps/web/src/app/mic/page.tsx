import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import { AccountProviders } from '@/components/account/providers'
import { AccountUnavailable } from '@/components/account/unavailable'
import { MicView } from '@/components/mic/mic-view'
import { PageHeader, Section } from '@/components/ui/section'
import { accountsSetup, clerkPublishableKey, convexUrl } from '@/lib/env'

export const metadata: Metadata = {
  title: 'Phone microphone',
  description:
    'Use your phone as the microphone for Murmur on your computer: talk anywhere in the room and the text lands at the cursor.',
  robots: { index: false }
}

/*
 * The phone end of "Phone as microphone" (docs/phone-microphone.md), for any phone with a browser.
 * Like the account page, Clerk and Convex load here only.
 */
export default function MicPage() {
  const setup = accountsSetup()
  return (
    <Section>
      <PageHeader
        eyebrow="Phone microphone"
        title="Talk from anywhere in the room."
        lede="Your phone becomes the microphone for Murmur on your computer. The text lands wherever the cursor is there."
      />
      <div className="mx-auto mt-section max-w-md">
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
              <MicView />
            </AccountProviders>
          </ClerkProvider>
        ) : (
          <AccountUnavailable setup={setup} />
        )}
      </div>
    </Section>
  )
}
