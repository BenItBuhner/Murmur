import { describe, expect, it } from 'vitest'
import {
  OVERLAY_BAR_DEFAULT_HEIGHT,
  OVERLAY_MARGIN,
  OVERLAY_WINDOW_HEIGHT,
  OVERLAY_WINDOW_WIDTH,
  barCenterFromWindow,
  centerForFractions,
  clampBarCenter,
  clampBarSize,
  defaultOverlayBar,
  edgeAt,
  fractionsForCenter,
  nearestPreset,
  presetBarCenter,
  presetWindowOrigin,
  resizeBar,
  windowOriginForBarCenter
} from '@shared/overlay-bar'

const area = { x: 100, y: 40, width: 1920, height: 1080 }

describe('overlay bar placement', () => {
  it('starts as the centered bottom bar at the size it has always had', () => {
    const bar = defaultOverlayBar()
    expect(bar).toEqual({ anchor: 'preset', x: 0.5, y: 0.5, width: 56, height: 6 })
    const origin = presetWindowOrigin('bottom-center', area, OVERLAY_WINDOW_WIDTH, OVERLAY_WINDOW_HEIGHT)
    expect(origin).toEqual({
      x: Math.round(area.x + (area.width - OVERLAY_WINDOW_WIDTH) / 2),
      y: Math.round(area.y + area.height - OVERLAY_WINDOW_HEIGHT - OVERLAY_MARGIN)
    })
  })

  it('a preset round-trips through the bar center, so the default window does not move', () => {
    for (const position of ['bottom-center', 'top-center', 'bottom-right'] as const) {
      const origin = presetWindowOrigin(position, area, OVERLAY_WINDOW_WIDTH, OVERLAY_WINDOW_HEIGHT)
      const center = presetBarCenter(
        position,
        area,
        OVERLAY_WINDOW_WIDTH,
        OVERLAY_WINDOW_HEIGHT,
        OVERLAY_BAR_DEFAULT_HEIGHT
      )
      const back = windowOriginForBarCenter(
        center,
        OVERLAY_WINDOW_WIDTH,
        OVERLAY_WINDOW_HEIGHT,
        OVERLAY_BAR_DEFAULT_HEIGHT
      )
      expect(back).toEqual(origin)
      expect(barCenterFromWindow({ ...origin, width: OVERLAY_WINDOW_WIDTH, height: OVERLAY_WINDOW_HEIGHT }, 6)).toEqual(
        center
      )
    }
  })

  it('a point away from the presets is free, and the center itself still snaps', () => {
    const bottom = presetBarCenter(
      'bottom-center',
      area,
      OVERLAY_WINDOW_WIDTH,
      OVERLAY_WINDOW_HEIGHT,
      OVERLAY_BAR_DEFAULT_HEIGHT
    )
    expect(
      nearestPreset(bottom, area, OVERLAY_WINDOW_WIDTH, OVERLAY_WINDOW_HEIGHT, OVERLAY_BAR_DEFAULT_HEIGHT)
    ).toBe('bottom-center')
    const left = { x: area.x + 80, y: area.y + 200 }
    expect(
      nearestPreset(left, area, OVERLAY_WINDOW_WIDTH, OVERLAY_WINDOW_HEIGHT, OVERLAY_BAR_DEFAULT_HEIGHT)
    ).toBeNull()
    const fractions = fractionsForCenter(left, area)
    expect(fractions.x).toBeLessThan(0.2)
    expect(fractions.y).toBeLessThan(0.3)
    const back = centerForFractions(fractions.x, fractions.y, area)
    expect(back.x).toBeCloseTo(left.x, 0)
    expect(back.y).toBeCloseTo(left.y, 0)
  })

  it('keeps the bar inside the work area and the size inside its range', () => {
    const clamped = clampBarCenter(
      { x: area.x - 40, y: area.y + area.height + 80 },
      area,
      56,
      6
    )
    expect(clamped.x).toBeGreaterThan(area.x)
    expect(clamped.y).toBeLessThan(area.y + area.height)
    expect(clampBarSize(1, 100)).toEqual({ width: 24, height: 32 })
    expect(clampBarSize(56, 6)).toEqual({ width: 56, height: 6 })
  })

  it('an edge drag changes that edge, and the bar body is not an edge', () => {
    expect(resizeBar('e', { width: 56, height: 6 }, 20, 0)).toEqual({ width: 76, height: 6 })
    expect(resizeBar('w', { width: 56, height: 6 }, 10, 0)).toEqual({ width: 46, height: 6 })
    expect(resizeBar('n', { width: 56, height: 6 }, 0, -8)).toEqual({ width: 56, height: 14 })
    expect(resizeBar('s', { width: 56, height: 6 }, 0, 4)).toEqual({ width: 56, height: 10 })
    expect(edgeAt(20, 3, 56, 6, 8)).toBe('body')
    expect(edgeAt(-4, 3, 56, 6, 8)).toBe('w')
    expect(edgeAt(20, -4, 56, 6, 8)).toBe('n')
    expect(edgeAt(60, 10, 56, 6, 8)).toBe('se')
    expect(edgeAt(-20, 3, 56, 6, 8)).toBeNull()
  })
})
