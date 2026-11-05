import { Section, SectionHeading } from '@/components/ui/section'
import { repoUrl } from '@/lib/site'

const ICONS = [
  'M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z M9 12l2 2 4-4',
  'M15.5 7.5a3.5 3.5 0 1 1-3.4 4.4L4 12v3h3v-2h2l1.6-1.1 M15.5 7.5h.01',
  'M20 12a8 8 0 1 1-2.3-5.6 M20 4v4h-4 M9 12l2 2 4-4',
  'm8 8-4 4 4 4 M16 8l4 4-4 4 M13.5 5l-3 14'
]

const PRINCIPLES = [
  {
    title: 'Recordings never leave the device',
    body: 'Every dictation’s audio stays with its History entry on your machine so you can play it back or retry a failed one. Nothing is uploaded except the clip being transcribed.'
  },
  {
    title: 'Keys and model choices are device settings',
    body: 'Which speech model a device uses and any API keys of your own are never synced. An account syncs your dictionary, snippets, style and stats, and history only if you ask.'
  },
  {
    title: 'Updates you can check',
    body: 'Both apps update from GitHub Releases and verify each download against the release’s SHA256SUMS.txt. Releases without one are shown but never installed unattended.'
  },
  {
    title: 'Open source, MIT',
    body: 'The desktop app, the Android app, the text engine and the backend are one repository. Read the prompt the model gets and the checks its answer must pass.'
  }
]

export function Principles() {
  return (
    <Section id="principles">
      <SectionHeading
        eyebrow="On your terms"
        title="Dictation hears everything you say. Murmur is built like it knows that."
        lede="Four commitments about where your words go, each one checkable in the source rather than promised in a policy."
      />
      <dl className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PRINCIPLES.map((p, i) => (
          <div key={p.title} className="surface-raised rounded-2xl p-6">
            <dt className="text-body font-semibold tracking-tight">
              <span className="mb-5 flex size-10 items-center justify-center rounded-xl bg-brand-violet/10 text-brand-ink dark:text-brand-violet">
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {ICONS[i]!.split(' M').map((d, j) => (
                    <path key={j} d={j === 0 ? d : `M${d}`} />
                  ))}
                </svg>
              </span>
              {p.title}
            </dt>
            <dd className="mt-2 text-note leading-relaxed text-pretty text-muted-foreground">
              {p.body}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-body">
        <a
          href={repoUrl()}
          className="font-medium text-brand-ink underline decoration-brand-ink/30 underline-offset-4 hover:decoration-brand-ink dark:text-brand-violet"
        >
          Read the source →
        </a>
      </p>
    </Section>
  )
}
