'use client'

import { Building2, ExternalLink, Loader2, MoreHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatRelativeTime } from '@/lib/utils'
import { MatchBadge, parseMatchDetails, type MatchDetails } from './match-badge'
import { VisaBadge } from './visa-badge'
import type { VisaSignal } from '@/lib/dossier/store'

export interface JobRowJob {
  id: string
  company_id: string
  title: string
  url: string
  location: string | null
  salary_range: string | null
  posted_at: string | null
  discovered_at: string
  match_score: number | null
  match_details: MatchDetails | string | null
  is_new: boolean
  companies: {
    name: string
    logo_url: string | null
    domain: string | null
  }
}

interface JobRowProps {
  job: JobRowJob
  inPipeline: boolean
  isAdding: boolean
  isCalculating: boolean
  /** A batch calculation is running elsewhere on the page — disables this row's trigger too. */
  calculateDisabled: boolean
  /**
   * Non-null when a single-job match can't be calculated right now (missing
   * resume/key, or the account-status check itself failed). The trigger
   * still renders — disabled, with this reason on hover — never hidden.
   */
  calculateDisabledReason: string | null
  /** Wired to retry the account-status fetch when calculateDisabledReason is the "couldn't check" case. */
  onRetryStatus?: () => void
  /** Visa-sponsorship signal from the company's dossier (if any). */
  visaSignal?: VisaSignal | null
  /** Remaining-AI-budget line surfaced on the "calculate match" trigger — see MatchBadgeProps.budgetHint. */
  budgetHint?: string | null
  onOpen: () => void
  onAddToPipeline: () => void
  onCalculateMatch: () => void
}

// `job.is_new` only means "Cello has ever seen this row" — it's written
// `true` by every ingest path (lib/sources, lib/ats, the scraper trigger
// route) and cleared only when the verifier's dead-URL/dedupe knockout
// fires, never on a timer. A job discovered six months ago still carries
// it. The flag alone can't answer "is this actually new right now", so we
// require it to agree with a real recency window computed from the job's
// own timestamp (the same posted_at-else-discovered_at fallback the date
// label below uses) before painting anything.
const NEW_JOB_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** One job as a list row: 40px logo, strong title, single caption meta line, one visible action. */
export function JobRow({
  job,
  inPipeline,
  isAdding,
  isCalculating,
  calculateDisabled,
  calculateDisabledReason,
  onRetryStatus,
  visaSignal,
  budgetHint,
  onOpen,
  onAddToPipeline,
  onCalculateMatch,
}: JobRowProps) {
  // Same field the freshness filter used: posted_at when we have it, otherwise
  // fall back to discovered_at (one batch timestamp) — and say so, visibly,
  // so the row never claims a posting is "fresh" when we only know when Cello
  // found it. 1,348 jobs currently have no posted_at.
  const hasPostedDate = !!job.posted_at
  const dateLabel = hasPostedDate
    ? `Posted ${formatRelativeTime(job.posted_at as string)}`
    : `Discovered ${formatRelativeTime(job.discovered_at)}`

  // Same reference timestamp as dateLabel above — see NEW_JOB_WINDOW_MS for
  // why the DB flag alone isn't enough to decide "new".
  const referenceTimestamp = hasPostedDate ? (job.posted_at as string) : job.discovered_at
  const isRecent = Date.now() - new Date(referenceTimestamp).getTime() < NEW_JOB_WINDOW_MS
  const showNewMarker = job.is_new && isRecent

  const meta = [job.companies?.name, job.location, job.salary_range].filter(Boolean) as string[]

  return (
    // Plain container — NOT role="button". The row used to be one giant
    // role="button" wrapping several real interactive descendants (the match
    // trigger, "Add to pipeline", the "More actions" menu), which is an axe
    // "nested-interactive" violation: a screen reader / keyboard user can't
    // tell where the outer control ends and the inner ones begin. The title
    // below is now the one real, focusable "open" control; this div's onClick
    // is purely a mouse convenience for clicking row whitespace.
    <div
      onClick={onOpen}
      className="group relative flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-sunken/60"
    >
      {showNewMarker && (
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px] bg-accent"
        />
      )}
      {job.companies?.logo_url ? (
        <img
          src={job.companies.logo_url}
          alt=""
          className="h-10 w-10 shrink-0 rounded-control border bg-white object-contain p-1"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-sunken">
          <Building2 className="h-5 w-5 text-muted-foreground" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {showNewMarker && (
            <span
              className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-readout text-[0.5625rem] font-bold uppercase tracking-[0.1em] text-accent-deep"
              role="img"
              aria-label="New job"
            >
              New
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className="truncate rounded-sm text-body font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {job.title}
            <span className="sr-only"> at {job.companies?.name ?? 'unknown company'} — open details</span>
          </button>
          {/* The match badge is a control in its own right, so it must not also
              fire the row's open-the-job convenience click above. Its unscored
              variant already stops the event itself; its SCORED variant — a
              real <button> labelled "press for the full score breakdown" — did
              not, so the click bubbled and opened the detail modal instead.
              Verified in a browser before this wrapper existed: clicking an
              "8 percent match" badge gave dialog=true, tooltip=false. Keyboard
              users hit the identical bug, since Enter on a <button> dispatches
              a bubbling click.
              Guarded, not blanket: only swallow clicks that actually landed on
              a control, so MatchBadge's purely decorative variant (a plain
              <span>, rendered when there is no breakdown to show) keeps
              counting as row whitespace and still opens the row.
              `contents` keeps the badge a direct flex item of this line — a
              display:contents wrapper generates no box, but events still bubble
              through it, which is all this handler needs. */}
          <span
            className="contents"
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest('button, a')) e.stopPropagation()
            }}
          >
            <MatchBadge
              score={job.match_score}
              details={parseMatchDetails(job.match_details)}
              onCalculate={onCalculateMatch}
              isCalculating={isCalculating}
              disabledReason={
                // A running batch blocks this row's own trigger too, but that's
                // transient — still worth a distinct, honest reason.
                calculateDisabled && !calculateDisabledReason ? 'A batch calculation is already running' : calculateDisabledReason
              }
              onRetryStatus={onRetryStatus}
              budgetHint={budgetHint}
            />
          </span>
          <VisaBadge signal={visaSignal} className="shrink-0" />
        </div>
        <p className="mt-0.5 truncate text-caption text-muted-foreground">
          {meta.join(' · ')}
          {meta.length > 0 && ' · '}
          <span
            className={hasPostedDate ? undefined : 'italic text-muted-foreground'}
            title={
              hasPostedDate
                ? undefined
                : 'No posted date from the source — showing when Cello discovered this job instead'
            }
          >
            {dateLabel}
          </span>
        </p>
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        {inPipeline ? (
          <Badge tone="neutral">In pipeline</Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onAddToPipeline}
            disabled={isAdding}
          >
            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add to pipeline'}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* "Calculate match" used to be duplicated here under the same
                match_score === null gate as the MatchBadge trigger above, but
                with native `disabled` instead of aria-disabled — the badge is
                the better-placed, already keyboard-accessible control, so the
                overflow copy was removed rather than kept in sync. */}
            <DropdownMenuItem onClick={() => window.open(job.url, '_blank')}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Apply on site
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
