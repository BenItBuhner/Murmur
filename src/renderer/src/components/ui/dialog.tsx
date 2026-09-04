import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { XIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-card p-6 shadow-xl sm:max-w-lg animate-fade-in',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring/40">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}
function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  )
}
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
}
