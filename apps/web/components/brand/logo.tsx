/**
 * The Cello mark: a cello scroll — the carved volute at the head of the
 * instrument — drawn so it also closes into a C. Brand initial and instrument
 * in one form.
 *
 * COLOUR. The mark uses `--brand` (petrol), never `--accent` (orange).
 * PRODUCT-VISION.md assigns orange a job: "live opportunity, attention,
 * progress". A logo painted in the status colour sits next to every live cue
 * in the product and weakens all of them, so the mark deliberately stays out
 * of the signal palette. `--brand` is theme-aware — deep petrol on paper,
 * lightened on charcoal — because a single hex cannot clear contrast on both
 * grounds.
 *
 * MOTION. When `loading` is set, the spiral draws and unwinds itself instead
 * of a separate spinner appearing next to it. The mark IS the loading state.
 * This works because the path carries `pathLength={1}`, which normalises the
 * spiral's real arc length to 1 so the dash animation is geometry-independent
 * — retune the curve and the animation still runs edge to edge. Static by
 * default: an idle logo that animates forever is decoration, which is exactly
 * what the pulsing dot this replaced was doing.
 *
 * The mark is `aria-hidden` and the accessible name lives on the surrounding
 * text or label, so a screen reader announces "Cello" once rather than twice.
 * When `showWordmark` is false (the collapsed sidebar) the caller MUST provide
 * the name some other way — `<LogoMark />` alone is decorative by construction.
 */

import { cn } from '@/lib/utils'

/** The spiral, shared by every variant so the geometry can never drift. */
const SCROLL_PATH =
  'M50 47 C 44 56, 30 58, 20 51 C 9 43, 8 26, 19 17 C 30 8, 46 12, 51 23 C 55 32, 49 41, 40 41 C 33 41, 29 35, 32 29'

export function LogoMark({
  className,
  loading = false,
}: {
  className?: string
  loading?: boolean
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-6 w-6 text-brand', className)}
      aria-hidden
      focusable="false"
    >
      <path
        // pathLength normalises the arc to 1 so `stroke-dasharray: 1` in the
        // .logo-trace rule covers exactly the whole spiral, whatever the curve.
        pathLength={1}
        className={loading ? 'logo-trace' : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth={7}
        strokeLinecap="round"
        d={SCROLL_PATH}
      />
    </svg>
  )
}

export function Logo({
  showWordmark = true,
  loading = false,
  className,
  markClassName,
}: {
  showWordmark?: boolean
  loading?: boolean
  className?: string
  markClassName?: string
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark className={markClassName} loading={loading} />
      {showWordmark && (
        <span className="font-display text-lg font-semibold tracking-tight text-foreground">
          Cello
        </span>
      )}
    </span>
  )
}

/**
 * The app's loading state: the mark drawing itself, with a live-region label
 * so the wait is announced rather than silent.
 *
 * `label` should say what is loading ("Loading your jobs"), not just "Loading"
 * — a screen reader user hearing a bare "loading" on every page learns nothing.
 */
export function LogoLoader({
  label,
  className,
  markClassName,
}: {
  label: string
  className?: string
  markClassName?: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col items-center justify-center gap-3', className)}
    >
      <LogoMark className={cn('h-9 w-9', markClassName)} loading />
      <span className="sr-only">{label}</span>
    </div>
  )
}
