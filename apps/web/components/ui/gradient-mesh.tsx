import { cn } from '@/lib/utils'

/**
 * Ambient, slow-drifting accent-tinted gradient field — the "make it look
 * alive" depth cue that doesn't cost a 3D dependency. Pure CSS (see
 * `.gradient-mesh` in globals.css), so it's inert under prefers-reduced-motion
 * via the app-wide reduced-motion rule and costs nothing on the JS bundle.
 * Absolutely positioned + `pointer-events-none` — parent needs `relative`.
 */
export function GradientMesh({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('gradient-mesh pointer-events-none absolute inset-0 -z-10', className)} />
  )
}
