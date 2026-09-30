import { ButtonLink } from '@/components/ui/button'
import { Container } from '@/components/ui/section'
import { billingEnabled } from '@/lib/env'
import { formatDate } from '@/lib/format'
import type { ReleaseManifest } from '@/lib/releases'
import { repoUrl } from '@/lib/site'
import { TranscriptDemo } from './transcript-demo'

/**
 * The sentence before "MIT licensed" in the note under the hero's buttons: the pricing pitch while
 * the site sells Pro, otherwise what the app runs with. Pure, so both readings are pinned by a test.
 */
export function heroNote(selling: boolean): string {
  return selling ? 'Free to start, no card.' : 'Bring your own model, or sign in for Murmur’s.'
}

export function Hero({ manifest }: { manifest: ReleaseManifest | null }) {
  return (
    <div className="pt-10 pb-8 sm:pt-16 sm:pb-12">
      <Container className="grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <div className="stagger max-w-xl">
          <div className="eyebrow">Voice dictation · Windows, Linux, Android</div>
          <h1 className="serif-display mt-5 text-title text-balance sm:text-display">
            Hold a key. Speak. The words <em className="italic">land</em> where your cursor is.
          </h1>
          <p className="mt-6 max-w-lg text-lead text-pretty text-muted-foreground">
            Murmur turns what you say into clean, punctuated text and types it into whatever you are
            using: chat, email, a document, a code editor, a terminal. Fillers and false starts
            disappear, numbers come out the way you would type them, and nothing you said gets
            invented or lost.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/download" size="lg">
              Download Murmur
            </ButtonLink>
            <ButtonLink href="/#engine" variant="tonal" size="lg">
              How it works
            </ButtonLink>
          </div>
          <p className="mt-6 text-note text-muted-foreground">
            {manifest ? (
              <>
                <a
                  href={manifest.url}
                  className="font-medium text-foreground/80 hover:text-foreground"
                >
                  {manifest.tag}
                </a>
                {manifest.publishedAt && <> released {formatDate(manifest.publishedAt)}</>}
                {' · '}
              </>
            ) : null}
            {heroNote(billingEnabled)} MIT licensed,{' '}
            <a
              href={repoUrl()}
              className="underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
            >
              source on GitHub
            </a>
            .
          </p>
        </div>
        <div className="animate-rise-in pt-6 lg:pt-0 [animation-delay:160ms]">
          <TranscriptDemo />
        </div>
      </Container>
    </div>
  )
}
