import { ButtonLink } from '@/components/ui/button'
import { Container } from '@/components/ui/section'
import { billingEnabled } from '@/lib/env'
import { formatDate } from '@/lib/format'
import type { ReleaseManifest } from '@/lib/releases'
import { repoUrl } from '@/lib/site'
import { Stage } from './stage'

/**
 * The sentence before "MIT licensed" in the note under the hero's buttons: the pricing pitch while
 * the site sells Pro, otherwise what the app runs with. Pure, so both readings are pinned by a test.
 */
export function heroNote(selling: boolean): string {
  return selling ? 'Free to start, no card.' : 'Bring your own model, or sign in for Murmur’s.'
}

/*
 * The hero is a night stage: the headline centred over the product at work, a dictation landing in
 * a compose window with the pill floating where it floats on a real desktop.
 */
export function Hero({ manifest }: { manifest: ReleaseManifest | null }) {
  return (
    <div className="relative isolate overflow-hidden bg-night pt-16 pb-24 text-night-foreground sm:pt-24 sm:pb-32">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-grid" aria-hidden="true" />
      <Container className="relative">
        <div className="stagger mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-night-line bg-white/[0.04] py-1.5 pr-3.5 pl-2 text-meta text-night-muted">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-white/8">
              <span className="size-1.5 rounded-full bg-record animate-pulse-soft" />
            </span>
            Voice dictation for Windows, Linux and Android
          </div>
          <h1 className="display-type mt-7 text-[44px] leading-[1.02] text-balance text-white sm:text-[64px] lg:text-[80px]">
            Hold a key. Speak. The words{' '}
            <em className="accent-serif brand-text pr-1 text-[1.08em]">land</em> where your cursor
            is.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lead text-pretty text-night-muted">
            Clean, punctuated text, typed into whatever you are using: chat, email, documents, code
            editors and terminals. Fillers and false starts disappear, numbers come out the way you
            would type them, and nothing you said gets invented or lost.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href="/download" variant="light" size="lg">
              Download Murmur
            </ButtonLink>
            <ButtonLink
              href="/#how"
              variant="night-ghost"
              size="lg"
              className="border border-night-line text-white"
            >
              See how it works
            </ButtonLink>
          </div>
          <p className="mt-6 text-meta text-night-muted/90">
            {manifest ? (
              <>
                <a href={manifest.url} className="font-medium text-white/85 hover:text-white">
                  {manifest.tag}
                </a>
                {manifest.publishedAt && <> released {formatDate(manifest.publishedAt)}</>}
                {' · '}
              </>
            ) : null}
            {heroNote(billingEnabled)} MIT licensed,{' '}
            <a
              href={repoUrl()}
              className="underline decoration-white/30 underline-offset-4 hover:text-white"
            >
              source on GitHub
            </a>
            .
          </p>
        </div>
        <div className="relative mx-auto mt-16 max-w-5xl animate-rise-in [animation-delay:200ms] sm:mt-20">
          <Stage />
        </div>
      </Container>
    </div>
  )
}
