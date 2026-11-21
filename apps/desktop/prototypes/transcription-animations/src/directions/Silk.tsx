import { easeOut } from '../clock'
import { IDLE, morphSize, phaseInfo, Pill, type Size } from '../pill'
import { LISTEN_START } from '../script'
import { StrandsCanvas } from './canvas'
import { envAt, rgba, toneRGB } from './strands'

const W = 236
const H = 48

/**
 * Silk: the pill is only the voice. Three strands of light cross into lenses as you speak, the
 * sound rippling outward from the centre; the mood of what you are saying warms or cools the
 * light, and lights the pill's body faintly from below. Stop, and the strands draw back into a
 * line, a glint runs along it while the text is cleaned, and it folds into the check.
 */
export function Silk({ t }: { t: number }): React.JSX.Element {
  const { phase } = phaseInfo(t)
  const size = morphSize(
    t,
    (p): Size =>
      p === 'idle' ? IDLE : p === 'listening' ? [W, H] : p === 'processing' ? [84, 40] : [64, 40],
    420
  )
  const col = toneRGB(t)
  const e = envAt(t)
  return (
    <Pill
      size={size}
      style={{
        background: `radial-gradient(120% 140% at 50% 120%, ${rgba(col, 0.05 + e * 0.1)}, transparent 60%), oklch(0.17 0 0)`
      }}
    >
      <StrandsCanvas
        t={t}
        w={W}
        h={H}
        ownEnding
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          opacity: phase === 'idle' ? 0 : easeOut((t - LISTEN_START) / 120)
        }}
      />
    </Pill>
  )
}
