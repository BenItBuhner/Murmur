import { clamp, easeOut, prog } from '../clock'
import { Check, IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { CLEAN, levelAt, PROCESS_END, wordsAt, WORDS } from '../script'

const MAX_W = 460
const PAD = 18

/**
 * Inkline: the pill becomes a live caption. Each word condenses out of a blur as the recogniser
 * hears it, the line scrolls left under a soft fade, and when you stop, a single light pass
 * sweeps across while the raw words are rewritten into the cleaned sentence.
 */
export function Inkline({ t }: { t: number }): React.JSX.Element {
  const heard = wordsAt(t)
  const { phase, since } = phaseInfo(t)
  const size = morphSize(t, (p, tt): Size => {
    if (p === 'idle') return IDLE
    if (p === 'listening') {
      const n = wordsAt(tt).length
      return [Math.min(MAX_W, 120 + n * 46), 44]
    }
    if (p === 'processing') return [MAX_W, 44]
    return [150, 44]
  })
  const lvl = levelAt(t)

  const inner = size[0] - PAD * 2 - 22
  const shown = heard.slice(-9)

  return (
    <Pill size={size}>
      {phase === 'listening' && (
        <div className="absolute inset-0 flex items-center" style={{ paddingLeft: PAD, opacity: easeOut(since / 300) }}>
          {/* Voice dot: the only meter, breathing with the level */}
          <span
            className="block shrink-0 rounded-full"
            style={{
              width: 8,
              height: 8,
              background: 'oklch(0.7 0.19 30)',
              boxShadow: `0 0 ${4 + lvl * 16}px ${lvl * 4}px oklch(0.7 0.19 30 / ${0.25 + lvl * 0.4})`,
              transform: `scale(${1 + lvl * 0.5})`
            }}
          />
          <div
            className="relative ml-3.5 flex h-6 items-center justify-end overflow-hidden whitespace-nowrap"
            style={{ width: inner, WebkitMaskImage: 'linear-gradient(90deg, transparent, black 40px)' }}
          >
            {shown.map((w) => {
              const age = t - (w.start + 140)
              const p = easeOut(age / 320)
              return (
                <span
                  key={w.i}
                  className="ml-[5px] inline-block leading-6"
                  style={{
                    opacity: p * (1 - clamp((age - 1400) / 1000) * 0.38),
                    filter: `blur(${(1 - p) * 6}px)`,
                    transform: `translateY(${(1 - p) * 6}px) scale(${0.92 + 0.08 * p})`
                  }}
                >
                  {w.raw}
                </span>
              )
            })}
          </div>
        </div>
      )}
      {phase === 'processing' && <Rewrite since={since} width={size[0]} />}
      {phase === 'success' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ opacity: easeOut(since / 260) }}>
          <Check p={prog(t, PROCESS_END + 120, 320)} />
          <span>Inserted</span>
          <span className="text-white/50">{WORDS.length} words</span>
        </div>
      )}
    </Pill>
  )
}

/** The raw tail rewritten into the clean tail behind a sweeping light. */
function Rewrite({ since, width }: { since: number; width: number }): React.JSX.Element {
  const tail = CLEAN.slice(-62)
  const raw = WORDS.map((w) => w.raw).join(' ').slice(-62)
  const sweep = clamp(since / 900)
  const pos = -20 + sweep * 140
  return (
    <div className="absolute inset-0 flex items-center justify-end overflow-hidden px-[18px]" style={{ width }}>
      <div className="relative whitespace-nowrap leading-6">
        <span style={{ opacity: 0, userSelect: 'none' }}>{tail}</span>
        {/* raw text, wiped away left-to-right */}
        <span
          className="absolute inset-0 text-white/55"
          style={{ clipPath: `inset(0 0 0 ${clamp(pos, 0, 100)}%)` }}
        >
          {raw}
        </span>
        {/* clean text, revealed behind the light */}
        <span className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - clamp(pos, 0, 100)}% 0 0)` }}>
          {tail}
        </span>
        <span
          className="absolute -inset-y-2 w-16"
          style={{
            left: `calc(${pos}% - 32px)`,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)',
            filter: 'blur(4px)'
          }}
        />
      </div>
    </div>
  )
}
