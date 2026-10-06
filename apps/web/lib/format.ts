/*
 * Shared formatting + tone helpers for the Cello UI.
 * Contract file — B1/B2/B3 import these exact names.
 * Rule: the orange accent is NEVER used for scores or pipeline stages.
 */

export type MatchTone = 'good' | 'warn' | 'muted' | 'bad' | 'none'

/**
 * Map a 0-100 match score to a semantic tone.
 * >=85 good (emerald), >=70 warn (amber), >=50 muted, else bad (red); null → none.
 */
export function matchTone(score: number | null): MatchTone {
  if (score === null || score === undefined || Number.isNaN(score)) return 'none'
  if (score >= 85) return 'good'
  if (score >= 70) return 'warn'
  if (score >= 50) return 'muted'
  return 'bad'
}

const TONE_BADGE_CLASSES: Record<MatchTone, string> = {
  // `good` reads as pine, not candy-emerald — steadier, more instrument-like.
  good: 'border-transparent bg-[#E3EDE6] text-[#2C6247] dark:bg-[#4E9A6B]/15 dark:text-[#82C29C]',
  warn: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  muted: 'border-transparent bg-sunken text-muted-foreground',
  bad: 'border-transparent bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  none: 'border-border bg-transparent text-muted-foreground',
}

/** Badge classes for a tone (pairs with components/ui/badge.tsx). */
export function toneBadgeClass(tone: MatchTone): string {
  return TONE_BADGE_CLASSES[tone]
}

export type PipelineStage =
  | 'discovered'
  | 'applied'
  | 'screen'
  | 'interview'
  | 'offer'
  | 'ghosted'
  | 'rejected'

export interface StageMeta {
  label: string
  /** Solid stage color — e.g. the 3px top bar on a kanban column. */
  barClass: string
  /** 12% tint chip with readable text — e.g. column count chips. */
  chipClass: string
  /** Small solid dot in the stage color. */
  dotClass: string
}

export const STAGE_META: Record<PipelineStage, StageMeta> = {
  discovered: {
    label: 'Discovered',
    barClass: 'bg-pipeline-discovered',
    chipClass: 'bg-pipeline-discovered/[0.12] text-blue-700 dark:text-blue-300',
    dotClass: 'bg-pipeline-discovered',
  },
  applied: {
    label: 'Applied',
    barClass: 'bg-pipeline-applied',
    chipClass: 'bg-pipeline-applied/[0.12] text-violet-700 dark:text-violet-300',
    dotClass: 'bg-pipeline-applied',
  },
  screen: {
    label: 'Screen',
    barClass: 'bg-pipeline-screen',
    chipClass: 'bg-pipeline-screen/[0.12] text-yellow-700 dark:text-yellow-300',
    dotClass: 'bg-pipeline-screen',
  },
  interview: {
    label: 'Interview',
    barClass: 'bg-pipeline-interview',
    chipClass: 'bg-pipeline-interview/[0.12] text-teal-700 dark:text-teal-300',
    dotClass: 'bg-pipeline-interview',
  },
  offer: {
    label: 'Offer',
    barClass: 'bg-pipeline-offer',
    chipClass: 'bg-pipeline-offer/[0.12] text-green-700 dark:text-green-300',
    dotClass: 'bg-pipeline-offer',
  },
  ghosted: {
    label: 'Ghosted',
    barClass: 'bg-pipeline-ghosted',
    chipClass: 'bg-pipeline-ghosted/[0.12] text-gray-600 dark:text-gray-400',
    dotClass: 'bg-pipeline-ghosted',
  },
  rejected: {
    label: 'Rejected',
    barClass: 'bg-pipeline-rejected',
    chipClass: 'bg-pipeline-rejected/[0.12] text-red-700 dark:text-red-300',
    dotClass: 'bg-pipeline-rejected',
  },
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** True when the posting's own date is within the last 7 days. First-seen dates never count. */
export function postedThisWeek(postedAt: string | null | undefined, now = Date.now()): boolean {
  if (!postedAt) return false
  const t = new Date(postedAt).getTime()
  return !Number.isNaN(t) && now - t < WEEK_MS
}

/** "Jan 5" this year, "Jan 5, 2025" otherwise. Empty string for missing/invalid input. */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * Placeholder strings that mean "we have no value" — the job classifier writes
 * 'unknown' into job_type, and some sources emit 'n/a' for location. Shown
 * verbatim they read as data ("Bengaluru · unknown").
 */
const NO_VALUE = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'unspecified', 'not specified', '-', '—'])

/** True for null/blank text and for the placeholder strings above. */
export function isUnknownText(value: string | null | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return !v || NO_VALUE.has(v)
}

/** The real values from a list of meta fragments, trimmed, with blanks and placeholders dropped. */
export function knownParts(...values: Array<string | null | undefined>): string[] {
  return values.filter((v): v is string => !isUnknownText(v)).map((v) => v.trim())
}
