import * as React from 'react'
import {
  Separator as SeparatorPrimitive,
  Tooltip as TooltipPrimitive,
  Tabs as TabsPrimitive
} from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

// ---- Card -----------------------------------------------------------------------------------

/** A raised surface on the canvas: the card radius, the card padding, the raised elevation. */
function Card({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="card" className={cn('surface-raised rounded-xl', className)} {...props} />
}
function CardHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1 px-card pt-card', className)} {...props} />
}
function CardTitle({ className, ...props }: React.ComponentProps<'h3'>): React.JSX.Element {
  return (
    <h3
      className={cn('text-lead font-semibold leading-tight tracking-tight', className)}
      {...props}
    />
  )
}
function CardDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}
function CardContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('px-card pb-card pt-4', className)} {...props} />
}

// ---- Banner ---------------------------------------------------------------------------------

const bannerVariants = cva('rounded-xl px-card py-4', {
  variants: {
    tone: {
      neutral: 'well text-foreground',
      primary: 'bg-primary/8 text-foreground',
      record: 'bg-record/10 text-foreground',
      success: 'bg-success/12 text-foreground',
      warning: 'bg-warning/14 text-foreground',
      destructive: 'bg-destructive/10 text-foreground'
    }
  },
  defaultVariants: { tone: 'neutral' }
})

/**
 * Something the page wants to say in passing: a tinted block at the card radius with no edge and
 * no elevation, so it reads as a note on the page rather than an object on it.
 */
function Banner({
  className,
  tone,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof bannerVariants>): React.JSX.Element {
  return <div data-slot="banner" className={cn(bannerVariants({ tone }), className)} {...props} />
}

// ---- Badge ----------------------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full px-2.5 py-0.5 text-caption font-medium w-fit whitespace-nowrap gap-1.5 [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'well text-muted-foreground',
        success: 'bg-success/12 text-success',
        destructive: 'bg-destructive/12 text-destructive',
        record: 'bg-record/12 text-record'
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
          'z-50 w-fit max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-floating text-balance data-[state=delayed-open]:animate-layer-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-layer-out',
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

/* A pill track sunk into its surface; the chosen option is an ink pill inside it (concentric). */
const trackClass = 'well inline-flex h-9 items-center rounded-full p-[3px]'
const optionClass =
  'h-7 rounded-full px-3.5 text-note font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground'
const activeOptionClass = 'bg-primary text-primary-foreground hover:text-primary-foreground'

const Tabs = TabsPrimitive.Root
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      className={cn(trackClass, 'w-fit justify-center text-muted-foreground', className)}
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
        optionClass,
        'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:hover:text-primary-foreground',
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
    <div role="radiogroup" className={cn(trackClass, className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(optionClass, value === o.value && activeOptionClass)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export {
  Badge,
  Banner,
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
