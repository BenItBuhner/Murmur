import React from 'react'
import { cn } from '@renderer/lib/utils'

interface RowProps {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
  vertical?: boolean
}

/**
 * One labelled setting. Control sits on the right unless `vertical` (for wide inputs). Rows are
 * set apart by rhythm alone: no rules between them.
 */
export function SettingRow({
  title,
  description,
  children,
  className,
  vertical
}: RowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex gap-6 py-row first:pt-0 last:pb-0',
        vertical ? 'flex-col gap-3' : 'items-center justify-between',
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium leading-none">{title}</div>
        {description && (
          <div className="text-note leading-snug text-muted-foreground">{description}</div>
        )}
      </div>
      {children && (
        <div className={cn('flex shrink-0 items-center gap-2', vertical && 'w-full')}>
          {children}
        </div>
      )}
    </div>
  )
}

/** An eyebrow, an optional line of context, and a raised card holding the rows. */
export function Section({
  title,
  description,
  children,
  actions
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="eyebrow">{title}</h2>
          {description && <p className="mt-2 text-note text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="surface-raised rounded-xl px-card py-card">{children}</div>
    </section>
  )
}

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-section flex items-start justify-between gap-6">
      <div>
        <h1 className="serif-display text-title">{title}</h1>
        {description && (
          <p className="mt-2.5 max-w-xl text-lead leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Nothing here yet: a well sunk into the page where the content will be. */
export function Empty({
  icon,
  title,
  description,
  action
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="well flex flex-col items-center justify-center gap-2 rounded-xl px-6 py-16 text-center">
      {icon && (
        <div className="mb-2 text-muted-foreground/70 [&>svg]:size-7 [&>svg]:stroke-[1.5]">
          {icon}
        </div>
      )}
      <div className="serif-display text-heading">{title}</div>
      {description && <p className="max-w-sm text-note text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
