import * as React from 'react'
import { cn } from '@renderer/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-xl border border-border bg-card px-3.5 py-1 text-sm transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-0',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-20 w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-0',
        className
      )}
      {...props}
    />
  )
}

export { Input, Textarea }
