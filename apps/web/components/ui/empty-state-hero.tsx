'use client'

import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface EmptyStateHeroProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: LucideIcon
  /** Small mono eyebrow above the headline, e.g. "PIPELINE · STANDING BY". */
  eyebrow?: string
  title: string
  /** One or two sentences of direction — what this surface will hold. */
  body?: string
  /** Usually a single primary Button plus an optional secondary. */
  action?: React.ReactNode
  /**
   * A ghosted product preview rendered behind the message (dimmed, masked,
   * non-interactive) so the empty surface previews what will live here.
   */
  preview?: React.ReactNode
  /** Heading level for `title` — see EmptyState's identical prop. Defaults to h2. */
  headingLevel?: 'h1' | 'h2' | 'h3' | 'h4'
}

/**
 * Full-surface empty state for a primary view (pipeline, contacts). Renders an
 * optional ghosted preview of the real product behind a centered call to act,
 * so the screen reads as "ready and waiting" rather than broken or unbuilt.
 */
export function EmptyStateHero({
  icon: Icon,
  eyebrow,
  title,
  body,
  action,
  preview,
  className,
  headingLevel: Heading = 'h2',
  ...props
}: EmptyStateHeroProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const prefersReduced = useReducedMotion()

  // Two-layer parallax: the icon housing leads the pointer, the ghosted
  // preview trails opposite and slower — a hint of depth (the "3D" ask)
  // without a WebGL asset. Restrained (max ~10px) and inert for
  // prefers-reduced-motion, since it only ever sets these motion values.
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const springConfig = { stiffness: 220, damping: 24, mass: 0.6 }
  const iconX = useSpring(px, springConfig)
  const iconY = useSpring(py, springConfig)
  const previewX = useTransform(iconX, (v) => v * -0.4)
  const previewY = useTransform(iconY, (v) => v * -0.4)

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (prefersReduced || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    px.set(((event.clientX - rect.left) / rect.width - 0.5) * 10)
    py.set(((event.clientY - rect.top) / rect.height - 0.5) * 10)
  }

  function handleMouseLeave() {
    px.set(0)
    py.set(0)
  }

  return (
    <div
      ref={rootRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'relative isolate overflow-hidden rounded-card border bg-card shadow-card',
        className
      )}
      {...props}
    >
      {preview && (
        <motion.div
          aria-hidden
          style={prefersReduced ? undefined : { x: previewX, y: previewY }}
          className="pointer-events-none select-none px-4 pt-4 opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent_82%)] dark:opacity-40"
        >
          {preview}
        </motion.div>
      )}

      <div
        className={cn(
          'flex flex-col items-center justify-center px-8 text-center',
          preview ? 'absolute inset-0' : 'py-16'
        )}
      >
        {/* Raised via shadow + tint, not a border — a surface must not
            contain another bordered surface. */}
        <motion.div
          style={prefersReduced ? undefined : { x: iconX, y: iconY }}
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-card bg-raised text-accent-deep shadow-raised"
        >
          <Icon className="h-6 w-6" aria-hidden />
        </motion.div>
        {eyebrow && (
          <p className="mb-2 font-readout text-label uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <Heading className="font-display text-title text-foreground">{title}</Heading>
        {body && <p className="mt-2 max-w-md text-body text-muted-foreground">{body}</p>}
        {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div>}
      </div>
    </div>
  )
}
