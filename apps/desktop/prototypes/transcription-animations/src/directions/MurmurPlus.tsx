import { easeOut, prog } from '../clock'
import { Check, IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { LISTEN_START, PROCESS_END } from '../script'
import { StrandsCanvas } from './canvas'
import { envAt, rgba, toneRGB } from './strands'

/**
 * Murmur, refined: today's pill, layout and states kept (dot, voice, timer, "Transcribing…",
 * "Inserted"), with the bars replaced by the silk strands and the record dot turned into the mood
 * light: coral-ivory at rest, it takes the tone of what is being said and glows with the voice.
 */
export function MurmurPlus({ t }: { t: number }): React.JSX.Element {
  const { phase, since } = phaseInfo(t)
  const size = morphSize(
    t,
    (p): Size =>
      p === 'idle'
        ? IDLE
        : p === 'listening'
          ? [234, 44]
          : p === 'processing'
            ? [150, 44]
            : [118, 44],
    340
  )
  const col = toneRGB(t)
  const e = envAt(t)
  const elapsed = Math.max(0, Math.floor((t - LISTEN_START) / 1000))
  const dot = rgba(col, 1)
  return (
    <Pill size={size}>
      {phase === 'listening' && (
        <div
          className="absolute inset-0 flex items-center gap-2.5 pl-4 pr-4"
          style={{ opacity: easeOut(since / 260) }}
        >
          <span
            className="block size-2.5 shrink-0 rounded-full"
            style={{
              background: dot,
              boxShadow: `0 0 ${6 + e * 14}px ${1 + e * 3}px ${rgba(col, 0.35 + e * 0.35)}`
            }}
          />
          <StrandsCanvas t={t} w={140} h={32} gain={0.9} />
          <span className="tabular-nums text-white/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        </div>
      )}
      {phase === 'processing' && (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2.5"
          style={{ opacity: easeOut(since / 220) }}
        >
          <span
            className="relative block h-[2px] w-6 overflow-hidden rounded-full"
            style={{ background: rgba(col, 0.25) }}
          >
            <span
              className="absolute inset-y-0 w-3 rounded-full"
              style={{
                left: `${((since / 700) % 1) * 130 - 30}%`,
                background: rgba(col, 1),
                boxShadow: `0 0 8px ${rgba(col, 1)}`
              }}
            />
          </span>
          <span className="text-white/85">Transcribing…</span>
        </div>
      )}
      {phase === 'success' && (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2"
          style={{ opacity: easeOut(since / 220) }}
        >
          <Check p={prog(t, PROCESS_END + 120, 320)} />
          <span>Inserted</span>
        </div>
      )}
    </Pill>
  )
}
