'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Badge, badgeToneClass } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MatchScoreBreakdown } from './match-score-breakdown'
import {
  parseMatchDetails,
  subScoresFor,
  type MatchDetails,
  type MatchSubScore,
} from './match-types'

// Re-exported for existing call sites (job-row.tsx, job-detail-modal.tsx)
// that import these from match-badge.tsx — the real definitions now live in
// match-types.ts so match-score-breakdown.tsx can depend on them too without
// an import cycle through this file.
export { parseMatchDetails, subScoresFor, type MatchDetails, type MatchSubScore }

// Includes 'none' even though matchTone() only returns it for a null/NaN
// score (which the score === null branch below already handles before we
// ever call matchTone) — keeps this exhaustive against MatchTone's real
// type instead of narrowing with a runtime check that can never be hit.
const TONE_LABEL: Record<ReturnType<typeof matchTone>, string> = {
  good: 'Excellent',
  warn: 'Good',
  muted: 'Fair',
  bad: 'Low',
  none: 'Unscored',
}

interface MatchBadgeProps {
  score: number | null
  details?: MatchDetails | null
  /**
   * Whether to render an explicit "Not scored yet" badge when score is null,
   * instead of rendering nothing. Defaults to true — with the vast majority
   * of jobs unscored, silently returning null made the whole list look
   * unscored rather than "not scored yet".
   */
  showUnscored?: boolean
  /**
   * When provided, the "Not scored yet" badge becomes the primary trigger
   * for calculating a match score: a real, keyboard-accessible button. When
   * omitted, renders the original non-interactive badge.
   */
  onCalculate?: () => void
  isCalculating?: boolean
  /**
   * Set when calculation cannot currently run (missing resume/key, or the
   * account-status check itself failed). The trigger still renders — just
   * disabled, with this reason surfaced on hover/focus — never hidden.
   */
  disabledReason?: string | null
  /** Wired to retry the account-status fetch; shown when disabledReason is the "couldn't check" case. */
  onRetryStatus?: () => void
  /**
   * Plain-language remaining-budget line shown alongside the "click to
   * calculate" hint (e.g. "$6.20 of your $10.00 monthly AI budget left").
   * This click fires a real, metered LLM call with no other confirmation
   * step — this is the only signal a user gets before it spends real money.
   * Omitted (never blocks the action) when unknown, never fabricated.
   */
  budgetHint?: string | null
}

/** Match score rendered via matchTone/Badge, with a strengths/gaps tooltip when available. */
export function MatchBadge({
  score,
  details,
  showUnscored = true,
  onCalculate,
  isCalculating = false,
  disabledReason = null,
  onRetryStatus,
  budgetHint = null,
}: MatchBadgeProps) {
  if (score === null || score === undefined) {
    if (!showUnscored) return null

    // No handler wired — keep the original, purely informational badge.
    if (!onCalculate) {
      return (
        <Badge tone="muted" className="cursor-default whitespace-nowrap">
          Not scored yet
        </Badge>
      )
    }

    const isDisabled = isCalculating || !!disabledReason
    const trigger = (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!isDisabled) onCalculate()
        }}
        // aria-disabled, NOT the native `disabled` attribute: a real disabled
        // button stops receiving hover/focus in most browsers, which would
        // make the reason tooltip below unreachable by mouse OR keyboard —
        // exactly the "hidden affordance" bug this trigger exists to fix.
        aria-disabled={isDisabled}
        aria-label={isCalculating ? 'Calculating match score' : 'Calculate match score'}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          // Calculating is the one genuinely live moment this row can be
          // in — the only state here that earns the --accent treatment
          // reserved for "happening right now". Idle/blocked stay `muted`.
          badgeToneClass(isCalculating ? 'accent' : 'muted'),
          disabledReason
            ? 'cursor-not-allowed opacity-70'
            : 'cursor-pointer hover:bg-accent-soft hover:text-accent-deep'
        )}
      >
        {isCalculating && <Loader2 className="h-3 w-3 animate-spin" />}
        {isCalculating ? 'Calculating…' : 'Not scored yet'}
      </button>
    )

    // Still explain what's blocking it, or retry, even when nothing failed —
    // a quiet hint ("Click to calculate") is cheap and never hides the control.
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs p-3" onClick={(e) => e.stopPropagation()}>
            {disabledReason ? (
              <div className="space-y-2">
                <p className="text-caption">{disabledReason}</p>
                {onRetryStatus && disabledReason.startsWith("Couldn't check") ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRetryStatus()
                    }}
                  >
                    Retry
                  </Button>
                ) : (
                  <Link
                    href="/settings"
                    className="text-caption font-medium text-accent-deep hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Go to Settings
                  </Link>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-caption">
                  {isCalculating ? 'Scoring this job against your resume…' : 'Click to calculate a match score'}
                </p>
                {!isCalculating && budgetHint && (
                  <p className="text-caption text-muted-foreground">Uses a metered AI call — {budgetHint}.</p>
                )}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  const tone = matchTone(score)

  const badge = (
    <Badge tone={tone} className="cursor-default whitespace-nowrap tabular-nums">
      {score}% {TONE_LABEL[tone]}
    </Badge>
  )

  const subScores = subScoresFor(details)
  const hasDetails =
    !!details && (!!details.highlights?.length || !!details.gaps?.length || subScores.length > 0 || !!details.summary)
  if (!hasDetails) return badge

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        {/* A real <button>, not the bare Badge <span> — a <span> can't
            receive keyboard focus, so a keyboard user could never reveal
            this tooltip's WHY-behind-the-score breakdown. */}
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${score} percent match — press for the full score breakdown`}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {badge}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs p-3">
          <MatchScoreBreakdown score={score} details={details ?? null} compact />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
