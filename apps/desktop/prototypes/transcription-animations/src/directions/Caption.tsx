import { clamp, easeOut } from '../clock'
import { IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { LISTEN_START, toneOfWord, wordsAt } from '../script'
import { StrandsCanvas } from './canvas'
import { rgba, TONE_RGB, toneRGB, type RGB } from './strands'

const W = 340

/**
 * Silk with words: the strands run low and quiet under a single live line of text. New words
 * surface out of the light; once a clause is understood its words take a breath of its tone and
 * then settle back to white as they age, so colour marks what is being said *now*.
 */
export function Caption({ t }: { t: number }): React.JSX.Element {
  const { phase } = phaseInfo(t)
  const size = morphSize(
    t,
    (p): Size =>
      p === 'idle' ? IDLE : p === 'listening' ? [W, 64] : p === 'processing' ? [84, 40] : [64, 40],
    420
  )
  const heard = wordsAt(t)
  const last = heard.length ? heard[heard.length - 1].i : -1
  const col = toneRGB(t)
  const listening = phase === 'listening'
  const textIn = easeOut((t - LISTEN_START - 200) / 300)
  return (
    <Pill
      size={size}
      radius={size[1] > 50 ? 24 : 999}
      style={{
        background: `radial-gradient(100% 120% at 50% 130%, ${rgba(col, 0.1)}, transparent 60%), oklch(0.17 0 0)`
      }}
    >
      {listening && (
        <div
          className="absolute inset-x-5 top-[11px] flex h-5 items-center justify-end overflow-hidden whitespace-nowrap text-[13px]"
          style={{
            opacity: textIn,
            WebkitMaskImage: 'linear-gradient(90deg, transparent, black 56px)'
          }}
        >
          {heard.slice(-9).map((w) => {
            const age = t - (w.start + 140)
            const p = easeOut(age / 260)
            const tone = toneOfWord(w.i, last)
            const fresh = 1 - clamp((age - 900) / 1600)
            const ink: RGB = [0, 1, 2].map(
              (k) => 255 + (TONE_RGB[tone][k] - 255) * 0.75 * fresh
            ) as RGB
            return (
              <span
                key={w.i}
                className="ml-[4px] inline-block"
                style={{
                  color: rgba(ink, 0.55 + 0.4 * fresh),
                  opacity: p,
                  filter: `blur(${(1 - p) * 3}px)`,
                  transform: `translateY(${(1 - p) * 4}px)`,
                  transition: 'color 500ms ease'
                }}
              >
                {w.text}
              </span>
            )
          })}
        </div>
      )}
      <StrandsCanvas
        t={t}
        w={listening ? W - 24 : 84}
        h={listening ? 26 : 40}
        gain={listening ? 0.85 : 0.82}
        ownEnding
        style={{
          position: 'absolute',
          left: '50%',
          top: listening ? 'auto' : '50%',
          bottom: listening ? 6 : 'auto',
          transform: listening ? 'translateX(-50%)' : 'translate(-50%,-50%)',
          opacity: phase === 'idle' ? 0 : 1
        }}
      />
    </Pill>
  )
}
