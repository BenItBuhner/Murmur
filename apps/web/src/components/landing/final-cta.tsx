import { ButtonLink } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { billingEnabled } from '@/lib/env'

export function FinalCta() {
  return (
    <Section className="pt-4 sm:pt-8">
      <Surface className="py-12 text-center sm:py-16">
        <h2 className="serif-display mx-auto max-w-2xl text-title text-balance sm:text-display">
          Start dictating in about a minute.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lead text-muted-foreground">
          Download, hold the shortcut, say something. Connect a model of your own or sign in for
          Murmur’s{billingEnabled ? '; the free tier needs no card' : ''}.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/download" size="lg">
            Download Murmur
          </ButtonLink>
          {billingEnabled ? (
            <ButtonLink href="/pricing" variant="tonal" size="lg">
              See pricing
            </ButtonLink>
          ) : (
            <ButtonLink href="/account" variant="tonal" size="lg">
              Your account
            </ButtonLink>
          )}
        </div>
      </Surface>
    </Section>
  )
}
