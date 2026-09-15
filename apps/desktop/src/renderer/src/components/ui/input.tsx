import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/*
 * Fields are wells: sunk into whatever holds them, with no drawn edge. Focus adds a ring; an
 * invalid value tints it.
 */
const fieldClass =
  'well rounded-md text-sm text-foreground transition-[background-color,box-shadow] outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/35 aria-invalid:ring-2 aria-invalid:ring-destructive/40'

function Input({ className, type, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        'flex h-9 w-full min-w-0 px-3.5 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium',
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
      className={cn(fieldClass, 'flex min-h-20 w-full px-3.5 py-2.5', className)}
      {...props}
    />
  )
}

export { Input, Textarea }
