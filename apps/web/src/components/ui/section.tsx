import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/*
 * One container for every page: 72rem wide, the gutter token at the sides. Everything inside it
 * sits on the twelve-column page grid (globals.css: grid-cols-split for a subject and its aside,
 * grid-cols-article for prose and its contents; equal grid-cols-2/3/4 for cards), so a heading
 * and the grid under it divide the width the same way on every page.
 */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-gutter', className)}>
      {children}
    </div>
  )
}

/** A page block: generous vertical room instead of a rule between it and the next. */
export function Section({
  id,
  className,
  children
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={cn('scroll-mt-24 py-16 sm:py-24', className)}>
      <Container>{children}</Container>
    </section>
  )
}

/*
 * The heading of a section or a page. Left-aligned, it takes the whole width at desktop sizes:
 * eyebrow and title in the seven left columns, the lede in the five right ones, set on the
 * title's baseline, so the block above a full-width grid is as wide as the grid. Centered, it is
 * a measure-wide column in the middle. Below lg both stack.
 */
function Heading({
  as: Tag,
  eyebrow,
  title,
  lede,
  meta,
  align,
  titleClassName,
  className
}: {
  as: 'h1' | 'h2'
  eyebrow?: string
  title: ReactNode
  lede?: ReactNode
  meta?: ReactNode
  align: 'left' | 'center'
  titleClassName: string
  className?: string
}) {
  if (align === 'center') {
    return (
      <div className={cn('mx-auto max-w-2xl text-center', className)}>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <Tag className={cn('serif-display mt-4 text-balance', titleClassName)}>{title}</Tag>
        {lede && <p className="mt-5 text-lead text-pretty text-muted-foreground">{lede}</p>}
        {meta && <p className="mt-3 text-meta text-muted-foreground">{meta}</p>}
      </div>
    )
  }
  return (
    <div className={cn('grid gap-card lg:grid-cols-split lg:items-end lg:gap-x-12', className)}>
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <Tag className={cn('serif-display mt-4 text-balance', titleClassName)}>{title}</Tag>
      </div>
      {(lede || meta) && (
        <div className="lg:pb-1">
          {lede && <p className="text-lead text-pretty text-muted-foreground">{lede}</p>}
          {meta && <p className="mt-3 text-meta text-muted-foreground">{meta}</p>}
        </div>
      )}
    </div>
  )
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = 'left',
  className
}: {
  eyebrow?: string
  title: ReactNode
  lede?: ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <Heading
      as="h2"
      eyebrow={eyebrow}
      title={title}
      lede={lede}
      align={align}
      titleClassName="text-title"
      className={className}
    />
  )
}

/** The title block at the top of a page: the same header, one step larger. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  meta,
  align = 'left',
  className
}: {
  eyebrow?: string
  title: ReactNode
  lede?: ReactNode
  meta?: ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <Heading
      as="h1"
      eyebrow={eyebrow}
      title={title}
      lede={lede}
      meta={meta}
      align={align}
      titleClassName="text-title sm:text-display"
      className={className}
    />
  )
}

/** A pill label: the apps' badge, in its tonal (well) or tinted forms. */
export function Chip({
  tone = 'well',
  className,
  children
}: {
  tone?: 'well' | 'success' | 'record' | 'card'
  className?: string
  children: ReactNode
}) {
  const tones = {
    well: 'well text-muted-foreground',
    card: 'bg-card text-muted-foreground shadow-raised',
    success: 'bg-success/12 text-success',
    record: 'bg-record/12 text-record'
  }
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium tracking-[0.06em] whitespace-nowrap uppercase',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
