import React, { useEffect, useRef, useState } from 'react'
import {
  AnimatePresence,
  animate,
  motion,
  useReducedMotion,
  type Transition,
  type Variants
} from 'motion/react'
import { cn } from '@renderer/lib/utils'

/*
 * Motion shared by the renderer. One easing for things arriving (the overlay pill's), quick
 * linear-ish exits, and a spring for anything that slides into a new place. Everything here
 * respects the OS "reduce motion" setting through MotionConfig in App.tsx (transforms and layout
 * animations are dropped; opacity still fades) and useReducedMotion for the count-ups.
 */

/** Ease-out for entrances; the same curve the overlay pill morphs with. */
export const arrive = [0.22, 1, 0.36, 1] as const

/** Quick, slightly accelerating exit. */
export const leave = [0.4, 0, 1, 1] as const

/** Something moving to a new place (the sidebar's active pill, list items reordering). */
export const settle: Transition = { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 }

/**
 * A page arriving in the shell. The whole page only fades; its blocks rise one after another
 * through the `.stagger` utility in globals.css, so nothing moves twice.
 */
export const page: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.18, ease: 'linear' } },
  exit: (direction: number) => ({
    opacity: 0,
    y: direction >= 0 ? -6 : 6,
    transition: { duration: 0.12, ease: leave }
  })
}

/** One step of a wizard: forward slides in from the right, back from the left. */
export const step: Variants = {
  initial: (direction: number) => ({ opacity: 0, x: direction >= 0 ? 28 : -28 }),
  enter: { opacity: 1, x: 0, transition: { duration: 0.32, ease: arrive } },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -20 : 20,
    transition: { duration: 0.14, ease: leave }
  })
}

/** A container whose children (using `item`) arrive one after another. */
export const list: Variants = {
  initial: {},
  enter: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } }
}

export const item: Variants = {
  initial: { opacity: 0, y: 10 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.36, ease: arrive } }
}

/**
 * Something that comes and goes with a condition (a banner, an expanded row): it grows in as it
 * fades in and folds away on the way out, so the content around it slides rather than jumps.
 */
export function Appear({
  show,
  children,
  className,
  layout
}: {
  show: boolean
  children: React.ReactNode
  className?: string
  layout?: boolean
}): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          layout={layout}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transition: { duration: 0.3, ease: arrive } }}
          // The margin a `space-y` parent gives it folds away with it, so what follows slides up.
          exit={{
            height: 0,
            opacity: 0,
            marginBottom: 0,
            transition: { duration: 0.18, ease: leave }
          }}
          className={cn('overflow-hidden', className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** A short label that changes: the old one slips up and out as the new one rises in. */
export function Rolling({
  text,
  className
}: {
  text: React.ReactNode
  className?: string
}): React.JSX.Element {
  const key = typeof text === 'string' || typeof text === 'number' ? String(text) : 'node'
  return (
    <span className={cn('relative inline-grid overflow-hidden', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={key}
          initial={{ opacity: 0, y: '70%' }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.26, ease: arrive } }}
          exit={{ opacity: 0, y: '-70%', transition: { duration: 0.14, ease: leave } }}
          className="inline-block"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * A number that counts up to `value` the first time it is shown and glides to every new value
 * after that. Large numerals read better arriving than appearing. With reduced motion on, the
 * value is simply shown.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  duration = 0.9,
  className
}: {
  value: number
  format?: (n: number) => string
  duration?: number
  className?: string
}): React.JSX.Element {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(0)
  // Where the last animation got to, so an interrupted count continues from where it was.
  const last = useRef(0)
  useEffect(() => {
    if (reduced) return
    const controls = animate(last.current, value, {
      duration,
      ease: arrive,
      onUpdate: (v) => {
        last.current = v
        setShown(v)
      }
    })
    return () => controls.stop()
  }, [value, duration, reduced])
  return <span className={cn('tabular-nums', className)}>{format(reduced ? value : shown)}</span>
}

/** Where a route sits relative to the last one: below (1), above (-1) or the same (0). */
export function directionBetween<T>(order: readonly T[], from: T | undefined, to: T): number {
  if (from === undefined) return 0
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  if (a < 0 || b < 0 || a === b) return 0
  return b > a ? 1 : -1
}
