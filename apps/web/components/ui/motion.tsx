'use client'

/**
 * Cello motion layer — the one place durations, easing, and reusable motion
 * primitives are defined. framer-motion was an installed, unused dependency;
 * this file is the vocabulary the rest of the app should reach for instead of
 * hand-rolled transition classes.
 *
 * Principles:
 *  - Short + crisp, never floaty: 150-300ms, one consistent ease.
 *  - `reducedMotion="user"` on <AppMotionConfig> means every motion.* consumer
 *    automatically collapses transforms/layout animation to instant opacity
 *    swaps for prefers-reduced-motion users — components below still guard
 *    their own imperative work (CountUp, TiltCard) with `useReducedMotion()`
 *    directly since that work happens outside the declarative variant system.
 */

import * as React from 'react'
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type Transition,
  type Variants,
} from 'framer-motion'
import { cn } from '@/lib/utils'

// Re-exported so consumers never need a second import from 'framer-motion'
// for the common cases (raw `motion` escape hatch, exit animations).
export { motion, AnimatePresence, useReducedMotion }

/* ------------------------------------------------------------------ */
/* Timing tokens                                                       */
/* ------------------------------------------------------------------ */

export const MOTION_DURATION = {
  fast: 0.15,
  base: 0.2,
  slow: 0.3,
} as const

/** Standard "crisp" ease — decisive in, settles fast. No spring floatiness. */
export const MOTION_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1]

export const transitionFast: Transition = { duration: MOTION_DURATION.fast, ease: MOTION_EASE }
export const transitionBase: Transition = { duration: MOTION_DURATION.base, ease: MOTION_EASE }
export const transitionSlow: Transition = { duration: MOTION_DURATION.slow, ease: MOTION_EASE }

/* ------------------------------------------------------------------ */
/* Provider                                                             */
/* ------------------------------------------------------------------ */

/**
 * Wrap the app shell once. `reducedMotion="user"` makes every motion.*
 * element in the tree honour prefers-reduced-motion automatically (transform
 * + layout animation collapse to instant; opacity fades still run briefly).
 */
export function AppMotionConfig({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={transitionBase}>
      {children}
    </MotionConfig>
  )
}

/* ------------------------------------------------------------------ */
/* Page / section enter                                                */
/* ------------------------------------------------------------------ */

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: transitionBase },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: transitionBase },
}

/** Section-level enter wrapper — use once per page or per major section. */
export function SectionTransition({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={fadeInUp}
      transition={{ ...transitionBase, delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Staggered entrance (lists, grids of Cards)                          */
/* ------------------------------------------------------------------ */

export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.02 },
  },
}

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: transitionFast },
}

/**
 * Wrap a group of siblings (e.g. the dashboard's stacked Cards) so they
 * reveal in sequence instead of popping in at once — this is what keeps a
 * "wall" of Cards reading as a guided hierarchy rather than clutter.
 */
export function StaggerGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.div initial="hidden" animate="show" variants={staggerContainer} className={className}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Layout animation for reordering / add / remove                      */
/* ------------------------------------------------------------------ */

export interface AnimatedListProps<T> {
  items: T[]
  keyExtractor: (item: T, index: number) => string
  renderItem: (item: T, index: number) => React.ReactNode
  className?: string
  itemClassName?: string
  /** Container tag — must be a valid parent for the item tag (default 'ul'/'li'). */
  as?: 'ul' | 'ol' | 'div'
  itemAs?: 'li' | 'div'
}

/**
 * Drop-in replacement for `<ul>{items.map(...)}</ul>` that animates items in,
 * out, and to their new position on reorder — the `layout` prop on each row
 * is what makes reordering (not just add/remove) animate smoothly.
 */
export function AnimatedList<T>({
  items,
  keyExtractor,
  renderItem,
  className,
  itemClassName,
  as = 'ul',
  itemAs = 'li',
}: AnimatedListProps<T>) {
  const Container = motion[as]
  const Item = motion[itemAs]

  return (
    <Container className={className}>
      <AnimatePresence initial={false}>
        {items.map((item, index) => (
          <Item
            key={keyExtractor(item, index)}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={transitionFast}
            className={itemClassName}
          >
            {renderItem(item, index)}
          </Item>
        ))}
      </AnimatePresence>
    </Container>
  )
}

/* ------------------------------------------------------------------ */
/* Count-up for stat numbers                                           */
/* ------------------------------------------------------------------ */

export interface CountUpProps {
  value: number
  duration?: number
  className?: string
  format?: (n: number) => string
}

/**
 * Animates a number counting up to `value` on mount/change. Reduced-motion
 * users (and the very first paint) get the plain final number, never a
 * flash of 0 or a broken animation.
 */
export function CountUp({ value, duration = 0.6, className, format }: CountUpProps) {
  const spanRef = React.useRef<HTMLSpanElement>(null)
  const prefersReduced = useReducedMotion()
  const renderValue = React.useCallback((n: number) => (format ? format(n) : String(n)), [format])

  React.useEffect(() => {
    const node = spanRef.current
    if (!node) return

    if (prefersReduced) {
      node.textContent = renderValue(value)
      return
    }

    const controls = animate(0, value, {
      duration,
      ease: MOTION_EASE,
      onUpdate(latest) {
        node.textContent = renderValue(Math.round(latest))
      },
    })
    return () => controls.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, prefersReduced])

  return (
    <span ref={spanRef} className={className}>
      {renderValue(prefersReduced ? value : 0)}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Skeleton → content crossfade                                        */
/* ------------------------------------------------------------------ */

/**
 * Crossfades between the `.skeleton` shimmer state and real content instead
 * of the two swapping with a hard cut. Pass the same `loading` boolean you
 * already branch on — this only changes how the swap looks.
 */
export function LoadingFade({
  loading,
  skeleton,
  children,
  className,
}: {
  loading: boolean
  skeleton: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {loading ? (
        <motion.div
          key="skeleton"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFast}
          className={className}
        >
          {skeleton}
        </motion.div>
      ) : (
        <motion.div
          key="content"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFast}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ */
/* Restrained tilt-on-hover for primary surfaces                       */
/* ------------------------------------------------------------------ */

export interface TiltCardProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    'onAnimationStart' | 'onAnimationEnd' | 'onDrag' | 'onDragStart' | 'onDragEnd'
  > {
  children: React.ReactNode
  /** Max rotation in degrees. Keep small — this is a hint of depth, not a toy. */
  max?: number
}

/**
 * CSS 3D tilt that follows the pointer, plus a small lift + deeper shadow —
 * "layered elevation" instead of a heavier border. No-ops under
 * prefers-reduced-motion (the surface stays flat and still fully usable).
 */
export const TiltCard = React.forwardRef<HTMLDivElement, TiltCardProps>(
  ({ children, className, max = 5, style, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLDivElement | null>(null)
    const prefersReduced = useReducedMotion()
    const rotateX = useMotionValue(0)
    const rotateY = useMotionValue(0)
    const lift = useMotionValue(0)
    const springConfig = { stiffness: 260, damping: 22, mass: 0.5 }
    const springRotateX = useSpring(rotateX, springConfig)
    const springRotateY = useSpring(rotateY, springConfig)
    const springLift = useSpring(lift, springConfig)

    function setRef(node: HTMLDivElement | null) {
      innerRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }

    function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
      if (prefersReduced || !innerRef.current) return
      const rect = innerRef.current.getBoundingClientRect()
      const px = (event.clientX - rect.left) / rect.width - 0.5
      const py = (event.clientY - rect.top) / rect.height - 0.5
      rotateY.set(px * max)
      rotateX.set(-py * max)
    }

    function reset() {
      rotateX.set(0)
      rotateY.set(0)
      lift.set(0)
    }

    return (
      <motion.div
        ref={setRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => lift.set(-2)}
        onMouseLeave={reset}
        style={{
          rotateX: prefersReduced ? 0 : springRotateX,
          rotateY: prefersReduced ? 0 : springRotateY,
          y: prefersReduced ? 0 : springLift,
          transformPerspective: 800,
          ...style,
        }}
        className={cn('transition-shadow duration-200 will-change-transform', className)}
        {...props}
      >
        {children}
      </motion.div>
    )
  }
)
TiltCard.displayName = 'TiltCard'
