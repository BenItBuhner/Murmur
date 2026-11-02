import { ButtonLink } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { Mark } from '@/components/wordmark'
import { billingEnabled } from '@/lib/env'

export function FinalCta() {
  return (
    <Section className="pt-4 pb-24 sm:pt-8 sm:pb-32">
      <div className="night-band relative isolate overflow-hidden rounded-[28px] px-6 py-16 text-center sm:py-24">
        <div className="cta-glow" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <Mark
          size={64}
          id="murmur-mark-cta"
          className="mx-auto drop-shadow-[0_18px_40px_rgb(139_92_255/0.55)]"
        />
        <h2 className="display-type mx-auto mt-8 max-w-3xl text-[40px] leading-[1.04] text-balance text-white sm:text-[60px]">
          Start dictating in{' '}
          <em className="accent-serif brand-text pr-1 text-[1.06em]">about a minute.</em>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lead text-night-muted">
          Download, hold the shortcut, say something. Connect a model of your own or sign in for
          Murmur’s{billingEnabled ? '; the free tier needs no card' : ''}.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/download" variant="light" size="lg">
            Download Murmur
          </ButtonLink>
          <ButtonLink
            href={billingEnabled ? '/pricing' : '/account'}
            variant="night-ghost"
            size="lg"
            className="border border-night-line text-white"
          >
            {billingEnabled ? 'See pricing' : 'Your account'}
          </ButtonLink>
        </div>
      </div>
    </Section>
  )
}
