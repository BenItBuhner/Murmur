import type { ReactNode } from 'react'
import { ButtonLink } from '@/components/ui/button'
import { Section, SectionHeading } from '@/components/ui/section'
import { billingEnabled } from '@/lib/env'

const OWN = [
  'Any OpenAI-compatible speech endpoint: OpenAI, Groq, Mistral Voxtral, a local whisper server',
  'Deepgram and ElevenLabs natively, with your dictionary sent as key terms',
  'One-click model discovery, a fallback model and a built-in latency test',
  'Keys stay on the device. No account, nothing is uploaded.'
]

const MURMUR = [
  'Speech and formatting models included, nothing to configure',
  'Dictionary, snippets, style and stats in step on desktop and Android',
  'Dictation history sync, opt-in, because it contains what you said',
  'Works offline from a local mirror; edits queue and replay in order'
]

export function Models() {
  return (
    <Section id="models">
      <SectionHeading
        eyebrow="Your models, or Murmur's"
        title="Bring a key, run a local model, or sign in and skip all of that."
        lede="Every build works on its own with a speech model you connect. An account adds Murmur's models and keeps your settings the same on every device. Switch between the two per device, any time."
      />
      <div className="mt-12 grid gap-5 md:grid-cols-2">
        <Plan
          tag="Local mode"
          title="Your own provider"
          subtitle="Local mode. Free, forever, no account."
          items={OWN}
          action={
            <ButtonLink href="/download" variant="raised">
              Download and connect a model
            </ButtonLink>
          }
        />
        <Plan
          featured
          tag="With an account"
          title="Murmur's models"
          subtitle={
            billingEnabled
              ? 'With an account. Free tier, 14-day Pro trial, Pro from $6 a month.'
              : 'With an account, while the server is open to it.'
          }
          items={MURMUR}
          action={
            billingEnabled ? (
              <ButtonLink href="/pricing" variant="brand">
                See pricing
              </ButtonLink>
            ) : (
              <ButtonLink href="/account" variant="brand">
                Sign in or create an account
              </ButtonLink>
            )
          }
        />
      </div>
    </Section>
  )
}

function Plan({
  tag,
  title,
  subtitle,
  items,
  action,
  featured = false
}: {
  tag: string
  title: string
  subtitle: string
  items: string[]
  action: ReactNode
  featured?: boolean
}) {
  return (
    <div className={featured ? 'plan-featured rounded-2xl p-px' : 'rounded-2xl'}>
      <div className="surface-raised flex h-full flex-col rounded-[23px] p-7 sm:p-8">
        <span
          className={
            featured
              ? 'self-start rounded-full bg-brand-violet/12 px-2.5 py-1 text-caption font-semibold text-brand-ink dark:text-brand-violet'
              : 'self-start rounded-full bg-muted px-2.5 py-1 text-caption font-semibold text-muted-foreground'
          }
        >
          {tag}
        </span>
        <h3 className="display-type mt-4 text-heading">{title}</h3>
        <p className="mt-1.5 text-body text-muted-foreground">{subtitle}</p>
        <ul className="mt-6 flex-1 space-y-3 border-t border-border pt-6">
          {items.map((item) => (
            <li key={item} className="flex gap-3 text-body">
              <svg
                viewBox="0 0 16 16"
                aria-hidden
                className="mt-1 size-4 shrink-0 text-brand-violet"
              >
                <path
                  d="M3.5 8.5 6.5 11.5 12.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-foreground/85">{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8">{action}</div>
      </div>
    </div>
  )
}
