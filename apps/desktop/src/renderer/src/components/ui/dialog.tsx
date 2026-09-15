import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { XIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

/** A sheet: the largest radius, the overlay elevation, the card padding inside. */
function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
      {/*
        Centred by the layer keyframes alone (transform: translate(--layer-x, --layer-y)); a
        translate utility on top would move it by its whole size, not half.
      */}
      <DialogPrimitive.Content
        className={cn(
          'surface-overlay fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] gap-5 rounded-2xl p-6 sm:max-w-lg [--layer-x:-50%] [--layer-y:-50%] data-[state=open]:animate-layer-in data-[state=closed]:animate-layer-out',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-2 pr-8 text-left', className)} {...props} />
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
      className={cn('serif-display text-heading leading-none', className)}
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
