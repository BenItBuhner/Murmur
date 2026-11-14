import { useEffect, useRef } from 'react'
import { clamp, easeInOut, easeOut, prog } from '../clock'
import { IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { levelAt, LISTEN_END, LISTEN_START, PROCESS_END, SUCCESS_END, WORDS, wordsAt } from '../script'

const W = 420
const H = 44
const SPEED = 0.06 // px per ms the sky drifts left

function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 12.3) * 43758.5453
  return x - Math.floor(x)
}

interface Star {
  word: number
  x0: number
  y: number
  born: number
  r: number
}

/** Every star of the take: one per letter, placed where and when its sound was made. */
const STARS: Star[] = WORDS.flatMap((w) =>
  [...w.raw].map((_, k) => {
    const born = w.start + ((w.end - w.start) * (k + 0.5)) / w.raw.length
    const lvl = levelAt(born)
    return {
      word: w.i,
      x0: born * SPEED + (hash(w.i * 31 + k) - 0.5) * 6,
      y: H / 2 + (hash(w.i * 17 + k * 3) - 0.5) * (10 + lvl * 28),
      born,
      r: 0.8 + lvl * 1.6
    }
  })
)

/** The check mark, as points the stars settle onto. */
function checkPoint(i: number, n: number): [number, number] {
  const s = i / (n - 1)
  const a: [number, number] = [-9, 1]
  const b: [number, number] = [-3, 7]
  const c: [number, number] = [9, -7]
  const k = 0.33
  if (s < k) return [a[0] + (b[0] - a[0]) * (s / k), a[1] + (b[1] - a[1]) * (s / k)]
  const u = (s - k) / (1 - k)
  return [b[0] + (c[0] - b[0]) * u, b[1] + (c[1] - b[1]) * u]
}

/**
 * Constellation: each sound you make leaves a star, brighter and further from the line the louder
 * it was; the stars of a word are threaded together once the word is recognised, so a sentence
 * drifts by as a sky of little constellations. On stop they are drawn in to a turning ring while
 * the text is cleaned, and settle into the check.
 */
export function Constellation({ t }: { t: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const { phase, since } = phaseInfo(t)
  const size = morphSize(t, (p): Size => (p === 'idle' ? IDLE : p === 'success' ? [136, 44] : [W + 36, H]))

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = W * dpr
    cv.height = H * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const heard = new Set(wordsAt(t).map((w) => w.i))
    const visible = STARS.filter((s) => s.born <= t)
    const camera = Math.max(t, LISTEN_START) * SPEED - (W - 24)
    const gather = prog(t, LISTEN_END, 500)
    const settle = prog(t, PROCESS_END - 150, 450)
    const fadeOut = prog(t, SUCCESS_END - 300, 300)
    const tail = visible.slice(-90)

    const pos = tail.map((s, idx) => {
      let x = s.x0 - camera
      let y = s.y
      if (phase !== 'listening') {
        const freeze = LISTEN_END * SPEED - (W - 24)
        x = s.x0 - freeze
        const ang = (idx / tail.length) * Math.PI * 2 + t / 600
        const rx = W / 2 + Math.cos(ang) * 14
        const ry = H / 2 + Math.sin(ang) * 14
        const ge = easeInOut(gather)
        x = x + (rx - x) * ge
        y = y + (ry - y) * ge
        if (settle > 0) {
          const [cx, cy] = checkPoint(idx, tail.length)
          const se = easeInOut(settle)
          x = x + (W / 2 - 30 + cx - x) * se
          y = y + (H / 2 + cy - y) * se
        }
      }
      return [x, y] as const
    })

    // threads within each recognised word
    g.lineWidth = 0.8
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1]
      const b = tail[i]
      const linked = phase !== 'listening' || (a.word === b.word && heard.has(a.word))
      if (!linked) continue
      const age = phase === 'listening' ? clamp((t - (WORDS[a.word].start + 140)) / 300) : 1
      const alpha = (phase === 'listening' ? 0.35 * age : 0.35 + 0.4 * settle) * (1 - fadeOut)
      g.strokeStyle = settle > 0.6 ? `rgba(160,235,180,${alpha})` : `rgba(255,220,200,${alpha})`
      g.beginPath()
      g.moveTo(pos[i - 1][0], pos[i - 1][1])
      g.lineTo(pos[i][0], pos[i][1])
      g.stroke()
    }
    tail.forEach((s, i) => {
      const age = clamp((t - s.born) / 250)
      const [x, y] = pos[i]
      if (x < -4) return
      const edge = clamp(x / 60)
      const tw = 0.75 + 0.25 * Math.sin(t / 180 + s.x0)
      const a = easeOut(age) * edge * tw * (1 - fadeOut)
      const warm = heard.has(s.word) || phase !== 'listening'
      const color = settle > 0.6 ? '170,240,190' : warm ? '255,255,255' : '255,150,120'
      g.fillStyle = `rgba(${color},${a})`
      g.shadowColor = `rgba(${color},${a})`
      g.shadowBlur = 6 * s.r
      g.beginPath()
      g.arc(x, y, s.r * (1 + (1 - age) * 1.5), 0, Math.PI * 2)
      g.fill()
    })
    g.shadowBlur = 0
  }, [t, phase])

  return (
    <Pill size={size}>
      <canvas
        ref={ref}
        className="absolute left-1/2 top-1/2"
        style={{ width: W, height: H, transform: 'translate(-50%,-50%)', opacity: phase === 'idle' ? 0 : easeOut((t - LISTEN_START) / 300) }}
      />
      {phase === 'success' && (
        <span className="absolute inset-y-0 right-4 flex items-center" style={{ opacity: easeOut((since - 250) / 300) }}>
          Inserted
        </span>
      )}
    </Pill>
  )
}
