import { DictationPill } from './pill'

/*
 * The hero's product shot, drawn in HTML so it stays sharp and honest: a compose window with the
 * text Murmur typed, the raw transcript it started from, and the pill floating at the bottom of the
 * screen as it does on the desktop. The transcript and the typed text are the same pair as the
 * engine's own example (see transcript-demo.tsx).
 */
export function Stage() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="stage-frame">
        <div className="flex items-center gap-2 border-b border-black/[0.06] bg-[oklch(0.975_0.004_290)] px-4 py-3">
          <span className="size-3 rounded-full bg-[oklch(0.85_0.01_290)]" />
          <span className="size-3 rounded-full bg-[oklch(0.85_0.01_290)]" />
          <span className="size-3 rounded-full bg-[oklch(0.85_0.01_290)]" />
          <span className="mx-auto -translate-x-6 text-meta font-medium text-[oklch(0.45_0.02_285)]">
            New message
          </span>
        </div>
        <div className="grid min-h-[360px] grid-cols-[180px_1fr] bg-white text-left max-md:grid-cols-1">
          <div className="space-y-1 border-r border-black/[0.05] bg-[oklch(0.985_0.003_290)] p-4 text-note text-[oklch(0.45_0.02_285)] max-md:hidden">
            <div className="rounded-md bg-[oklch(0.94_0.012_290)] px-3 py-1.5 font-medium text-[oklch(0.25_0.03_285)]">
              Drafts
            </div>
            <div className="px-3 py-1.5">Inbox</div>
            <div className="px-3 py-1.5">Sent</div>
            <div className="px-3 py-1.5">Archive</div>
          </div>
          <div className="px-6 py-5 sm:px-10 sm:py-7">
            <div className="flex gap-3 border-b border-black/[0.06] pb-3 text-body">
              <span className="w-16 text-[oklch(0.55_0.02_285)]">To</span>
              <span className="text-[oklch(0.2_0.025_285)]">Abby Chen</span>
            </div>
            <div className="flex gap-3 border-b border-black/[0.06] py-3 text-body">
              <span className="w-16 text-[oklch(0.55_0.02_285)]">Subject</span>
              <span className="text-[oklch(0.2_0.025_285)]">March invoice</span>
            </div>
            <div className="pt-6 text-[19px] leading-relaxed text-[oklch(0.2_0.025_285)] sm:text-[21px]">
              <p className="typed-line">The invoice is $1,200 and it’s due on the 15th.</p>
              <p className="typed-line [animation-delay:900ms]">
                Thanks, Abby
                <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-brand-violet animate-pulse-soft" />
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-6 left-1/2 z-10 -translate-x-1/2">
        <DictationPill />
      </div>

      <div className="stage-card absolute bottom-10 -left-6 hidden w-[250px] p-4 text-left lg:block xl:-left-20">
        <div className="text-caption font-semibold tracking-[0.1em] text-night-muted uppercase">
          What you said
        </div>
        <p className="mt-2 text-note leading-relaxed text-night-foreground/90">
          <s className="spoken-cut">um so</s> <s className="spoken-cut">the</s> the invoice is one
          thousand two hundred dollars and it’s due on the fifteenth{' '}
          <s className="spoken-cut">uh</s>{' '}
          <span className="rounded bg-white/10 px-1 text-white">new line</span> thanks abby
        </p>
      </div>

      <div className="stage-card absolute top-36 -right-6 hidden w-[250px] p-4 text-left lg:block xl:-right-20">
        <div className="text-caption font-semibold tracking-[0.1em] text-night-muted uppercase">
          Checked before it is typed
        </div>
        <ul className="mt-3 space-y-2 text-note text-night-foreground/90">
          {[
            'Numbers 1200 · 15, same order',
            '11 of 12 content words kept',
            '“new line” applied'
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <svg viewBox="0 0 16 16" className="mt-[3px] size-3.5 shrink-0 text-success">
                <path
                  d="M3.5 8.5 6.5 11.5 12.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
