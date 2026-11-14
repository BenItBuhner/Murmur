import type { ReactNode } from 'react'
import { Section, SectionHeading } from '@/components/ui/section'

const STEPS: Array<{ title: string; body: string; visual: ReactNode }> = [
  {
    title: 'Hold a key, or tap the pill',
    body: 'Ctrl + Win by default, any keys you like. Hold to talk and release to insert, or tap once for hands-free. On Android the pill floats above the keyboard.',
    visual: (
      <div className="flex items-center gap-2.5">
        <span className="keycap">Ctrl</span>
        <span className="text-lead text-muted-foreground">+</span>
        <span className="keycap">Win</span>
      </div>
    )
  },
  {
    title: 'Say it the way you would say it',
    body: 'Fillers, stutters and “Tuesday, no, Wednesday” are yours to make. Spoken commands work too: new line, new paragraph, scratch that, quote and end quote.',
    visual: (
      <div className="flex flex-col items-start gap-2">
        <div className="flex h-6 items-end gap-[3px]">
          {[6, 12, 18, 10, 22, 14, 8, 16, 20, 9, 13, 6].map((h, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-gradient-to-t from-brand-violet to-brand-coral"
              style={{ height: h }}
            />
          ))}
        </div>
        <p className="text-note text-muted-foreground">
          “so, <s className="spoken-cut">um</s>, <s className="spoken-cut">Tuesday, no,</s>{' '}
          Wednesday works”
        </p>
      </div>
    )
  },
  {
    title: 'It lands where your cursor is',
    body: 'Typed straight into the app you are in, with the tone of the place: casual in chat, professional in email, exact in a code editor, one line in a terminal.',
    visual: (
      <p className="text-lead font-medium text-foreground">
        Wednesday works.
        <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-brand-violet animate-pulse-soft" />
      </p>
    )
  }
]

export function HowItWorks() {
  return (
    <Section id="how" className="pt-24 sm:pt-32">
      <SectionHeading
        align="center"
        eyebrow="How it works"
        title="Three things, and none of them is a menu."
        lede="One shortcut, your voice, and text that is ready to send."
      />
      <ol className="mt-14 grid gap-5 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="surface-raised flex flex-col rounded-2xl p-2">
            <div className="step-visual flex h-36 items-center justify-center rounded-[16px] px-6">
              {step.visual}
            </div>
            <div className="px-4 pt-5 pb-5">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground text-caption font-semibold text-background tabular-nums">
                  {i + 1}
                </span>
                <h3 className="text-lead font-semibold tracking-tight">{step.title}</h3>
              </div>
              <p className="mt-3 text-note leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}
