import { clamp, easeOut, easeOutBack, prog } from '../clock'
import { Check, IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { levelAt, LISTEN_END, PROCESS_END, WORDS, wordsAt } from '../script'

const HEAD = 7

/**
 * Glyph Loom: the waveform *is* the type. A small head of live bars sits at the right edge; when a
 * word is recognised its letters are spun out of those bars, each glyph starting as a tall thin
 * stroke and relaxing into its letterform, so you watch sound turn into writing. On stop, every
 * letter flips once, in a wave, from what was heard to what will be inserted.
 */
export function GlyphLoom({ t }: { t: number }): React.JSX.Element {
  const heard = wordsAt(t)
  const { phase, since } = phaseInfo(t)
  const size = morphSize(t, (p): Size => (p === 'idle' ? IDLE : p === 'success' ? [140, 44] : [480, 44]))
  const lvl = levelAt(t)

  const shown = heard.slice(-6)
  return (
    <Pill size={size}>
      {(phase === 'listening' || phase === 'processing') && (
        <div className="absolute inset-0 flex items-center justify-end gap-3 px-[18px]" style={{ opacity: phase === 'listening' ? easeOut(since / 260) : 1 - prog(t, PROCESS_END - 220, 220) }}>
          <div className="flex h-6 flex-1 items-center justify-end overflow-hidden whitespace-nowrap font-mono text-[13px] tracking-tight" style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent, black 56px)' }}>
            {(phase === 'processing' ? WORDS.slice(-6) : shown).map((w) => (
              <span key={w.i} className="ml-[7px] inline-flex">
                {[...(phase === 'processing' ? w.text : w.raw)].map((ch, k) => {
                  const born = w.start + 140 + k * 26
                  const p = phase === 'processing' ? 1 : clamp((t - born) / 360)
                  // processing: a flip wave, left to right, swaps raw letters for clean ones
                  const flipAt = LISTEN_END + 80 + (w.i - 23) * 70 + k * 14
                  const f = phase === 'processing' ? prog(t, flipAt, 260) : 1
                  const showClean = phase !== 'processing' || f > 0.5
                  const letter = phase === 'processing' ? (showClean ? w.text[k] ?? '' : w.raw[k] ?? '') : ch
                  return (
                    <span
                      key={k}
                      className="inline-block"
                      style={{
                        opacity: clamp(p * 3),
                        transform:
                          phase === 'processing'
                            ? `rotateX(${Math.sin(f * Math.PI) * 88}deg)`
                            : `scaleX(${0.25 + 0.75 * easeOutBack(p)}) scaleY(${2.6 - 1.6 * easeOut(p)})`,
                        filter: `blur(${(1 - easeOut(p)) * 2}px)`,
                        color: p < 1 ? `rgba(255,${130 + 125 * p},${110 + 145 * p},1)` : 'white',
                        transformOrigin: '50% 60%'
                      }}
                    >
                      {letter === ' ' ? ' ' : letter}
                    </span>
                  )
                })}
              </span>
            ))}
          </div>
          {/* the loom head: live bars that letters are spun from */}
          <div className="flex h-6 shrink-0 items-center gap-[3px]">
            {Array.from({ length: HEAD }, (_, k) => {
              const v = phase === 'listening' ? levelAt(t - (HEAD - k) * 45) : 0.05
              return (
                <span
                  key={k}
                  className="block w-[3px] rounded-full"
                  style={{
                    height: Math.max(3, v * 22),
                    background: `oklch(0.7 0.19 30 / ${0.5 + v * 0.5})`,
                    boxShadow: k === HEAD - 1 ? `0 0 ${lvl * 10}px oklch(0.7 0.19 30)` : undefined
                  }}
                />
              )
            })}
          </div>
        </div>
      )}
      {phase === 'success' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ opacity: easeOut(since / 260) }}>
          <Check p={prog(t, PROCESS_END + 120, 320)} />
          <span>Inserted</span>
        </div>
      )}
    </Pill>
  )
}
