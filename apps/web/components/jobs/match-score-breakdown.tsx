'use client'

// Career-ops-style match explanation: every score broken into named
// dimensions with an explicit rubric, every number backed by evidence, and a
// verdict that carries its own reasoning — not just an overall percentage in
// a badge. Sources straight from jobs.match_details (see
// lib/harness/agents/matcher.ts's LlmVerdict / buildMatchDetails — the single
// scoring code path shared by autopilot, the cron digest, and the on-demand
// "Calculate match" button).

import { CheckCircle2, MinusCircle } from 'lucide-react'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'
import { subScoresFor, type MatchDetails, type MatchSubScore } from './match-types'

/** Same 0-100 bands as lib/format.ts matchTone() / app/globals.css --chart-score-*. */
function scoreColorVar(value: number): string {
  const tone = matchTone(value)
  switch (tone) {
    case 'good':
      return 'var(--chart-score-strong)'
    case 'warn':
      return 'var(--chart-score-good)'
    case 'muted':
      return 'var(--chart-score-fair)'
    default:
      return 'var(--chart-score-bad)'
  }
}

/**
 * One labeled horizontal meter per sub-score — "Skills 82", "Experience 65",
 * "Location 100" — instead of burying the rubric inside a single overall
 * number. Each bar's color reuses the exact same 0-100 bands as the overall
 * score badge (lib/format.ts matchTone), so "this dimension is weak" reads
 * the same way everywhere in the product.
 */
export function SubScoreMeters({ subScores, compact = false }: { subScores: MatchSubScore[]; compact?: boolean }) {
  if (subScores.length === 0) return null
  return (
    <dl className={cn('space-y-1.5', compact && 'space-y-1')}>
      {subScores.map((s) => (
        // A <dl> may only contain dt/dd groups (optionally wrapped in a single
        // div). The meter used to sit between the <dt> and the <dd> as a bare
        // sibling, which breaks that grouping — axe flags it as `definition-list`
        // and assistive tech loses the term/value pairing. Nesting the meter
        // inside the <dd>, where it belongs as part of the value, keeps the
        // identical layout and makes the list valid.
        <div key={s.key} className="flex items-center gap-2">
          <dt className="w-[4.5rem] shrink-0 text-caption text-muted-foreground">{s.label}</dt>
          <dd className="flex flex-1 items-center gap-2">
            <div
              className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-sunken"
              role="img"
              aria-label={`${s.label} match: ${s.value} out of 100`}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.max(2, s.value)}%`, backgroundColor: scoreColorVar(s.value) }}
              />
            </div>
            <span className="w-8 shrink-0 text-right font-readout text-caption tabular-nums text-foreground">
              {s.value}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export interface MatchScoreBreakdownProps {
  score: number
  details: MatchDetails | null
  /** Condensed layout for the match-badge hover/focus tooltip (max-w-xs). Full layout for the job detail modal. */
  compact?: boolean
}

/**
 * The full "why this score" explanation: overall score, the named
 * sub-dimensions (when the scorer produced them), the one-line seniority
 * verdict, the plain-language summary, and the evidence — strengths and
 * gaps, each a concrete grounded reason, never just a number.
 */
export function MatchScoreBreakdown({ score, details, compact = false }: MatchScoreBreakdownProps) {
  const subScores = subScoresFor(details)
  const strengths = details?.highlights?.length ? details.highlights : []
  const gaps = details?.gaps?.length ? details.gaps : []

  return (
    <div className={cn('space-y-3', compact && 'space-y-2.5')}>
      {subScores.length > 0 && (
        <div>
          {!compact && (
            <p className="mb-1.5 text-caption font-medium text-foreground">Score breakdown</p>
          )}
          <SubScoreMeters subScores={subScores} compact={compact} />
        </div>
      )}

      {details?.seniorityFit && (
        <p className="text-caption">
          <span className="font-medium text-foreground">Seniority fit: </span>
          <span className="text-muted-foreground">{details.seniorityFit}</span>
        </p>
      )}

      {details?.summary && (
        <p className={cn('text-caption text-muted-foreground', compact && 'line-clamp-3')}>{details.summary}</p>
      )}

      {strengths.length > 0 && (
        <div>
          <p className="mb-1 text-caption font-medium text-emerald-700 dark:text-emerald-400">
            Strengths — the evidence
          </p>
          <ul className="space-y-1">
            {(compact ? strengths.slice(0, 3) : strengths).map((h, i) => (
              <li key={i} className="flex items-start gap-1.5 text-caption text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {gaps.length > 0 && (
        <div>
          <p className="mb-1 text-caption font-medium text-amber-700 dark:text-amber-400">
            Gaps — what&apos;s missing
          </p>
          <ul className="space-y-1">
            {(compact ? gaps.slice(0, 3) : gaps).map((g, i) => (
              <li key={i} className="flex items-start gap-1.5 text-caption text-amber-700 dark:text-amber-400">
                <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {subScores.length === 0 && strengths.length === 0 && gaps.length === 0 && !details?.summary && (
        <p className="text-caption text-muted-foreground">
          Scored {score}% — no further breakdown recorded for this job.
        </p>
      )}
    </div>
  )
}
