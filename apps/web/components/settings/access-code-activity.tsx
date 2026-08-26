'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Circle, Eye, Loader2, LogIn, RotateCw, ShieldAlert, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  AccessCodeEventKind,
  AccessCodeTimelineEntry,
} from '@/app/api/access-codes/contract'

// `import type` above is load-bearing, not style: contract.ts transitively
// imports node:crypto (via lib/access/codes.ts), so a value import from here
// would pull crypto into the browser bundle. Types are erased at compile time.

export interface AccessCodeActivityProps {
  codeId: string
  /** The code's label or prefix — only used to name the region for screen readers. */
  codeName: string
  className?: string
}

interface EventsResponse {
  events?: AccessCodeTimelineEntry[]
  hasMore?: boolean
  nextOffset?: number | null
  error?: string
}

/** Icon + tone per event kind. Accent is spent only on the sign-in itself. */
const KIND_STYLES: Record<
  AccessCodeEventKind,
  { icon: typeof LogIn; className: string; label: string }
> = {
  redeemed: {
    icon: LogIn,
    // The one genuinely "live" moment in a trail: someone walked through the
    // door. Everything else is ordinary use and stays neutral, so the accent
    // still means something when you scan the column.
    className: 'bg-accent-soft text-accent-deep',
    label: 'Signed in',
  },
  action: { icon: Zap, className: 'bg-sunken text-foreground', label: 'Action' },
  page_view: { icon: Eye, className: 'bg-sunken text-muted-foreground', label: 'Page view' },
  denied: {
    icon: ShieldAlert,
    className: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    label: 'Blocked',
  },
  other: { icon: Circle, className: 'bg-sunken text-muted-foreground', label: 'Event' },
}

/**
 * The readable trail of what one code's holder actually did.
 *
 * This is the point of the whole feature, so it is written as a story rather
 * than a table: events group under "Today" / "Yesterday" / a date, each row is
 * one sentence the server already phrased (see app/api/access-codes/contract.ts),
 * and the timestamp sits to the side where it can be skimmed or ignored.
 *
 * Mounted only while a code's activity is expanded — it fetches on mount, so a
 * card listing twenty codes issues no requests until the owner asks about one.
 */
export function AccessCodeActivity({ codeId, codeName, className }: AccessCodeActivityProps) {
  const [entries, setEntries] = useState<AccessCodeTimelineEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  // Kept apart from `error` on purpose. `error` owns the whole panel — it means
  // "there is no trail on screen and we could not fetch one". A page that fails
  // while paging BACKWARDS is a different, much smaller event: everything
  // already fetched is still true and still on screen, so it is reported next
  // to the button that caused it and nothing is thrown away. Collapsing the two
  // is what made one failed "Load older activity" destroy the timeline.
  const [moreError, setMoreError] = useState<string | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const load = useCallback(
    async (offset: number) => {
      const isFirstPage = offset === 0
      if (isFirstPage) {
        setState('loading')
        setError(null)
        // A fresh load replaces the whole trail, so a stale paging error from
        // the previous one no longer describes anything on screen.
        setMoreError(null)
      } else {
        setIsLoadingMore(true)
        setMoreError(null)
      }

      // Where a failure goes: the first page owns the panel, a later page owns
      // only the line under the button. `nextOffset` is deliberately NOT
      // cleared on a paging failure — the retry must ask for the same page
      // again, not skip it.
      const fail = (message: string) => {
        if (isFirstPage) {
          setError(message)
          setState('error')
        } else {
          setMoreError(message)
        }
      }

      try {
        const response = await fetch(`/api/access-codes/${codeId}/events?offset=${offset}`)
        const payload = (await response.json().catch(() => ({}))) as EventsResponse

        if (!response.ok) {
          fail(payload.error || "Couldn't load the activity for this code.")
          return
        }

        const page = payload.events ?? []
        // Append on "load more", replace on a fresh load — so a refresh never
        // leaves stale rows underneath newly fetched ones.
        setEntries((current) => (isFirstPage ? page : [...current, ...page]))
        setNextOffset(payload.hasMore ? (payload.nextOffset ?? null) : null)
        setState('ready')
      } catch {
        fail("Couldn't reach the server. Check your connection and try again.")
      } finally {
        setIsLoadingMore(false)
      }
    },
    [codeId]
  )

  useEffect(() => {
    load(0)
  }, [load])

  const groups = groupByDay(entries)

  return (
    <div className={cn('rounded-card bg-sunken/60 p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-label uppercase text-muted-foreground">Activity</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => load(0)}
          disabled={state === 'loading'}
        >
          <RotateCw className={cn('h-3.5 w-3.5', state === 'loading' && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {/* Which branch renders is a question about whether there is a TRAIL to
          show, not about whether the last request worked. Once events have been
          fetched they survive a refresh and a refresh that fails — the failure
          becomes a line above them (below), never a panel replacing them. */}
      {state === 'loading' && entries.length === 0 ? (
        // Skeletons are decoration; the sentence is what a screen reader needs.
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading activity for {codeName}…</span>
          <ul aria-hidden className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="skeleton h-6 w-6 rounded-full" />
                <span className="skeleton h-4 flex-1" />
              </li>
            ))}
          </ul>
        </div>
      ) : state === 'error' && entries.length === 0 ? (
        <div className="flex items-start gap-2 rounded-control bg-red-50 p-3 text-body text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p>{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => load(0)}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : entries.length === 0 ? (
        <p className="py-2 text-body text-muted-foreground">
          Nothing yet — this code has not been used.
        </p>
      ) : (
        <>
          {state === 'error' && (
            <p
              role="alert"
              className="mb-2 flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {error} This is the trail from the last successful load.
            </p>
          )}
          <ol className="space-y-4" aria-label={`Activity for ${codeName}`}>
            {groups.map((group) => (
              <li key={group.key}>
                <h5 className="text-label uppercase text-muted-foreground">{group.label}</h5>
                <ol className="mt-1.5 space-y-0.5">
                  {group.entries.map((entry) => (
                    <TimelineRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>

          {(nextOffset !== null || moreError) && (
            <div className="mt-3">
              {/* role="alert" because the failure happens after a deliberate
                  click, usually with focus still on the button below it —
                  nothing else would tell a screen-reader user the page they
                  asked for never arrived. */}
              {moreError && (
                <p
                  role="alert"
                  className="mb-2 flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {moreError} The activity above is still what was recorded.
                </p>
              )}
              {nextOffset !== null && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => load(nextOffset)}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  {moreError ? 'Try older activity again' : 'Load older activity'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TimelineRow({ entry }: { entry: AccessCodeTimelineEntry }) {
  const style = KIND_STYLES[entry.kind] ?? KIND_STYLES.other
  const Icon = style.icon

  return (
    <li className="flex items-start gap-3 rounded-control px-1.5 py-1.5">
      <span
        className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', style.className)}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">{style.label}:</span>
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-body text-foreground">{entry.title}</p>
        {(entry.note || entry.clientHint) && (
          <p className="text-caption text-muted-foreground">
            {entry.note}
            {entry.note && entry.clientHint ? ' · ' : null}
            {/* An opaque HMAC of user-agent + IP, not an identity (see
                lib/access/audit.ts). It exists so two people sharing one code
                are visibly two people — "visitor" is the honest word for it. */}
            {entry.clientHint ? `visitor ${entry.clientHint}` : null}
          </p>
        )}
      </div>

      <time
        dateTime={entry.occurredAt}
        className="shrink-0 pt-0.5 text-caption tabular-nums text-muted-foreground"
      >
        {formatTimeOfDay(entry.occurredAt)}
      </time>
    </li>
  )
}

interface DayGroup {
  key: string
  label: string
  entries: AccessCodeTimelineEntry[]
}

/**
 * Split a newest-first list into day buckets, preserving order.
 *
 * A 72-hour demo produces at most a handful of days, and "Today / Yesterday /
 * Aug 1" is how a person asks the question this feature answers — far more
 * legible than 60 rows each repeating their own full date.
 */
function groupByDay(entries: AccessCodeTimelineEntry[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = []
  for (const entry of entries) {
    const key = dayKey(new Date(entry.occurredAt))
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.entries.push(entry)
      continue
    }
    groups.push({ key, label: dayLabel(entry.occurredAt, now), entries: [entry] })
  }
  return groups
}

function dayKey(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'unknown'
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  if (dayKey(date) === dayKey(now)) return 'Today'
  const yesterday = new Date(now.getTime())
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday'

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

function formatTimeOfDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
