import type { CSSProperties, ElementType, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type SurfaceLevel = 'raised' | 'inset' | 'sunken' | 'ink' | 'overlay'

/* Spelled out so Tailwind's scanner finds every utility (a template string would hide them). */
const LEVEL_CLASS: Record<SurfaceLevel, string> = {
  raised: 'surface-raised',
  inset: 'surface-inset',
  sunken: 'surface-sunken',
  ink: 'surface-ink',
  overlay: 'surface-overlay'
}

type CssVars = CSSProperties & Record<`--${string}`, string>

interface SurfaceProps {
  /** Outer corner radius in px. */
  radius?: number
  /** Padding in px; the inner radius children may use (`rounded-(--ri)`) is radius minus this. */
  padding?: number
  level?: SurfaceLevel
  as?: ElementType
  className?: string
  style?: CSSProperties
  children?: ReactNode
  id?: string
}

/**
 * A sheet of paper. It knows its radius and padding, so anything set flush inside it can take the
 * concentric inner radius instead of reusing the outer one. Nest another Surface with
 * `radius={inner(radius, padding)}` and the corners stay parallel all the way down.
 */
export function Surface({
  radius = 32,
  padding = 20,
  level = 'raised',
  as: Tag = 'div',
  className,
  style,
  children,
  id
}: SurfaceProps) {
  const vars: CssVars = { '--r': `${radius}px`, '--p': `${padding}px`, ...style }
  return (
    <Tag
      id={id}
      className={cn('surface rounded-(--r) p-(--p)', LEVEL_CLASS[level], className)}
      style={vars}
    >
      {children}
    </Tag>
  )
}

/** The radius of something set inside a surface with `radius` and `padding`, never sharper than 4px. */
export function inner(radius: number, padding: number): number {
  return Math.max(4, radius - padding)
}
