import { Overlay } from '@renderer/overlay/Overlay'
import type { OverlayState } from '@shared/types'
import { LISTEN_START, levelAt, phaseAt } from './script'

/** The real, current overlay pill (desktop Overlay.tsx), driven by the shared script. */
export function Baseline({ t }: { t: number }): React.JSX.Element {
  const phase = phaseAt(t)
  const state: OverlayState =
    phase === 'listening'
      ? { phase, mode: 'hold', elapsedSec: Math.floor((t - LISTEN_START) / 1000) }
      : { phase }
  return (
    <div className="dark h-full w-full">
      <Overlay state={state} level={levelAt(t)} />
    </div>
  )
}
