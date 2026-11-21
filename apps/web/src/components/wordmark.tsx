import { cn } from '@/lib/cn'

/**
 * The Murmur mark: a lowercase m drawn as two soft arches, with a quieter third bar that reads as the
 * voice trailing off, on the voice gradient (coral into violet into indigo). Same geometry as
 * src/app/icon.svg; see DESIGN.md before changing either. `id` keeps the gradient unique per use.
 */
export function Mark({
  size = 30,
  id = 'murmur-mark',
  className
}: {
  size?: number
  id?: string
  className?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF8A6B" />
          <stop offset=".55" stopColor="#8B5CFF" />
          <stop offset="1" stopColor="#5B3DF5" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#${id})`} />
      <path
        d="M9 22v4M15 18v12M21 14v20M27 19v10"
        stroke="#fff"
        strokeWidth="3.6"
        strokeLinecap="round"
        opacity=".78"
      />
      <path d="M36 12v24M33 12h6M33 36h6" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  )
}

/** Mark plus the name in the display face, semibold and tracked in. */
export function Wordmark({ className, id }: { className?: string; id?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Mark id={id} size={28} />
      <span className="font-display text-[21px] leading-none font-semibold tracking-[-0.035em]">
        Murmur
      </span>
    </span>
  )
}
