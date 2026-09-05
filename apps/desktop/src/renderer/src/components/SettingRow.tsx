import React from 'react'
import { cn } from '@renderer/lib/utils'

interface RowProps {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
  vertical?: boolean
}

/** One labelled setting. Control sits on the right unless `vertical` (for wide inputs). */
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
        'flex gap-6 py-4 first:pt-0 last:pb-0',
        vertical ? 'flex-col gap-3' : 'items-center justify-between',
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium leading-none">{title}</div>
        {description && (
          <div className="text-[13px] leading-snug text-muted-foreground">{description}</div>
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
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="rounded-xl border bg-card px-5 py-4 shadow-xs divide-y">{children}</div>
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
    <div className="mb-7 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

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
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
      {icon && <div className="mb-1 text-muted-foreground [&>svg]:size-7">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
