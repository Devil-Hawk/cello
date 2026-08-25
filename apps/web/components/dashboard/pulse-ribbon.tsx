'use client'

import Link from 'next/link'
import { Loader2, Sparkles } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CountUp } from '@/components/ui/motion'
import { GradientMesh } from '@/components/ui/gradient-mesh'
import { formatRelativeTime } from '@/lib/utils'

/**
 * Jobs scored per click of the "Score now" trigger — mirrors BATCH_LIMIT in
 * app/(app)/dashboard/page.tsx and app/(app)/jobs/page.tsx (both currently
 * 25), which is what's actually sent to POST /api/agents/match/batch. Not a
 * prop: this component isn't wired to a shared constant, so this is
 * duplicated on purpose to keep the cost disclosure below truthful without
 * adding a new prop for a static number. If that constant ever changes,
 * update this one too.
 */
const BATCH_LIMIT = 25

/** A sweep counts as "live" for the header ping only inside this window —
 *  otherwise the dot would read as "something's happening" for a sweep that
 *  ran days ago. Reuses the same 24h window "Posted 24h" already uses below
 *  rather than inventing a second threshold. */
const RECENT_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000

interface PulseRibbonProps {
  userName: string | null
  companiesCount: number
  /** Jobs with posted_at within the last 24h — NOT discovered_at. */
  jobsPosted24h: number
  /** Jobs with match_score IS NULL — nothing has scored them yet. */
  unscoredCount: number
  /** Applications in an active (non-terminal) pipeline stage. */
  inPipelineCount: number
  /** Most recent companies.last_scraped_at across the user's tracked companies. */
  lastScrapedAt: string | null
  /**
   * Wired to POST /api/agents/match/batch. When present, the Unscored tile
   * gets a "Score now" trigger next to the count instead of only linking to
   * /jobs (which scores nothing on its own). Omit to keep the tile a plain
   * link — never partially wire this in a way that fails silently.
   */
  onCalculateBatch?: () => void
  isCalculatingBatch?: boolean
  /** Non-null reason "Score now" can't run right now (missing resume/key, status check failed). */
  calculateDisabledReason?: string | null
  /** Wired to retry the account-status fetch when calculateDisabledReason is the "couldn't check" case. */
  onRetryStatus?: () => void
}

interface Vital {
  label: string
  value: number
  href: string
  /** Highlight the readout in accent (+ a dot) when there's something live to
   *  act on right now — reserved for genuine opportunity (e.g. fresh
   *  postings). Per globals.css:41-50, accent means "the single live
   *  signal"; a backlog is not that. */
  live?: boolean
  /** Highlight the readout in the pipeline "screen" ochre — the system's
   *  existing review/needs-attention tone (see components/ui/panel.tsx's
   *  `warn` tone and lib/format.ts STAGE_META.screen) — for a backlog that
   *  needs working through but isn't happening "now". No dot: unlike `live`,
   *  a backlog isn't a moment-to-moment event worth pinging. */
  warn?: boolean
}

/**
 * The dashboard signature: a single instrument housing that reports the live
 * vitals of the hunt. Greeting + one honest status line up top, four gauges
 * below in a monospace readout. (No tick ruling on the gauge strip itself —
 * at 4 columns it read as a broken table; see the comment above the grid.)
 */
export function PulseRibbon({
  userName,
  companiesCount,
  jobsPosted24h,
  unscoredCount,
  inPipelineCount,
  lastScrapedAt,
  onCalculateBatch,
  isCalculatingBatch = false,
  calculateDisabledReason = null,
  onRetryStatus,
}: PulseRibbonProps) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = userName?.split(' ')[0]
  const recentlyScraped =
    !!lastScrapedAt && Date.now() - new Date(lastScrapedAt).getTime() < RECENT_SWEEP_WINDOW_MS

  const status =
    jobsPosted24h > 0
      ? `${jobsPosted24h} role${jobsPosted24h === 1 ? '' : 's'} posted in the last 24h.`
      : companiesCount === 0
        ? 'No companies tracked yet — add one to start discovering roles.'
        : inPipelineCount > 0
          ? `Quiet on new postings — ${inPipelineCount} application${inPipelineCount === 1 ? '' : 's'} in flight.`
          : 'Quiet 24h. Nothing new posted at your tracked companies.'

  const vitals: Vital[] = [
    { label: 'Companies', value: companiesCount, href: '/companies' },
    { label: 'Posted 24h', value: jobsPosted24h, href: '/jobs?fresh=24h', live: jobsPosted24h > 0 },
    // NOTE: no query param exists on /jobs to pre-filter to unscored jobs
    // (checked app/(app)/jobs/page.tsx's searchParams handling — fresh,
    // company, sort, visa, undated, showLowQuality, fn, sr, remote, country,
    // lang, none of which is "unscored"). Linking to a made-up param would
    // silently no-op, so this stays a plain /jobs link until that filter
    // exists.
    // ?unscored=1, not bare /jobs: this is the largest number in the product,
    // and it used to link at the default recency feed, which shows scored and
    // unscored rows mixed together and answers nothing about the backlog.
    { label: 'Unscored', value: unscoredCount, href: '/jobs?unscored=1', warn: unscoredCount > 0 },
    { label: 'In pipeline', value: inPipelineCount, href: '/pipeline' },
  ]

  return (
    <section className="overflow-hidden rounded-card border bg-card shadow-card">
      {/* Header row: greeting + one status line + live indicator. The mesh
          is the "make it look alive" depth cue — an ambient accent field
          instead of a 3D asset, masked out before it reaches the gauges. */}
      <div className="relative flex flex-wrap items-end justify-between gap-4 px-6 py-5">
        <GradientMesh className="[mask-image:linear-gradient(to_bottom,black,transparent_92%)]" />
        <div className="relative min-w-0">
          <p className="font-readout text-label uppercase tracking-[0.14em] text-muted-foreground">
            {greeting}
            {firstName ? ` · ${firstName}` : ''}
          </p>
          <h1 className="mt-1.5 font-display text-title text-foreground">{status}</h1>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Ping only when there's actually been a sweep recently — an
              always-on ping (regardless of lastScrapedAt, including null)
              reports nothing, same reasoning as the `streaming &&` gate on
              this class in app/(app)/copilot/page.tsx. */}
          {recentlyScraped && <span className="signal-dot" aria-hidden />}
          <span className="font-readout text-caption tabular-nums text-muted-foreground">
            {lastScrapedAt ? `swept ${formatRelativeTime(lastScrapedAt)}` : 'awaiting first sweep'}
          </span>
        </div>
      </div>

      {/* Readout gauges. No .instrument-ruling here on purpose: at this
          4-column width it rules a hairline every 28px — ~34 phantom column
          edges across the strip that make four values read as a broken
          table instead of four gauges. */}
      <div className="grid grid-cols-2 border-t bg-sunken/40 sm:grid-cols-4">
        {vitals.map((vital, i) => {
          // Explicit dividers: 2-up on mobile, 4-up on desktop, no trailing edge.
          const borders = [
            'border-r border-b sm:border-b-0',
            'sm:border-r border-b sm:border-b-0',
            'border-r',
            '',
          ][i]

          const isUnscoredTile = vital.label === 'Unscored'

          // The Unscored tile gets a "Score now" trigger alongside its count
          // — nested inside a Link's <a> would be invalid HTML, so this tile
          // renders as its own container with the label as a sub-link.
          if (isUnscoredTile && onCalculateBatch) {
            const isBlocked = !!calculateDisabledReason
            const scoreButton = (
              <button
                type="button"
                onClick={() => {
                  if (!isCalculatingBatch && !isBlocked) onCalculateBatch()
                }}
                // aria-disabled, not native `disabled`: keeps the button
                // hoverable/focusable so the reason tooltip stays reachable
                // instead of the control silently doing nothing.
                aria-disabled={isCalculatingBatch || isBlocked}
                aria-label="Score unscored jobs now"
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isCalculatingBatch ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {isCalculatingBatch ? 'Scoring…' : 'Score now'}
              </button>
            )

            return (
              <div key={vital.label} className={`relative px-6 py-4 ${borders}`}>
                <Link
                  href={vital.href}
                  className="group inline-flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-readout text-label uppercase tracking-[0.12em] text-muted-foreground group-hover:text-foreground">
                    {vital.label}
                  </span>
                  {vital.live && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                </Link>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Link
                    href={vital.href}
                    className={`font-readout text-readout font-bold tabular-nums ${
                      vital.live
                        ? 'text-accent-deep'
                        : vital.warn
                          ? 'text-yellow-700 dark:text-yellow-300'
                          : 'text-foreground'
                    }`}
                  >
                    <CountUp value={vital.value} />
                  </Link>
                  {vital.value > 0 && (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>{scoreButton}</TooltipTrigger>
                        {/* Always render content: pressing this spends up to
                            BATCH_LIMIT metered LLM calls, so the cost (or the
                            block reason, if it can't run) must show up front
                            — never a silent/empty tooltip on the enabled
                            path. Matches the standard on the jobs page's
                            "Score unscored jobs" button. */}
                        <TooltipContent side="bottom" className="max-w-xs p-3">
                          {isBlocked ? (
                            <div className="space-y-2">
                              <p>{calculateDisabledReason}</p>
                              {onRetryStatus && calculateDisabledReason?.startsWith("Couldn't check") && (
                                <button
                                  type="button"
                                  onClick={onRetryStatus}
                                  className="rounded-control border px-2 py-1 text-caption font-medium hover:bg-raised"
                                >
                                  Retry
                                </button>
                              )}
                            </div>
                          ) : (
                            // No budget-remaining figure here (unlike the jobs
                            // page's `budgetHint`, computed there from
                            // profiles.preferences.budget): that data isn't
                            // among this component's props, and the task
                            // guarding this file forbids adding a new fetch
                            // for it. This line is still true without it.
                            <p className="text-caption text-muted-foreground">
                              Scores up to {BATCH_LIMIT} jobs per click — uses a metered AI call per
                              job.
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>
            )
          }

          return (
          <Link
            key={vital.label}
            href={vital.href}
            className={`group relative px-6 py-4 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${borders}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="font-readout text-label uppercase tracking-[0.12em] text-muted-foreground">
                {vital.label}
              </span>
              {vital.live && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              )}
            </div>
            <div
              className={`mt-2 font-readout text-readout font-bold tabular-nums ${
                vital.live
                  ? 'text-accent-deep'
                  : vital.warn
                    ? 'text-yellow-700 dark:text-yellow-300'
                    : 'text-foreground'
              }`}
            >
              <CountUp value={vital.value} />
            </div>
          </Link>
          )
        })}
      </div>
    </section>
  )
}
