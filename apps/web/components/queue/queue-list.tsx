'use client'

// The unmissable review queue — every application_drafts row still waiting on
// a human (status='pending_review'), in one list, each showing WHY and the
// single action that resolves it. See app/(app)/queue/page.tsx's header for
// why this exists: lib/ats-apply/index.ts deliberately fails closed instead of
// submitting when it cannot prove the résumé is real, a required question is
// answerable, or a knock-out question is absent — and a handoff nobody sees is
// worse than a refusal, because the user believes the application went out.
//
// LOADING / EMPTY / ERROR — THE SHAPE, NOT JUST THE STATES
//   Mirrors components/settings/access-code-activity.tsx: `state` only flips
//   to 'loading' before the FIRST successful load, and a failed REFRESH is
//   reported as a banner above the list that is still on screen, never by
//   blanking it. The exact bug that pattern was written to fix — a transient
//   fetch failure erasing data the user already saw — is precisely the bug an
//   "unmissable" queue cannot afford to have.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { HandoffCard } from './handoff-card'
import type { ReviewQueueItem } from '@/lib/notifications/queue'

type FeedState = 'loading' | 'ready' | 'error'

export interface QueueListProps {
  /** Called after any item resolves (approved or rejected) — lets a parent
   *  that keeps its own counts (e.g. the tab badge in page.tsx) refetch too. */
  onChanged?: () => void
}

export function QueueList({ onChanged }: QueueListProps) {
  const [items, setItems] = useState<ReviewQueueItem[]>([])
  const [state, setState] = useState<FeedState>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // Only the FIRST load shows the skeleton. A refresh over a list already on
    // screen keeps showing that list while it re-fetches — see this file's
    // header.
    setState((current) => (current === 'ready' ? current : 'loading'))
    try {
      const res = await fetch('/api/notifications/queue?limit=100')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Could not load the review queue (${res.status})`)
      setItems(Array.isArray(data.items) ? (data.items as ReviewQueueItem[]) : [])
      setState('ready')
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't reach the server. Check your connection and try again."
      )
      setState('error')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleResolved = useCallback(() => {
    load()
    onChanged?.()
  }, [load, onChanged])

  if (state === 'loading' && items.length === 0) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <span className="sr-only">Loading the review queue…</span>
        <Skeleton className="h-40 w-full" aria-hidden />
        <Skeleton className="h-40 w-full" aria-hidden />
      </div>
    )
  }

  if (state === 'error' && items.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-card border bg-card p-6 text-body text-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p>{error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nothing waiting for review"
        body="When autopilot or the apply flow can't safely submit on its own — a missing résumé, an unanswerable question, a knock-out question, no employer credential — it lands here with the reason and a way to finish it."
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* A failed REFRESH, with a populated list still underneath it — the
          list stays exactly as it was after the last successful load. */}
      {state === 'error' && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-control bg-red-50 px-3 py-2 text-caption text-red-700 dark:bg-red-500/10 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {error} This is the queue from the last successful load.
        </p>
      )}
      <h2 className="text-label uppercase text-muted-foreground">
        Needs you — {items.length}
      </h2>
      {items.map((item) => (
        <HandoffCard key={item.draftId} item={item} onResolved={handleResolved} />
      ))}
    </div>
  )
}
