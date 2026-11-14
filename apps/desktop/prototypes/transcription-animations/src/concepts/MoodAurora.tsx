import { clamp, easeOut, prog } from '../clock'
import { Check, IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { levelAt, PROCESS_END, type Tone, toneAt, toneOfWord, wordsAt } from '../script'

/** Each tone as a light: [r,g,b] for the glow, and the word ink it lends the caption. */
export const TONES: Record<Tone, { rgb: [number, number, number]; label: string }> = {
  neutral: { rgb: [120, 150, 190], label: 'Calm' },
  frustrated: { rgb: [255, 104, 64], label: 'Frustrated' },
  excited: { rgb: [255, 196, 64], label: 'Excited' },
  asking: { rgb: [150, 120, 255], label: 'Asking' }
}

/** The tone colour at t, eased: an average of the last ~600ms of classified tone. */
export function toneColor(t: number): [number, number, number] {
  const acc = [0, 0, 0]
  let n = 0
  for (let k = 0; k < 16; k++) {
    const c = TONES[toneAt(t - k * 40)].rgb
    const wgt = 16 - k
    acc[0] += c[0] * wgt
    acc[1] += c[1] * wgt
    acc[2] += c[2] * wgt
    n += wgt
  }
  return [acc[0] / n, acc[1] / n, acc[2] / n]
}
const rgba = (c: number[], a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`

/**
 * Mood Aurora (tone-aware): the pill is lit from inside by the mood of what is being said. A
 * classifier reads the stream clause by clause; frustration warms it to ember, excitement to gold,
 * a question to violet, and the words already on screen are re-inked when their clause is
 * understood. The light swells with the voice. On insert, the mood of the whole take settles into
 * a soft band under the check.
 */
export function MoodAurora({ t }: { t: number }): React.JSX.Element {
  const heard = wordsAt(t)
  const { phase, since } = phaseInfo(t)
  const lvl = levelAt(t)
  const col = toneColor(t)
  const size = morphSize(t, (p): Size => (p === 'idle' ? IDLE : p === 'success' ? [176, 44] : [470, 52]))
  const last = heard.length ? heard[heard.length - 1].i : -1
  const tone = toneAt(t)
  const drift = t / 1000
  const shown = heard.slice(-7)

  return (
    <Pill size={size}>
      {/* aurora: three drifting blobs of the tone colour, breathing with the level */}
      <div
        className="absolute inset-0"
        style={{
          opacity: phase === 'idle' ? 0 : phase === 'success' ? 0.55 : 1,
          background: [
            `radial-gradient(60% 140% at ${30 + Math.sin(drift * 0.9) * 18}% ${110 - lvl * 40}%, ${rgba(col, 0.25 + lvl * 0.5)}, transparent 70%)`,
            `radial-gradient(45% 120% at ${70 + Math.cos(drift * 0.7) * 16}% ${120 - lvl * 50}%, ${rgba(col.map((v) => v * 0.8 + 40), 0.18 + lvl * 0.35)}, transparent 70%)`,
            `radial-gradient(80% 90% at 50% -40%, ${rgba(col, 0.12)}, transparent 70%)`
          ].join(',')
        }}
      />
      {phase === 'listening' && (
        <div className="absolute inset-0 flex items-center justify-between gap-3 pl-5 pr-2.5" style={{ opacity: easeOut(since / 300) }}>
          <div className="relative flex h-6 flex-1 items-center justify-end overflow-hidden whitespace-nowrap" style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent, black 48px)' }}>
            {shown.map((w) => {
              const age = t - (w.start + 140)
              const p = easeOut(age / 280)
              const wt = toneOfWord(w.i, last)
              const c = TONES[wt].rgb
              const ink = wt === 'neutral' ? 'rgba(255,255,255,0.92)' : rgba(c.map((v) => v * 0.55 + 115), 1)
              return (
                <span
                  key={w.i}
                  className="ml-[5px] inline-block"
                  style={{
                    color: ink,
                    transition: 'color 500ms ease',
                    opacity: p,
                    transform: `translateY(${(1 - p) * 8}px)`,
                    textShadow: wt === 'neutral' ? undefined : `0 0 12px ${rgba(c, 0.55)}`
                  }}
                >
                  {w.raw}
                </span>
              )
            })}
          </div>
          <span
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption"
            style={{ background: rgba(col, 0.18), color: rgba(col.map((v) => v * 0.5 + 128), 1) }}
          >
            <span className="block size-1.5 rounded-full" style={{ background: rgba(col, 1), boxShadow: `0 0 8px ${rgba(col, 0.9)}` }} />
            <span key={tone} style={{ animation: 'fade-in 300ms ease both' }}>
              {TONES[tone].label}
            </span>
          </span>
        </div>
      )}
      {phase === 'processing' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/85">
          {(['frustrated', 'excited', 'asking'] as Tone[]).map((k, i) => (
            <span
              key={k}
              className="block h-1.5 rounded-full"
              style={{
                width: 40 + 30 * Math.sin(since / 220 + i * 1.3) ** 2,
                background: rgba(TONES[k].rgb, 0.9),
                boxShadow: `0 0 10px ${rgba(TONES[k].rgb, 0.7)}`
              }}
            />
          ))}
          <span className="ml-2">Reading the room…</span>
        </div>
      )}
      {phase === 'success' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ opacity: easeOut(since / 260) }}>
          <Check p={prog(t, PROCESS_END + 120, 320)} />
          <span>Inserted</span>
          {/* the take's mood, as a tiny proportional band */}
          <span className="ml-1 flex h-1.5 w-12 overflow-hidden rounded-full">
            {(['neutral', 'frustrated', 'excited', 'asking'] as Tone[]).map((k, i) => (
              <span key={k} style={{ flex: [2, 9, 12, 6][i] * clamp(since / 500), background: rgba(TONES[k].rgb, 1) }} />
            ))}
          </span>
        </div>
      )}
    </Pill>
  )
}
