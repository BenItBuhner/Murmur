import type { ReactNode } from 'react'
import { Section, SectionHeading } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'

const STEPS: Array<{ title: string; body: string; visual: ReactNode }> = [
  {
    title: 'Hold a key, or tap the pill',
    body: 'Ctrl + Win by default, any keys you like. Hold to talk and release to insert, or tap once for hands-free and tap again to stop. On Android the pill floats above the keyboard.',
    visual: (
      <div className="flex items-center gap-1.5" aria-hidden>
        <kbd>Ctrl</kbd>
        <span className="text-muted-foreground">+</span>
        <kbd>Win</kbd>
      </div>
    )
  },
  {
    title: 'Say it the way you would say it',
    body: 'Fillers, stutters, false starts and “Tuesday, no, Wednesday” are yours to make. Spoken commands work too: new line, new paragraph, scratch that, quote and end quote.',
    visual: (
      <p className="text-[13.5px] leading-snug text-muted-foreground" aria-hidden>
        “so, um, Tuesday, no, Wednesday works”
      </p>
    )
  },
  {
    title: 'It lands where your cursor is',
    body: 'Typed straight into the app you are in. Tone follows the destination: casual in chat, professional in email, exact identifiers in code editors, one line and no trailing period in a terminal.',
    visual: (
      <p className="text-[13.5px] leading-snug" aria-hidden>
        Wednesday works.
        <span className="ml-0.5 inline-block h-[1.1em] w-px translate-y-[3px] bg-foreground/70 animate-pulse-soft" />
      </p>
    )
  }
]

export function HowItWorks() {
  return (
    <Section id="how">
      <SectionHeading
        eyebrow="How it works"
        title="Three things, and none of them is a menu."
        lede="Murmur is a Wispr Flow-style dictation tool: one shortcut, your voice, and text that is ready to send."
      />
      <ol className="mt-12 grid gap-5 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <Surface radius={32} padding={20} className="flex h-full flex-col">
              <div className="flex h-24 items-center rounded-(--ri) bg-secondary px-5">
                {step.visual}
              </div>
              <div className="mt-5 flex items-baseline gap-3">
                <span className="serif-display text-[28px] text-muted-foreground/70 tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-[17px] font-semibold tracking-tight">{step.title}</h3>
              </div>
              <p className="mt-2.5 text-[14.5px] leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </Surface>
          </li>
        ))}
      </ol>
    </Section>
  )
}
