import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-5 sm:px-8', className)}>{children}</div>
}

/** A page block: generous vertical room instead of a divider between it and the next. */
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
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h2 className="serif-display mt-4 text-[2.25rem] text-balance sm:text-[3rem]">{title}</h2>
      {lede && (
        <p className="mt-5 text-[17px] leading-relaxed text-pretty text-muted-foreground">{lede}</p>
      )}
    </div>
  )
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('eyebrow', className)}>{children}</div>
}
