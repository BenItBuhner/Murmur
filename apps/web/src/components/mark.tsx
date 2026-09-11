import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

/*
 * The app icon, drawn with the same geometry apps/desktop/scripts/gen-icons.mjs rasterises: a
 * rounded square (radius 24% of the side) and five bars 9% wide with 6% gaps, heights 28/50/68/50/28%,
 * with round caps. Colours follow the theme the way the desktop `Logo` component does (ink square,
 * paper bars), so in dark mode the mark inverts with the rest of the page.
 */
export const MARK_BARS = [28, 50, 68, 50, 28] as const
const BAR_WIDTH = 9
const BAR_GAP = 6
const BAR_X0 = (100 - (MARK_BARS.length * BAR_WIDTH + (MARK_BARS.length - 1) * BAR_GAP)) / 2

export function Mark({
  size = 28,
  className,
  style
}: {
  size?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', className)}
      style={style}
    >
      <rect width="100" height="100" rx="24" className="fill-primary" />
      {MARK_BARS.map((height, i) => (
        <rect
          key={i}
          x={BAR_X0 + i * (BAR_WIDTH + BAR_GAP)}
          y={(100 - height) / 2}
          width={BAR_WIDTH}
          height={height}
          rx={BAR_WIDTH / 2}
          className="fill-primary-foreground"
        />
      ))}
    </svg>
  )
}

/** The name, set in the display serif exactly as the app's sidebar sets it. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('serif-display text-[23px] leading-none', className)}>Murmur</span>
}
