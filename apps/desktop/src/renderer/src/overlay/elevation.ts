import type { OverlayState } from '@shared/types'

/**
 * The pill's elevation. It floats over other windows: a drop shadow and, once it has grown out of
 * the idle bar, a thin light catch along its top edge in place of an outline, so it reads as a
 * surface with a light on it. The idle bar is a thin line and only gets a tight shadow underneath.
 * With the "Button shadow" setting off the pill keeps its shape and colours and drops both, in
 * every state: no shadow, no light catch, a flat pill.
 */
export const IDLE_SHADOW = 'shadow-[0_1px_4px_rgba(0,0,0,0.35)]'
export const PILL_SHADOW =
  'shadow-[0_6px_24px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]'

/** The shadow classes for `state`, or none at all when the button shadow is turned off. */
export function pillElevation(state: Pick<OverlayState, 'phase'>, shadow: boolean): string {
  if (!shadow) return ''
  return state.phase === 'idle' ? IDLE_SHADOW : PILL_SHADOW
}
