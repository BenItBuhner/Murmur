import { Section, SectionHeading } from '@/components/ui/section'

const STAGES = [
  {
    title: 'Speech in, raw transcript out',
    body: 'The speech model returns your words with their timings. When it stops early, which Whisper-style models do right after a word from your dictionary, Murmur transcribes the rest from the nearest pause and appends it, so nothing you said is dropped.'
  },
  {
    title: 'The model sees the raw transcript',
    body: 'Exactly as the speech model returned it, together with where the text is going, what is already before the cursor, your dictionary and your instructions. It removes fillers and false starts, applies spoken commands, writes numbers the way a person types them, lays enumerations out as lists and matches the destination.'
  },
  {
    title: 'The verifier checks the answer',
    body: 'Not empty, not chatty, not an answer to your question. Most of your words and roughly your length. Phrases that must stay verbatim are still there. And exactly the same numbers, in the same order, however the model chose to write them.'
  },
  {
    title: 'A failed check never reaches your cursor',
    body: 'One strict retry, then the rule-based cleanup of the transcript is inserted instead, and History tells you why. Your dictionary is re-applied after the model, and your snippets expand last.'
  }
]

const NUMBERS: Array<[spoken: string, typed: string]> = [
  ['five thirty pm', '5:30 pm'],
  ['one million two hundred thousand dollars', '$1,200,000'],
  ['version two point oh point one', '2.0.1'],
  ['zero zero zero seven', '0007'],
  ['five thousand, five thousand', '5,000, 5,000']
]

export function Engine() {
  return (
    <Section id="engine" className="night-section relative isolate overflow-hidden">
      <div className="engine-glow" aria-hidden="true" />
      <SectionHeading
        eyebrow="The engine"
        title={
          <>
            The model does the language work. The verifier makes sure it did not{' '}
            <em className="accent-serif brand-text pr-1">cheat.</em>
          </>
        }
        lede="Most dictation tools either trust a language model completely or fence it in with rules that break on the next sentence. Murmur gives the model the raw transcript and then holds its answer to a few invariants that can be checked without understanding the text."
      />

      <div className="mt-section grid gap-12 lg:grid-cols-split lg:gap-16">
        <ol className="relative space-y-3">
          {STAGES.map((stage, i) => (
            <li
              key={stage.title}
              className="night-card grid grid-cols-[2.5rem_1fr] gap-x-4 p-5 sm:grid-cols-[3rem_1fr] sm:p-6"
            >
              <span className="inline-flex size-9 items-center justify-center rounded-full bg-white/8 font-display text-note font-semibold text-white tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div>
                <h3 className="pt-1.5 text-lead font-semibold tracking-tight text-white">
                  {stage.title}
                </h3>
                <p className="mt-2 text-note leading-relaxed text-pretty text-night-muted">
                  {stage.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="night-card p-5 sm:p-6">
            <div className="eyebrow">Numbers are compared as values</div>
            <p className="mt-2 text-body text-night-muted">
              The model may write a number any way a person would. It may not change, drop, merge or
              invent one.
            </p>
            <div className="mt-card overflow-hidden rounded-md bg-black/25 shadow-[inset_0_0_0_1px_var(--night-line)]">
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption tracking-[0.1em] text-night-muted uppercase">
                    <th scope="col" className="px-4 pt-3.5 pb-2 font-medium">
                      Spoken
                    </th>
                    <th scope="col" className="px-4 pt-3.5 pb-2 font-medium">
                      Typed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {NUMBERS.map(([spoken, typed]) => (
                    <tr key={spoken} className="border-t border-night-line">
                      <td className="px-4 py-2.5 text-night-muted">{spoken}</td>
                      <td className="px-4 py-2.5 font-medium whitespace-nowrap text-white tabular-nums">
                        {typed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="h-2" />
            </div>
            <div className="mt-3 rounded-md bg-record/12 px-4 py-3.5 text-note shadow-[inset_0_0_0_1px_oklch(0.7_0.19_35/0.3)]">
              <span className="font-semibold text-record">Caught:</span>{' '}
              <span className="text-night-foreground/90">
                for “five thousand, five thousand” the model wrote a single{' '}
                <span className="font-medium tabular-nums">5,000</span>. Signature{' '}
                <span className="font-mono text-meta">5000 5000</span> became{' '}
                <span className="font-mono text-meta">5000</span>, the answer was refused, and the
                strict retry kept both.
              </span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  )
}
