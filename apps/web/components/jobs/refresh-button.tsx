'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'

// WHY THIS BUTTON LOOPS
//   POST /api/jobs/refresh used to be one request that refreshed every company
//   the user owns. At 436 companies — each needing provider detection before a
//   single job is read — that work runs for minutes, while the function is
//   capped at 60s. The button could never succeed: it sat on "Refreshing…"
//   forever with no toast and no error, and no new roles ever appeared.
//
//   The route is now a LangGraph thread handoff: the first call mints a
//   `threadId` and does what it can inside the graph's own soft time budget;
//   every call after that resumes the SAME thread instead of the client
//   driving a raw cursor integer (lib/graph/refresh.ts — durable, resumable
//   even across a killed request, not just a slow one). This component still
//   drives that to completion round after round, so the user sees
//   companies-done climbing instead of a spinner that never resolves, and can
//   stop it without leaving a half-finished run wedged. Totals/found/inserted
//   are only ever non-zero on the FINAL round (`done: true`) — an interrupted
//   round has no completed RunOutcome to report yet, only progress (see
//   route.ts's own HONEST STATUS note) — so this component assigns rather
//   than accumulates them.

interface RefreshResult {
  ok: boolean
  threadId: string
  results: Array<{
    companyId: string
    companyName: string
    provider: 'greenhouse' | 'lever' | 'ashby' | null
    found: number
    inserted: number
    errors: string[]
  }>
  totals: { found: number; inserted: number; companiesWithAts: number }
  /** Progress so far; null when the run is complete. */
  cursor: number | null
  total: number
  done: boolean
}

interface RefreshJobsButtonProps {
  /** Refresh a single company; omit to refresh all of the user's companies. */
  companyId?: string
  /** Called after each completed round so the parent can refetch incrementally. */
  onRefreshed?: () => void
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
}

interface Progress {
  companiesDone: number
  total: number
  inserted: number
  found: number
  withAts: number
}

/**
 * A run should always terminate because the server advances `processed`
 * (lib/graph/refresh.ts's own contiguous-prefix guarantee — see that file's
 * header), but a server that stopped advancing would spin this loop forever
 * — the exact bug this component exists to fix. Two independent guards:
 * `processed` must strictly increase, and the whole run is capped at a round
 * count far above any real one (one round covers many companies).
 */
const MAX_ROUNDS = 500

/** Prominent "Refresh jobs" action. Drives POST /api/jobs/refresh to completion. */
export function RefreshJobsButton({
  companyId,
  onRefreshed,
  variant = 'default',
  size = 'default',
  className,
}: RefreshJobsButtonProps) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const stopRef = useRef(false)

  const refresh = useCallback(async () => {
    stopRef.current = false
    setProgress({ companiesDone: 0, total: 0, inserted: 0, found: 0, withAts: 0 })

    let threadId: string | undefined
    let done = false
    let rounds = 0
    let previousProcessed = 0
    const run: Progress = { companiesDone: 0, total: 0, inserted: 0, found: 0, withAts: 0 }

    try {
      while (!done && !stopRef.current) {
        if (++rounds > MAX_ROUNDS) {
          throw new Error(`Refresh did not finish after ${MAX_ROUNDS} rounds — stopped.`)
        }

        const response = await fetch('/api/jobs/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(threadId ? { threadId } : companyId ? { companyId } : {}),
        })

        const data: RefreshResult | null = await response.json().catch(() => null)

        if (!response.ok || !data?.ok) {
          const message =
            (data as { error?: string } | null)?.error || `Refresh failed (${response.status})`
          throw new Error(message)
        }

        threadId = data.threadId
        // Totals are only real on the final round (route.ts's HONEST STATUS
        // note) — an interrupted round reports zeros, so assigning rather
        // than accumulating always lands on the true final numbers.
        run.inserted = data.totals.inserted
        run.found = data.totals.found
        run.withAts = data.totals.companiesWithAts
        run.total = data.total
        run.companiesDone = data.done ? data.total : (data.cursor ?? run.companiesDone)
        setProgress({ ...run })

        // Let the list pick up this round's rows rather than making the user
        // wait for every company before anything appears.
        onRefreshed?.()

        done = data.done
        const processed = data.done ? data.total : (data.cursor ?? previousProcessed)
        if (!done && processed <= previousProcessed) {
          throw new Error('Refresh stopped making progress — please try again.')
        }
        previousProcessed = processed
      }

      const stopped = stopRef.current
      toast({
        title: stopped ? 'Refresh stopped' : 'Jobs refreshed',
        description:
          `${run.inserted} new · ${run.found} found · ` +
          `${run.companiesDone}/${run.total} ${run.total === 1 ? 'company' : 'companies'} checked` +
          (stopped ? ' before you stopped it' : ''),
      })
    } catch (error) {
      toast({
        title: 'Refresh failed',
        description:
          error instanceof Error ? error.message : 'Could not refresh jobs. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setProgress(null)
      stopRef.current = false
      onRefreshed?.()
    }
  }, [companyId, onRefreshed])

  const isRefreshing = progress !== null

  if (!isRefreshing) {
    return (
      <Button onClick={refresh} variant={variant} size={size} className={className}>
        <RefreshCw className="h-4 w-4" />
        Refresh jobs
      </Button>
    )
  }

  // A count that climbs is the whole point: it distinguishes "working through
  // 436 companies" from "wedged", which the old spinner could not.
  const label =
    progress.total > 0
      ? `Refreshing ${progress.companiesDone}/${progress.total}…`
      : 'Refreshing…'

  return (
    <span className="inline-flex items-center gap-1">
      <Button disabled variant={variant} size={size} className={className}>
        <Loader2 className="h-4 w-4 animate-spin" />
        {label}
      </Button>
      <Button
        variant="ghost"
        size={size}
        onClick={() => {
          stopRef.current = true
        }}
        aria-label="Stop refreshing jobs"
        title="Stop refreshing"
      >
        <X className="h-4 w-4" />
      </Button>
    </span>
  )
}
