import { cn } from '@/lib/utils'

export interface LinearMeterProps {
  /** 0..1. Values above 1 render the track fully filled and switch to the
   *  over-limit tone rather than overflowing the bar. */
  ratio: number
  /** Tone override — otherwise derives from ratio (>=1 critical, >=0.85 warning, else good). */
  tone?: 'good' | 'warning' | 'critical'
  className?: string
  /**
   * Accessible name for the `role="progressbar"` — required in practice:
   * without it a screen reader announces a bare percentage with no idea what
   * it's a percentage OF (axe-core's aria-progressbar-name rule). Say what
   * the ratio represents, e.g. "AI budget spent this month".
   */
  label: string
}

const TONE_CLASS: Record<NonNullable<LinearMeterProps['tone']>, string> = {
  // The pipeline ramp, not raw palette classes and not the live accent.
  //
  // "good" used to be `bg-accent`, which made a healthy under-budget meter the
  // loudest thing on the dashboard — $6 of $8 is a settled fact, not something
  // happening now, and globals.css:41-50 reserves accent for the live signal.
  // A calm state should read calm. warning/critical were raw amber-500/red-500,
  // two of the 357 raw-palette utilities bypassing the instrument tones that
  // exist for exactly this ladder.
  good: 'bg-pipeline-offer',
  warning: 'bg-pipeline-screen',
  critical: 'bg-pipeline-rejected',
}

function toneFor(ratio: number): NonNullable<LinearMeterProps['tone']> {
  if (ratio >= 1) return 'critical'
  if (ratio >= 0.85) return 'warning'
  return 'good'
}

/**
 * "A single ratio against a limit -> Meter" (dataviz skill's choosing-a-form
 * table) — not a chart. Same-ramp track: the fill is the one signal, the
 * track is the sunken well the rest of this design system already uses for
 * recessed wells and progress.
 */
export function LinearMeter({ ratio, tone, className, label }: LinearMeterProps) {
  const clamped = Math.max(0, Math.min(1, ratio))
  const resolvedTone = tone ?? toneFor(ratio)
  return (
    <div
      className={cn('h-3 w-full overflow-hidden rounded-full bg-sunken shadow-well', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn('h-full rounded-full transition-all', TONE_CLASS[resolvedTone])}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  )
}
