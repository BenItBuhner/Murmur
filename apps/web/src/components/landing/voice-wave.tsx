import { cn } from '@/lib/cn'

/*
 * A spoken line across a band (Aurora): one sine-like path drawn twice side by side so the drift
 * loops without a seam. Decorative only; still under reduced motion (globals.css).
 */
const PERIOD = 240
const CYCLES = 8
const MID = 60

function wavePath(amp: (i: number) => number): string {
  const parts: string[] = [`M0 ${MID}`]
  for (let i = 0; i < CYCLES * 2; i++) {
    const x = (i * PERIOD) / 2
    const a = amp(i) * (i % 2 === 0 ? -1 : 1)
    parts.push(`Q${x + PERIOD / 4} ${MID + a} ${x + PERIOD / 2} ${MID}`)
  }
  return parts.join(' ')
}

// Amplitudes repeat every CYCLES half-waves so the two copies meet cleanly.
const SHAPE = [18, 34, 12, 44, 26, 52, 20, 30]
const MAIN = wavePath((i) => SHAPE[i % SHAPE.length]!)
const ECHO = wavePath((i) => SHAPE[(i + 3) % SHAPE.length]! * 0.6)

export function VoiceWave({ className }: { className?: string }) {
  const width = PERIOD * CYCLES
  return (
    <div className={cn('voice-wave -z-10', className)} aria-hidden="true">
      <svg viewBox={`0 0 ${width * 2} 120`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="voice-wave-stroke" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--brand-violet)" />
            <stop offset="0.5" stopColor="var(--brand-coral)" />
            <stop offset="1" stopColor="var(--brand-violet)" />
          </linearGradient>
        </defs>
        {[0, width].map((dx) => (
          <g key={dx} transform={`translate(${dx} 0)`} fill="none" strokeLinecap="round">
            <path d={MAIN} stroke="url(#voice-wave-stroke)" strokeWidth="1.5" opacity="0.55" />
            <path d={ECHO} stroke="url(#voice-wave-stroke)" strokeWidth="1" opacity="0.3" />
          </g>
        ))}
      </svg>
    </div>
  )
}
