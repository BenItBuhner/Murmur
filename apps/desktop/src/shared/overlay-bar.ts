/**
 * Placement and size of the desktop idle bar (the thin bar the listening pill grows out of).
 *
 * A preset uses the three spots the bar has always had, so an install that has never moved it
 * stays centered at the bottom at the same size. A free placement stores the bar's center as
 * fractions of the work area, which is how a drag leaves the center. The numbers are the ones
 * the Android keyboard overlay uses too.
 */

export const OVERLAY_WINDOW_WIDTH = 360
export const OVERLAY_WINDOW_HEIGHT = 120
export const OVERLAY_LIMIT_WIDTH = 600
export const OVERLAY_LIMIT_HEIGHT = 160
/** Gap between the overlay window and the work-area edge for a preset. */
export const OVERLAY_MARGIN = 28
/** The pill sits this far in from the bottom of the overlay window (`pb-3`). */
export const OVERLAY_PAD = 12

export const OVERLAY_BAR_DEFAULT_WIDTH = 56
export const OVERLAY_BAR_DEFAULT_HEIGHT = 6
export const OVERLAY_BAR_WIDTH = { min: 24, max: 280 } as const
export const OVERLAY_BAR_HEIGHT = { min: 2, max: 32 } as const
/** A release within this many pixels of a preset lands on that preset. */
export const OVERLAY_BAR_SNAP_PX = 24

export const OVERLAY_POSITIONS = ['bottom-center', 'top-center', 'bottom-right'] as const
export type OverlayPositionName = (typeof OVERLAY_POSITIONS)[number]

export type OverlayBarAnchor = 'preset' | 'free'

export interface OverlayBar {
  anchor: OverlayBarAnchor
  /** Center of the idle bar, as fractions of the work area. Ignored while `anchor` is `preset`. */
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export type BarEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export function defaultOverlayBar(): OverlayBar {
  return {
    anchor: 'preset',
    x: 0.5,
    y: 0.5,
    width: OVERLAY_BAR_DEFAULT_WIDTH,
    height: OVERLAY_BAR_DEFAULT_HEIGHT
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function clampBarSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(clamp(width, OVERLAY_BAR_WIDTH.min, OVERLAY_BAR_WIDTH.max)),
    height: Math.round(clamp(height, OVERLAY_BAR_HEIGHT.min, OVERLAY_BAR_HEIGHT.max))
  }
}

/** Where the overlay window's top-left goes for a preset. This is the placement the bar has always used. */
export function presetWindowOrigin(
  position: OverlayPositionName,
  area: WorkArea,
  windowWidth: number,
  windowHeight: number
): Point {
  let x = Math.round(area.x + (area.width - windowWidth) / 2)
  let y = Math.round(area.y + area.height - windowHeight - OVERLAY_MARGIN)
  if (position === 'top-center') y = area.y + OVERLAY_MARGIN
  if (position === 'bottom-right') x = area.x + area.width - windowWidth - OVERLAY_MARGIN
  return { x, y }
}

/** Screen-space center of the idle bar, given the window that draws it at the bottom. */
export function barCenterFromWindow(
  origin: Point & { width: number; height: number },
  barHeight: number
): Point {
  return {
    x: origin.x + origin.width / 2,
    y: origin.y + origin.height - OVERLAY_PAD - barHeight / 2
  }
}

/** Window top-left that puts the idle bar's center on [center]. The bar stays bottom-aligned in the window. */
export function windowOriginForBarCenter(
  center: Point,
  windowWidth: number,
  windowHeight: number,
  barHeight: number
): Point {
  return {
    x: Math.round(center.x - windowWidth / 2),
    y: Math.round(center.y - (windowHeight - OVERLAY_PAD - barHeight / 2))
  }
}

export function presetBarCenter(
  position: OverlayPositionName,
  area: WorkArea,
  windowWidth: number,
  windowHeight: number,
  barHeight: number
): Point {
  const origin = presetWindowOrigin(position, area, windowWidth, windowHeight)
  return barCenterFromWindow({ ...origin, width: windowWidth, height: windowHeight }, barHeight)
}

export function centerForFractions(x: number, y: number, area: WorkArea): Point {
  return { x: area.x + x * area.width, y: area.y + y * area.height }
}

export function fractionsForCenter(center: Point, area: WorkArea): { x: number; y: number } {
  const x = area.width > 0 ? (center.x - area.x) / area.width : 0.5
  const y = area.height > 0 ? (center.y - area.y) / area.height : 0.5
  return {
    x: Math.round(clamp(x, 0, 1) * 10000) / 10000,
    y: Math.round(clamp(y, 0, 1) * 10000) / 10000
  }
}

/** Pull a center in so the whole idle bar stays inside the work area. */
export function clampBarCenter(
  center: Point,
  area: WorkArea,
  barWidth: number,
  barHeight: number,
  edge = 6
): Point {
  const halfW = barWidth / 2
  const halfH = barHeight / 2
  const loX = area.x + edge + halfW
  const hiX = area.x + area.width - edge - halfW
  const loY = area.y + edge + halfH
  const hiY = area.y + area.height - edge - halfH
  return {
    x: hiX < loX ? area.x + area.width / 2 : clamp(center.x, loX, hiX),
    y: hiY < loY ? area.y + area.height / 2 : clamp(center.y, loY, hiY)
  }
}

/**
 * The preset whose idle-bar center is within [snapPx] of [center], or null when the bar has
 * left every preset. The closest one wins.
 */
export function nearestPreset(
  center: Point,
  area: WorkArea,
  windowWidth: number,
  windowHeight: number,
  barHeight: number,
  snapPx = OVERLAY_BAR_SNAP_PX
): OverlayPositionName | null {
  let best: OverlayPositionName | null = null
  let bestDistance = snapPx
  for (const position of OVERLAY_POSITIONS) {
    const preset = presetBarCenter(position, area, windowWidth, windowHeight, barHeight)
    const distance = Math.hypot(preset.x - center.x, preset.y - center.y)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = position
    }
  }
  return best
}

/**
 * New idle-bar size after a drag of one edge by (dx, dy) pixels. The bar is centered in the
 * window and grows upward from its bottom edge, so either horizontal edge changes the width and
 * either vertical edge changes the height.
 */
export function resizeBar(
  edge: BarEdge,
  start: { width: number; height: number },
  dx: number,
  dy: number
): { width: number; height: number } {
  let width = start.width
  let height = start.height
  if (edge.includes('e')) width += dx
  if (edge.includes('w')) width -= dx
  if (edge.includes('s')) height += dy
  if (edge.includes('n')) height -= dy
  return clampBarSize(width, height)
}

/**
 * Which edge of the idle bar a pointer is on. Coordinates are relative to the bar's top-left,
 * so the padding ring around it is negative or past the far edge. The bar itself is the body.
 * Returns null when the pointer is outside the padding too.
 */
export function edgeAt(
  localX: number,
  localY: number,
  width: number,
  height: number,
  pad: number
): BarEdge | 'body' | null {
  if (localX < -pad || localY < -pad || localX > width + pad || localY > height + pad) return null
  const outsideL = localX < 0
  const outsideR = localX > width
  const outsideT = localY < 0
  const outsideB = localY > height
  if (!outsideL && !outsideR && !outsideT && !outsideB) return 'body'
  const horizontal = outsideL ? 'w' : outsideR ? 'e' : ''
  const vertical = outsideT ? 'n' : outsideB ? 's' : ''
  const edge = `${vertical}${horizontal}`
  if (
    edge === 'n' ||
    edge === 's' ||
    edge === 'e' ||
    edge === 'w' ||
    edge === 'ne' ||
    edge === 'nw' ||
    edge === 'se' ||
    edge === 'sw'
  ) {
    return edge
  }
  return 'body'
}
