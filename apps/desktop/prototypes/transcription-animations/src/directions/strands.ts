import {
  levelAt,
  LISTEN_END,
  LISTEN_START,
  PROCESS_END,
  SUCCESS_END,
  type Tone,
  toneAt
} from '../script'

/**
 * The shared voice: three silk strands of light, drawn on a canvas. Everything is a pure function
 * of t (the take's clock), so a frame renders the same in the browser, the recorder, and an
 * exported transparent frame.
 *
 * What it borrows from studying the reference, and where it parts from it:
 * - attack is near-instant (~40ms) and release slow (~220ms), so syllables pop and words breathe;
 * - several phase-shifted strands cross into lens shapes, with amplitude tapered to the ends;
 * - but the strands are continuous light, not a dot matrix, and the voice ripples *outward from the
 *   centre*: the middle is now, the edges are a few hundred ms ago, so speech visibly travels.
 */

export type RGB = [number, number, number]

/** Restrained tone lights: one hue each, low saturation, never a rainbow. */
export const TONE_RGB: Record<Tone, RGB> = {
  neutral: [244, 238, 228], // warm ivory
  frustrated: [255, 146, 104], // ember
  excited: [255, 206, 128], // honey
  asking: [172, 182, 255] // periwinkle
}
export const TONE_LABEL: Record<Tone, string> = {
  neutral: 'Calm',
  frustrated: 'Frustrated',
  excited: 'Excited',
  asking: 'Asking'
}

const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v))
const smooth = (p: number): number => {
  const x = clamp(p)
  return x * x * (3 - 2 * x)
}

/** Envelope with a fast attack and a slow release, the way the reference's level behaves. */
export function envAt(t: number): number {
  let e = 0
  for (let k = 0; k <= 16; k++) {
    // release: look back up to ~260ms, decaying
    const v = levelAt(t - k * 16) * Math.exp(-k / 4.5)
    if (v > e) e = v
  }
  // attack: a 40ms look-ahead-free ramp is already implicit at 60fps; shape the response
  return Math.pow(e, 0.62)
}

/** Tone colour at t, eased over ~700ms so the mood drifts in, never flips. */
export function toneRGB(t: number, amount = 1): RGB {
  const acc = [0, 0, 0]
  let n = 0
  for (let k = 0; k < 24; k++) {
    const c = TONE_RGB[toneAt(t - k * 30)]
    const w = 24 - k
    acc[0] += c[0] * w
    acc[1] += c[1] * w
    acc[2] += c[2] * w
    n += w
  }
  const base = TONE_RGB.neutral
  return [0, 1, 2].map((i) => base[i] + (acc[i] / n - base[i]) * amount) as RGB
}
export const rgba = (c: RGB, a: number): string =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a)})`

interface Opts {
  /** Canvas size in CSS px. */
  w: number
  h: number
  /** Overall amplitude as a fraction of half the height. */
  gain?: number
  /** How strongly the tone tints the light (0..1). */
  tint?: number
  /** Whether to draw the processing/success choreography (Silk owns the whole pill). */
  ownEnding?: boolean
}

/**
 * Draws the strands for time t into g (already scaled for DPR). Returns nothing; pure drawing.
 * The lifecycle: a spark at the centre that stretches into a line (open), the strands (listening),
 * the line drawing itself back to a point (stop), a slow travelling glint (processing), and the
 * line folding into a check (inserted).
 */
export function drawStrands(g: CanvasRenderingContext2D, t: number, o: Opts): void {
  const { w, h } = o
  const gain = o.gain ?? 0.9
  const cx = w / 2
  const cy = h / 2
  g.clearRect(0, 0, w, h)
  const col = toneRGB(t, o.tint ?? 1)
  g.globalCompositeOperation = 'lighter'
  g.lineCap = 'round'
  g.lineJoin = 'round'

  // ---- open: spark, then the line stretches out --------------------------------------------
  const open = clamp((t - LISTEN_START) / 420)
  const stop = clamp((t - LISTEN_END) / 380)
  if (t < LISTEN_START) return

  if (t < LISTEN_END + 380) {
    const half = (w / 2 - 6) * smooth(open) * (1 - smooth(stop) * 0.98)
    if (open < 1) {
      // the spark: a soft star at the centre, fading as the line takes over
      const s = 1 - smooth(open)
      const r = 10 + 10 * s
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, r)
      glow.addColorStop(0, rgba(col, 0.9 * s + 0.1))
      glow.addColorStop(1, rgba(col, 0))
      g.fillStyle = glow
      g.fillRect(cx - r, cy - r, r * 2, r * 2)
      g.strokeStyle = rgba(col, 0.5 * s)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, cy - 9 * s)
      g.lineTo(cx, cy + 9 * s)
      g.stroke()
    }
    strands(g, t, cx, cy, half, (h / 2) * gain, col, 1 - smooth(stop))
    return
  }
  if (!o.ownEnding) return

  // ---- processing: a short line with a glint travelling along it ----------------------------
  if (t < PROCESS_END) {
    const p = (t - LISTEN_END - 380) / 900
    const half = 14 + 4 * Math.sin(p * Math.PI * 2)
    line(g, cx - half, cx + half, cy, col, 0.55)
    const gx = cx - half + ((p * 1.4) % 1) * half * 2
    const glow = g.createRadialGradient(gx, cy, 0, gx, cy, 9)
    glow.addColorStop(0, rgba(col, 0.9))
    glow.addColorStop(1, rgba(col, 0))
    g.fillStyle = glow
    g.fillRect(gx - 9, cy - 9, 18, 18)
    return
  }
  // ---- inserted: the line folds into a check -------------------------------------------------
  const p = smooth((t - PROCESS_END) / 380)
  const fade = 1 - smooth((t - SUCCESS_END + 300) / 300)
  const green: RGB = [176, 236, 196]
  const c: RGB = [0, 1, 2].map((i) => col[i] + (green[i] - col[i]) * p) as RGB
  const a: [number, number] = [cx - 14 + 8 * p, cy + 0 * p]
  const b: [number, number] = [cx - 2 * p, cy + 6 * p]
  const d: [number, number] = [cx + 14 - 3 * p, cy - 7 * p]
  for (const [lw, al] of [
    [6, 0.12],
    [2, 0.95]
  ] as const) {
    g.strokeStyle = rgba(c, al * fade)
    g.lineWidth = lw
    g.beginPath()
    g.moveTo(...a)
    g.lineTo(...b)
    g.lineTo(...d)
    g.stroke()
  }
  bloom(g, 3, 0.5)
}

function line(
  g: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  col: RGB,
  a: number
): void {
  for (const [lw, al] of [
    [6, 0.08],
    [1.6, 1]
  ] as const) {
    g.strokeStyle = rgba(col, a * al)
    g.lineWidth = lw
    g.beginPath()
    g.moveTo(x0, y)
    g.lineTo(x1, y)
    g.stroke()
  }
}

let scratch: HTMLCanvasElement | null = null

/** Soft bloom: a blurred copy of what was drawn, added back on top (the depth of the light). */
export function bloom(g: CanvasRenderingContext2D, px: number, a: number): void {
  const cv = g.canvas
  if (!scratch) scratch = document.createElement('canvas')
  scratch.width = cv.width
  scratch.height = cv.height
  const s = scratch.getContext('2d')!
  s.drawImage(cv, 0, 0)
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.globalAlpha = a
  g.filter = `blur(${px * (cv.width / cv.clientWidth || 2)}px)`
  g.drawImage(scratch, 0, 0)
  g.restore()
}

/** Three strands: back (dim, soft), middle, front (bright core). */
function strands(
  g: CanvasRenderingContext2D,
  t: number,
  cx: number,
  cy: number,
  half: number,
  amp: number,
  col: RGB,
  life: number
): void {
  if (half < 0.5) return
  const N = Math.max(16, Math.round(half))
  const sec = t / 1000
  const now = envAt(t)
  // the voice ripples outward: sample the envelope history once, interpolate across x
  const HIST = 24
  const raw = Array.from({ length: HIST + 5 }, (_, k) => envAt(t - ((k - 2) / HIST) * 340))
  // low-pass across x so the ripple stays a smooth swell, never a kink
  const hist = Array.from(
    { length: HIST + 1 },
    (_, k) => [1, 4, 6, 4, 1].reduce((acc, w, j) => acc + w * raw[k + j], 0) / 16
  )
  const histAt = (d: number): number => {
    const f = d * HIST
    const i = Math.floor(f)
    return hist[i] + ((hist[Math.min(HIST, i + 1)] ?? 0) - hist[i]) * (f - i)
  }
  // a mirrored pair (front) makes lenses that open and close with the voice; a third, free strand
  // sits behind it at a different speed for depth
  const defs = [
    { f: 1.25, v: 1.5, ph: 0.0, a: 1.0, m: 1, core: 1.8, alpha: 1, blur: 0 },
    { f: 1.25, v: 1.5, ph: 0.0, a: 1.0, m: -1, core: 1.8, alpha: 1, blur: 0 },
    { f: 2.1, v: -2.4, ph: 2.1, a: 0.72, m: 1, core: 1.2, alpha: 0.5, blur: 0.8 },
    { f: 2.9, v: 3.1, ph: 4.0, a: 0.5, m: 1, core: 1.0, alpha: 0.32, blur: 1.4 }
  ]
  const pts = defs.map((d) => {
    const out: [number, number][] = []
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1
      const dist = Math.abs(u)
      const e = histAt(dist)
      const taper = Math.pow(Math.cos((u * Math.PI) / 2), 1.3)
      const idle = 0.04 * (0.6 + 0.4 * Math.sin(sec * 1.6 + u * 3))
      // |sin| keeps the mirrored pair apart, so they pinch at nodes and swell into lenses
      const wave = Math.sin(u * Math.PI * d.f + sec * d.v + d.ph)
      const shape = d.m === 1 && d.f !== 1.25 ? wave : wave * wave * d.m * 1.15
      const y =
        cy + shape * amp * d.a * taper * (Math.tanh(1.3 * (idle + e)) / Math.tanh(1.3)) * life
      out.push([cx + u * half, y])
    }
    return out
  })
  // brightness follows the voice: quiet is a dim thread, speech is lit
  const lum = (0.45 + 0.75 * Math.min(1, now * 1.3)) * Math.max(0.3, life)
  const fadeEnds = (a: number): CanvasGradient => {
    const gr = g.createLinearGradient(cx - half, 0, cx + half, 0)
    gr.addColorStop(0, rgba(col, 0))
    gr.addColorStop(0.12, rgba(col, a))
    gr.addColorStop(0.88, rgba(col, a))
    gr.addColorStop(1, rgba(col, 0))
    return gr
  }
  // the lens between the front two strands, for volume
  g.fillStyle = fadeEnds(0.06 * lum)
  g.beginPath()
  pts[0].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  for (let i = pts[1].length - 1; i >= 0; i--) g.lineTo(pts[1][i][0], pts[1][i][1])
  g.closePath()
  g.fill()
  for (let s = defs.length - 1; s >= 0; s--) {
    const d = defs[s]
    g.filter = d.blur ? `blur(${d.blur}px)` : 'none'
    g.strokeStyle = fadeEnds(d.alpha * lum)
    g.lineWidth = d.core
    g.beginPath()
    pts[s].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
    g.stroke()
  }
  g.filter = 'none'
  bloom(g, 5, 0.6 + 0.5 * now)
}
