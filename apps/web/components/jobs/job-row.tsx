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
import { cn, formatRelativeTime } from '@/lib/utils'
import { knownParts, postedThisWeek } from '@/lib/format'
import Link from 'next/link'
import { ChanceChip } from '@/components/fit/chance-chip'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { parseFit } from '@/lib/scoring/read'
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
  // The verdict on the role (lib/scoring/read.ts FIT_COLUMNS). Null columns mean it has not been assessed yet.
  fit_assessed_at: string | null
  blocked_reasons: unknown
  want_p: number | null
  want_reason: string | null
  want_detail: unknown
  chance: string | null
  chance_detail: unknown
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
  /** A batch assessment is running elsewhere on the page, which disables this row's trigger too. */
  calculateDisabled: boolean
  /**
   * Non-null when a single role cannot be assessed right now (missing
   * resume/key, or the account-status check itself failed). The trigger
   * still renders, disabled, with this reason on hover; it is never hidden.
   */
  calculateDisabledReason: string | null
  /** Wired to retry the account-status fetch when calculateDisabledReason is the "couldn't check" case. */
  onRetryStatus?: () => void
  /** Visa-sponsorship signal from the company's dossier (if any). */
  visaSignal?: VisaSignal | null
  /** Remaining-AI-budget line surfaced on the "Check chances" trigger. */
  budgetHint?: string | null
  onOpen: () => void
  onAddToPipeline: () => void
  onCalculateMatch: () => void
}

// `job.is_new` only means "Cello has ever seen this row", so the marker also
// needs the posting's own date inside the last week. A role with no posting
// date never gets it: the date Cello found it says nothing about when it went up.

/**
 * "Check chances" on a role nobody has assessed yet: a real, keyboard-accessible
 * button. When it cannot run it is aria-disabled, not `disabled`, so the reason
 * stays reachable by hover and keyboard.
 */
function CheckChancesTrigger({
  onCalculate,
  isCalculating,
  disabledReason,
  onRetryStatus,
  budgetHint,
}: {
  onCalculate: () => void
  isCalculating: boolean
  disabledReason: string | null
  onRetryStatus?: () => void
  budgetHint: string | null | undefined
}) {
  const isDisabled = isCalculating || !!disabledReason
  const trigger = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (!isDisabled) onCalculate()
      }}
      aria-disabled={isDisabled}
      aria-label={isCalculating ? 'Checking your chances' : 'Check your chances for this role'}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent bg-sunken px-2 py-0.5 text-caption font-medium text-muted-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabledReason ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-accent-soft hover:text-accent-deep'
      )}
    >
      {isCalculating && <Loader2 className="h-3 w-3 animate-spin" />}
      {isCalculating ? 'Checking' : 'Not assessed yet'}
    </button>
  )
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs p-3" onClick={(e) => e.stopPropagation()}>
          {disabledReason ? (
            <div className="space-y-2">
              <p className="text-caption">{disabledReason}</p>
              {onRetryStatus && disabledReason.startsWith("Couldn't check") ? (
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onRetryStatus() }}>
                  Retry
                </Button>
              ) : (
                <Link href="/settings" className="text-caption font-medium text-accent-deep hover:underline" onClick={(e) => e.stopPropagation()}>
                  Go to Settings
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-caption">{isCalculating ? 'Checking this role against your resume' : 'Click to check your chances for this role'}</p>
              {!isCalculating && budgetHint && <p className="text-caption text-muted-foreground">Uses a metered AI call: {budgetHint}.</p>}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

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

  const showNewMarker = job.is_new && postedThisWeek(job.posted_at)

  const meta = knownParts(job.companies?.name, job.location, job.salary_range)
  const fit = parseFit(job)
  const filteredReason = fit.blocked[0]?.text ?? null

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
      // Wraps below sm: logo + text take the first line and the actions drop
      // under the text (pl-[3.25rem] = 40px logo + 12px gap). A 390px row
      // can't fit a title, its badges and "Add to pipeline" side by side.
      className="group relative flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-sunken/60 sm:flex-nowrap"
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

      <div className="min-w-0 flex-1 basis-[calc(100%-3.25rem)] sm:basis-0">
        {/* Badges wrap onto their own line instead of squeezing the title to
            zero width; the title (with the NEW chip) keeps a line of its own
            on narrow screens. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
          <div className="flex min-w-0 max-w-full basis-full items-center gap-2 sm:basis-auto">
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
            className="min-w-0 truncate rounded-sm text-left text-body font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {job.title}
            <span className="sr-only"> at {job.companies?.name ?? 'unknown company'} — open details</span>
          </button>
          </div>
          {/* The chip is a control in its own right (hover or focus for the reason), so it must not
              also fire the row's open-the-job click. Guarded, not blanket: only clicks that landed
              on a control are swallowed, so the plain chip still counts as row whitespace. */}
          <span
            className="contents"
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest('button, a')) e.stopPropagation()
            }}
          >
            {fit.blocked.length > 0 ? (
              <Badge tone="neutral" className="whitespace-nowrap border border-dashed border-border bg-transparent text-muted-foreground">Filtered out</Badge>
            ) : fit.chance ? (
              <ChanceChip fit={fit} />
            ) : (
              <CheckChancesTrigger
                onCalculate={onCalculateMatch}
                isCalculating={isCalculating}
                disabledReason={
                  // A running batch blocks this row's own trigger too, but that is
                  // transient, and still worth a distinct, honest reason.
                  calculateDisabled && !calculateDisabledReason ? 'A batch assessment is already running' : calculateDisabledReason
                }
                onRetryStatus={onRetryStatus}
                budgetHint={budgetHint}
              />
            )}
          </span>
          <VisaBadge signal={visaSignal} className="shrink-0" />
        </div>
        <p className="mt-0.5 truncate text-caption text-muted-foreground">
          {meta.join(' · ')}
          {meta.length > 0 && ' · '}
          {filteredReason && <span className="text-foreground">{filteredReason} · </span>}
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
        className="flex shrink-0 basis-full items-center gap-1.5 pl-[3.25rem] sm:basis-auto sm:pl-0"
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
