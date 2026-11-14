import { clamp, easeOut, easeOutBack, prog } from '../clock'
import { Check, IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import {
  ENTITIES,
  type Entity,
  LISTEN_END,
  PROCESS_END,
  SUCCESS_END,
  WORDS,
  wordsAt
} from '../script'

const KIND: Record<Entity['kind'], { icon: string; rgb: string }> = {
  topic: { icon: '#', rgb: '120,180,255' },
  feeling: { icon: '!', rgb: '255,120,90' },
  question: { icon: '?', rgb: '170,140,255' },
  date: { icon: '◷', rgb: '110,220,160' }
}

/**
 * Context Chips (content-aware): the caption runs inside the pill, and whatever the model
 * understands about it surfaces as it is said. A topic, a blocker, a question, a date each lift
 * out of the word that carried them as a small chip floating over the pill. When you stop, the
 * chips drop back in, and the pill reports what it went in with (and offers the date as a reminder).
 */
export function ContextChips({ t }: { t: number }): React.JSX.Element {
  const heard = wordsAt(t)
  const { phase, since } = phaseInfo(t)
  const size = morphSize(t, (p): Size =>
    p === 'idle' ? IDLE : p === 'success' ? [300, 44] : [440, 44]
  )
  const shown = heard.slice(-8)
  const entityWords = new Set(ENTITIES.map((e) => e.word))
  const live = ENTITIES.filter((e) => WORDS[e.word].start + 260 <= t)
  const drop = prog(t, LISTEN_END + 200, 500)
  const gone = prog(t, SUCCESS_END - 260, 260)

  return (
    <div className="relative h-full w-full">
      <Pill size={size}>
        {phase === 'listening' && (
          <div
            className="absolute inset-0 flex items-center justify-end overflow-hidden whitespace-nowrap px-5"
            style={{
              WebkitMaskImage: 'linear-gradient(90deg, transparent, black 48px)',
              opacity: easeOut(since / 260)
            }}
          >
            {shown.map((w) => {
              const p = easeOut((t - w.start - 140) / 260)
              const hot = entityWords.has(w.i)
              const e = ENTITIES.find((x) => x.word === w.i)
              return (
                <span
                  key={w.i}
                  className="ml-[5px] inline-block rounded px-0.5"
                  style={{
                    opacity: p,
                    color: hot ? `rgb(${KIND[e!.kind].rgb})` : 'rgba(255,255,255,0.88)',
                    background: hot
                      ? `rgba(${KIND[e!.kind].rgb},${0.18 * clamp((t - w.start - 260) / 300)})`
                      : undefined
                  }}
                >
                  {w.raw}
                </span>
              )
            })}
          </div>
        )}
        {phase === 'processing' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/80">
            <span
              className="block size-1.5 rounded-full bg-white"
              style={{ opacity: 0.4 + 0.6 * Math.abs(Math.sin(since / 200)) }}
            />
            Formatting with context…
          </div>
        )}
        {phase === 'success' && (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2"
            style={{ opacity: easeOut(since / 260) }}
          >
            <Check p={prog(t, PROCESS_END + 120, 320)} />
            <span>Inserted</span>
            <span
              className="ml-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-caption"
              style={{ background: 'rgba(110,220,160,0.16)', color: 'rgb(150,235,190)' }}
            >
              ◷ Remind me Fri?
            </span>
          </div>
        )}
      </Pill>
      {/* chips float above the pill, in the order they were understood */}
      <div
        className="pointer-events-none absolute inset-x-0 flex justify-center gap-1.5"
        style={{ bottom: 12 + 44 + 12 }}
      >
        {live.map((e, k) => {
          const born = WORDS[e.word].start + 260
          const p = easeOutBack((t - born) / 420)
          const out = phase === 'listening' ? 0 : easeOut(drop + k * 0.05)
          const a = clamp((t - born) / 200) * (1 - out) * (1 - gone)
          return (
            <span
              key={e.label}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-caption font-medium"
              style={{
                opacity: a,
                transform: `translateY(${(1 - p) * 26 + out * 30}px) scale(${0.6 + 0.4 * p - out * 0.3})`,
                background: `rgba(${KIND[e.kind].rgb},0.16)`,
                color: `rgb(${KIND[e.kind].rgb})`,
                boxShadow: `0 4px 14px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(${KIND[e.kind].rgb},0.25)`,
                backdropFilter: 'blur(6px)'
              }}
            >
              <span className="opacity-80">{KIND[e.kind].icon}</span>
              {e.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
