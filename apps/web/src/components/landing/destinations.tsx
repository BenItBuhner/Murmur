import { Section, SectionHeading } from '@/components/ui/section'

/*
 * One sentence, four destinations. Murmur passes the destination to the model (see the engine),
 * so the same words come out casual in chat, polished in email, exact in a code editor and on one
 * line without a trailing period in a terminal. Illustrative examples of that behaviour.
 */
const PLACES = [
  {
    app: 'Chat',
    said: '“sounds good see you at five thirty”',
    typed: 'sounds good, see you at 5:30!',
    mono: false
  },
  {
    app: 'Email',
    said: '“sounds good I’ll see you at five thirty pm”',
    typed: 'Sounds good. I’ll see you at 5:30 pm.',
    mono: false
  },
  {
    app: 'Code editor',
    said: '“const retry count equals three”',
    typed: 'const retryCount = 3',
    mono: true
  },
  {
    app: 'Terminal',
    said: '“git commit dash m fix login redirect”',
    typed: 'git commit -m "fix login redirect"',
    mono: true
  }
]

export function Destinations() {
  return (
    <Section id="destinations" className="pt-4 sm:pt-8">
      <SectionHeading
        eyebrow="Right for each place"
        title="Same voice. The right text for wherever it lands."
        lede="Murmur knows which app has the cursor and what is already before it, so the same habit of speaking gives you a chat message, an email sentence, an identifier or a command."
      />
      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PLACES.map((place) => (
          <figure
            key={place.app}
            className="surface-raised flex flex-col overflow-hidden rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-meta font-semibold">{place.app}</span>
              <span className="flex gap-1">
                <span className="size-1.5 rounded-full bg-border" />
                <span className="size-1.5 rounded-full bg-border" />
                <span className="size-1.5 rounded-full bg-border" />
              </span>
            </div>
            <div
              className={
                place.mono
                  ? 'flex min-h-28 flex-1 items-center bg-[oklch(0.2_0.025_285)] px-4 py-5 font-mono text-note text-[oklch(0.92_0.03_150)]'
                  : 'flex min-h-28 flex-1 items-center px-4 py-5 text-body font-medium'
              }
            >
              {place.mono && place.app === 'Terminal' ? (
                <span>
                  <span className="text-[oklch(0.7_0.12_295)]">$ </span>
                  {place.typed}
                </span>
              ) : (
                place.typed
              )}
            </div>
            <figcaption className="border-t border-border px-4 py-3 text-meta text-muted-foreground">
              You said {place.said}
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="mt-5 text-meta text-muted-foreground">Illustrative examples.</p>
    </Section>
  )
}
