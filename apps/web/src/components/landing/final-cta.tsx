import { ButtonLink } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { billingEnabled } from '@/lib/env'
import { VoiceWave } from './voice-wave'

export function FinalCta() {
  return (
    <Section className="pt-4 sm:pt-8">
      <div className="night-band rounded-2xl px-card py-14 text-center sm:py-20">
        <div className="aurora opacity-80" aria-hidden="true" />
        <VoiceWave className="top-1/2 -translate-y-1/2 opacity-40" />
        <h2 className="serif-display mx-auto max-w-2xl text-title text-balance sm:text-display">
          Start dictating in <em className="brand-text italic">about a minute.</em>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lead text-night-muted">
          Download, hold the shortcut, say something. Connect a model of your own or sign in for
          Murmur’s{billingEnabled ? '; the free tier needs no card' : ''}.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/download" variant="brand" size="lg">
            Download Murmur
          </ButtonLink>
          {billingEnabled ? (
            <ButtonLink
              href="/pricing"
              variant="ghost"
              size="lg"
              className="bg-white/8 text-night-foreground hover:bg-white/14 hover:text-white"
            >
              See pricing
            </ButtonLink>
          ) : (
            <ButtonLink
              href="/account"
              variant="ghost"
              size="lg"
              className="bg-white/8 text-night-foreground hover:bg-white/14 hover:text-white"
            >
              Your account
            </ButtonLink>
          )}
        </div>
      </div>
    </Section>
  )
}
