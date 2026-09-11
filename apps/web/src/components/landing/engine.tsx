import { Section, SectionHeading } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'

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
    <Section id="engine">
      <SectionHeading
        eyebrow="The engine"
        title={
          <>
            The model does the language work. The verifier makes sure it did not{' '}
            <em className="italic">cheat</em>.
          </>
        }
        lede="Most dictation tools either trust a language model completely or fence it in with rules that break on the next sentence. Murmur gives the model the raw transcript and then holds its answer to a few invariants that can be checked without understanding the text."
      />

      <div className="mt-14 grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
        <ol className="space-y-10">
          {STAGES.map((stage, i) => (
            <li
              key={stage.title}
              className="grid grid-cols-[3.25rem_1fr] gap-x-4 sm:grid-cols-[4rem_1fr]"
            >
              <span className="serif-display pt-0.5 text-[2.25rem] text-muted-foreground/60 tabular-nums sm:text-[2.75rem]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div>
                <h3 className="text-[18px] font-semibold tracking-tight">{stage.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-pretty text-muted-foreground">
                  {stage.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <Surface radius={32} padding={20}>
            <div className="eyebrow px-1">Numbers are compared as values</div>
            <p className="mt-2 px-1 text-[14px] leading-relaxed text-muted-foreground">
              The model may write a number any way a person would. It may not change, drop, merge or
              invent one.
            </p>
            <div className="mt-5 overflow-hidden rounded-(--ri) bg-secondary">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="text-left text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
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
                    <tr key={spoken}>
                      <td className="px-4 py-2 text-muted-foreground">{spoken}</td>
                      <td className="px-4 py-2 font-medium whitespace-nowrap tabular-nums">
                        {typed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="h-2" />
            </div>
            <div className="mt-3 rounded-(--ri) bg-record/10 px-4 py-3.5 text-[13.5px] leading-relaxed">
              <span className="font-medium text-record">Caught:</span>{' '}
              <span className="text-foreground/85">
                for “five thousand, five thousand” the model wrote a single{' '}
                <span className="font-medium tabular-nums">5,000</span>. Signature{' '}
                <span className="font-mono text-[12.5px]">5000 5000</span> became{' '}
                <span className="font-mono text-[12.5px]">5000</span>, the answer was refused, and
                the strict retry kept both.
              </span>
            </div>
          </Surface>
        </div>
      </div>
    </Section>
  )
}
