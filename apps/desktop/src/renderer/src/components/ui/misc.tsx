import * as React from 'react'
import {
  Separator as SeparatorPrimitive,
  Tooltip as TooltipPrimitive,
  Tabs as TabsPrimitive
} from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

// ---- Card -----------------------------------------------------------------------------------

function Card({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn('rounded-2xl border bg-card text-card-foreground', className)}
      {...props}
    />
  )
}
function CardHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5', className)} {...props} />
}
function CardTitle({ className, ...props }: React.ComponentProps<'h3'>): React.JSX.Element {
  return (
    <h3
      className={cn('text-[15px] font-semibold leading-tight tracking-tight', className)}
      {...props}
    />
  )
}
function CardDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}
function CardContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('px-5 pb-5 pt-4', className)} {...props} />
}

// ---- Badge ----------------------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium w-fit whitespace-nowrap gap-1.5 [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-input text-muted-foreground',
        success: 'border-transparent bg-success/12 text-success',
        destructive: 'border-transparent bg-destructive/12 text-destructive',
        record: 'border-transparent bg-record/12 text-record'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)
function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>): React.JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

// ---- Separator ------------------------------------------------------------------------------

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>): React.JSX.Element {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className
      )}
      {...props}
    />
  )
}

// ---- Tooltip --------------------------------------------------------------------------------

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger
function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit max-w-xs rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-md animate-fade-in text-balance',
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

// ---- Tabs -----------------------------------------------------------------------------------

const Tabs = TabsPrimitive.Root
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-9 w-fit items-center justify-center rounded-full border bg-card p-[3px] text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-transparent px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground',
        className
      )}
      {...props}
    />
  )
}
function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return <TabsPrimitive.Content className={cn('flex-1 outline-none', className)} {...props} />
}

// ---- Segmented control (used a lot in settings) --------------------------------------------

interface SegmentedProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; hint?: string }>
  className?: string
}
function Segmented<T extends string>({
  value,
  onChange,
  options,
  className
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      className={cn(
        'inline-flex h-9 items-center rounded-full border bg-card p-[3px] text-[13px]',
        className
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-full px-3.5 font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground',
            value === o.value && 'bg-primary text-primary-foreground hover:text-primary-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Segmented,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
}
