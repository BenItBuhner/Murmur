import type { OverlayState } from '@shared/types'

/**
 * The pill's body colour. It is a solid surface in every state: no alpha, no translucent fill, no
 * backdrop blur, whether the shadow (elevation.ts) is on or off, so nothing behind the pill and
 * none of its own shadow ever shows through the body. The colours are the overlay tokens in
 * globals.css (dark ink-on-surface pill, its command, success, error and disabled tints); a
 * microphone fault turns the idle bar the destructive colour.
 */
export const PILL_SURFACES = {
  idle: 'bg-overlay',
  micError: 'bg-destructive',
  active: 'bg-overlay',
  command: 'bg-overlay-command',
  success: 'bg-overlay-success',
  error: 'bg-overlay-error',
  disabled: 'bg-overlay-disabled text-overlay-foreground/70'
} as const

/** The background class for `state`; `micError` colours the idle bar only. */
export function pillSurface(
  state: Pick<OverlayState, 'phase' | 'mode' | 'limit'>,
  micError = false
): string {
  switch (state.phase) {
    case 'idle':
      return micError ? PILL_SURFACES.micError : PILL_SURFACES.idle
    case 'listening':
      return state.mode === 'command' ? PILL_SURFACES.command : PILL_SURFACES.active
    case 'success':
      return PILL_SURFACES.success
    case 'error':
      // A plan limit is not a fault: it keeps the pill's own colour and speaks calmly.
      return state.limit ? PILL_SURFACES.active : PILL_SURFACES.error
    case 'disabled':
      return PILL_SURFACES.disabled
    default:
      return PILL_SURFACES.active
  }
}
