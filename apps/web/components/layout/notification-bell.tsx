'use client'

// Notifications as a POPOVER, not a destination.
//
// WHY THIS EXISTS
//   /notifications was a primary nav slot for three read-only lists — overdue
//   follow-ups, interview signal from Gmail, new high-scoring jobs — that a
//   person glances at and then leaves. A glance does not need a page, and it
//   was costing a slot in a rail that deliberately holds only a handful of
//   daily destinations (see nav-items.ts). So the bell reads the same three
//   buckets with the same predicates and shows them inline; the ROUTE is
//   untouched and still linked from the foot of this popover, so every deep
//   link, bookmark and in-page "Open" link into /notifications keeps working.
//
// THE FOURTH BUCKET — THE REVIEW QUEUE
//   lib/ats-apply/index.ts deliberately fails CLOSED — it hands off to a human
//   instead of submitting whenever it cannot prove the résumé is real, a
//   required question is unanswerable, or a knock-out question is present —
//   and autopilot (lib/graph/autopilot.ts) runs that path unattended, all
//   night, with `autoSubmit` hardcoded false. Failing closed is only a safety
//   property if the human actually finds out; otherwise a night's worth of
//   handoffs sits at /queue completely unannounced and the user believes
//   their applications went out. That is worse than a refusal, so this bucket
//   reads app/api/notifications/queue (application_drafts still
//   pending_review) the same way the other three read their own source, and
//   is deliberately isolated from them (see fetchFeed below): a failure here
//   must not blank three buckets of data that loaded just fine.
//
// WHERE IT IS MOUNTED, AND WHY IN TWO PLACES
//   header.tsx is `md:hidden` on purpose — at desktop widths the whole top
//   band is gone and the left rail is the entire shell (read header.tsx for
//   the full reasoning). A bell mounted only there would therefore be
//   display:none for every desktop user, i.e. unreachable, which is the exact
//   class of bug this change is fixing. So it is mounted twice: the mobile top
//   bar (header.tsx) and the desktop rail (sidebar.tsx). Those two are
//   mutually exclusive VISUALLY but not in the DOM — both are always mounted
//   and hidden by media query — which is why the fetch below is deduplicated
//   at module scope rather than run per-instance.

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, CalendarClock, Inbox, Sparkles, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { cn, formatRelativeTime } from '@/lib/utils'
import type { ReviewQueueItem } from '@/lib/notifications/queue'

type NotificationKind = 'queue' | 'overdue' | 'interview' | 'job'

interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  subtitle: string
  /** Where "open this" goes — the same targets the /notifications rows use. */
  href: string
}

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  queue: Inbox,
  overdue: AlertTriangle,
  interview: CalendarClock,
  job: Sparkles,
}

/** The tone vocabulary of the /notifications page's three sections, plus the
 *  queue, so the popover and the page can never read as two different
 *  features. `job` and `queue` both use the accent: a newly-discovered
 *  high-scoring job and a prepared application waiting on YOU are the two
 *  genuinely live signals here — everything else is a state, not an event.
 *  See the file header for why queue is arguably the more urgent of the two:
 *  it is what failing closed looks like when nobody has looked yet. */
const KIND_ICON_CLASS: Record<NotificationKind, string> = {
  queue: 'text-accent-deep',
  overdue: 'text-red-600 dark:text-red-400',
  interview: 'text-teal-600 dark:text-teal-400',
  job: 'text-accent-deep',
}

/** Row caps per bucket. Small on purpose: this is a glance, and "View all
 *  notifications" (or, for the queue, /queue itself) is one click away. */
const LIMITS = { queue: 5, overdue: 5, interview: 3, jobs: 5 } as const

/** How long a fetched feed is reused before opening the popover refetches. */
const CACHE_TTL_MS = 60_000

// Module scope, not component state: this component is mounted twice (see the
// header comment) and both instances live for the whole session, since the app
// shell never unmounts across route changes. Without this the app would issue
// two identical triples of queries on first paint and again on every refresh.
let cachedItems: NotificationItem[] | null = null
let cachedAt = 0
let inFlight: Promise<NotificationItem[]> | null = null

/** Supabase embeds a to-one relation as an object, but types it as either. */
function relatedName(
  rel: { name?: string | null } | { name?: string | null }[] | null | undefined
): string | null {
  const one = Array.isArray(rel) ? rel[0] : rel
  return one?.name ?? null
}

/**
 * The review queue bucket — application_drafts still pending_review, via
 * app/api/notifications/queue (application_drafts isn't in the typed
 * Database the `supabase` client above uses, same reason app/api/drafts/
 * route.ts goes through the admin client instead of RLS).
 *
 * DELIBERATELY NEVER THROWS. The other three buckets read straight from
 * Supabase and a failure among THEM still means "the whole feed is suspect" —
 * that's the existing, unchanged behaviour. This one is an HTTP round trip to
 * a route this same change adds, so it is more likely to be the thing that's
 * briefly down, and a bell that goes blank for overdue follow-ups and
 * interview activity because the newest bucket hiccuped would be a strictly
 * worse bell than the one this replaces. See fetchFeed's call site.
 */
async function fetchQueueBucket(): Promise<NotificationItem[]> {
  try {
    const res = await fetch(`/api/notifications/queue?limit=${LIMITS.queue}`)
    if (!res.ok) return []
    const data = (await res.json().catch(() => null)) as { items?: ReviewQueueItem[] } | null
    return (data?.items ?? []).map((item) => ({
      id: `queue:${item.draftId}`,
      kind: 'queue' as const,
      title: `${item.title} · ${item.companyName}`,
      subtitle: item.reason,
      href: '/queue',
    }))
  } catch (err) {
    console.error('[notification-bell] queue bucket failed', err)
    return []
  }
}

/**
 * The same three reads /notifications performs, with smaller limits, plus the
 * review queue (see fetchQueueBucket above). RLS is what scopes
 * jobs/activities/follow_ups to this user — exactly as on the page, which is
 * why there is no explicit user_id filter on those three.
 */
async function fetchFeed(): Promise<NotificationItem[]> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // Signed out is not an error — the shell renders this before redirecting.
  if (!user) return []

  const now = new Date().toISOString()

  const [queueItems, followUpsRes, interviewsRes, hotJobsRes] = await Promise.all([
    fetchQueueBucket(),
    supabase
      .from('follow_ups')
      .select('id, note, due_date, application_id')
      .eq('is_completed', false)
      .lt('due_date', now)
      .order('due_date', { ascending: true })
      .limit(LIMITS.overdue),
    supabase
      .from('activities')
      .select('id, title, occurred_at, applications(id, jobs(title, companies(name)))')
      .ilike('type', '%interview%')
      .order('occurred_at', { ascending: false })
      .limit(LIMITS.interview),
    supabase
      .from('jobs')
      .select('id, title, match_score, posted_at, discovered_at, companies(name)')
      .eq('is_new', true)
      .gte('match_score', 70)
      .order('match_score', { ascending: false })
      .limit(LIMITS.jobs),
  ])

  const failure = followUpsRes.error ?? interviewsRes.error ?? hotJobsRes.error
  if (failure) throw new Error(failure.message)

  // Queue first: a pile of handoffs from an overnight run is the most
  // actionable thing in this popover — see the file header on why failing
  // closed is only a safety property once the human has actually seen it.
  const items: NotificationItem[] = [...queueItems]

  for (const row of (followUpsRes.data ?? []) as {
    id: string
    note: string
    due_date: string
    application_id: string | null
  }[]) {
    items.push({
      id: `follow-up:${row.id}`,
      kind: 'overdue',
      title: row.note,
      subtitle: `Due ${formatRelativeTime(row.due_date)}`,
      href: row.application_id ? '/pipeline' : '/contacts',
    })
  }

  for (const row of (interviewsRes.data ?? []) as unknown as {
    id: string
    title: string
    occurred_at: string
    applications: { jobs: { title: string; companies: { name: string | null } | null } | null } | null
  }[]) {
    items.push({
      id: `activity:${row.id}`,
      kind: 'interview',
      title: row.title,
      subtitle: [
        row.applications?.jobs?.title,
        relatedName(row.applications?.jobs?.companies),
        formatRelativeTime(row.occurred_at),
      ]
        .filter(Boolean)
        .join(' · '),
      href: '/pipeline',
    })
  }

  for (const row of (hotJobsRes.data ?? []) as unknown as {
    id: string
    title: string
    match_score: number | null
    posted_at: string | null
    discovered_at: string
    companies: { name: string | null } | { name: string | null }[] | null
  }[]) {
    items.push({
      id: `job:${row.id}`,
      kind: 'job',
      title: row.title,
      subtitle: [
        relatedName(row.companies) ?? 'Unknown company',
        formatRelativeTime(row.posted_at ?? row.discovered_at),
      ].join(' · '),
      // The specific job, not the list — same reason the page's row does it:
      // /jobs alone drops you into an unfiltered feed to find it by memory.
      href: `/jobs?job=${row.id}`,
    })
  }

  return items
}

function loadFeed(force: boolean): Promise<NotificationItem[]> {
  if (!force && cachedItems && Date.now() - cachedAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedItems)
  }
  if (inFlight) return inFlight
  inFlight = fetchFeed()
    .then((items) => {
      cachedItems = items
      cachedAt = Date.now()
      return items
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

type FeedState = 'loading' | 'ready' | 'error'

function useNotificationFeed() {
  // Seeded from the module cache so the second mount point (and any remount,
  // e.g. collapsing the rail) paints its badge immediately instead of flashing
  // a loading row for data already in memory.
  const [items, setItems] = useState<NotificationItem[]>(cachedItems ?? [])
  const [state, setState] = useState<FeedState>(cachedItems ? 'ready' : 'loading')
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback((force = false) => {
    // A refresh over data we already have keeps showing that data rather than
    // blanking the popover the user is currently reading.
    if (!cachedItems) setState('loading')
    loadFeed(force)
      .then((next) => {
        if (!mountedRef.current) return
        setItems(next)
        setState('ready')
      })
      .catch((err) => {
        console.error('[notification-bell] load failed', err)
        if (mountedRef.current) setState('error')
      })
  }, [])

  useEffect(() => {
    refresh(false)
  }, [refresh])

  return { items, state, refresh }
}

export interface NotificationBellProps {
  /** Popover placement — bottom/end under the mobile bar, right in the rail. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
}

export function NotificationBell({ side = 'bottom', align = 'end', className }: NotificationBellProps) {
  const { items, state, refresh } = useNotificationFeed()
  const count = state === 'ready' ? items.length : 0

  const label =
    state === 'error'
      ? 'Notifications — could not be loaded'
      : count === 0
        ? 'Notifications — nothing new'
        : `Notifications — ${count} needing attention`

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Opening is the one moment the freshness of this list matters; TTL
        // keeps that from becoming a query on every open.
        if (open) refresh(false)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative shrink-0 text-muted-foreground hover:text-foreground', className)}
          aria-label={label}
          aria-haspopup="menu"
        >
          <Bell className="h-[18px] w-[18px]" />
          {count > 0 && (
            // --accent is the app's only "live" colour, and an unread count is
            // exactly that. aria-hidden because the trigger's own aria-label
            // already says the number — otherwise it is read twice.
            <span
              aria-hidden
              className="absolute right-1 top-1 min-w-[15px] rounded-full bg-accent px-[3px] text-center text-[10px] font-semibold leading-[15px] text-accent-foreground"
            >
              {count > 9 ? '9+' : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side={side}
        align={align}
        className="w-[min(20rem,calc(100vw-2rem))] p-0"
      >
        <DropdownMenuLabel className="px-3 py-2 text-label uppercase text-muted-foreground">
          Notifications
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-0" />

        {state === 'loading' && (
          <p className="px-3 py-6 text-center text-caption text-muted-foreground">
            Checking for updates&hellip;
          </p>
        )}

        {state === 'error' && (
          <>
            <p className="px-3 pb-1 pt-5 text-center text-caption text-muted-foreground">
              Couldn&rsquo;t load your notifications.
            </p>
            <DropdownMenuItem
              className="justify-center text-caption font-medium"
              onSelect={(event) => {
                // Keep the popover open so the retry's result is visible.
                event.preventDefault()
                refresh(true)
              }}
            >
              Try again
            </DropdownMenuItem>
          </>
        )}

        {state === 'ready' && count === 0 && (
          <p className="px-3 py-6 text-center text-caption text-muted-foreground">
            You&rsquo;re all caught up.
          </p>
        )}

        {state === 'ready' && count > 0 && (
          // A plain div, not a <ul>: everything between role="menu" and its
          // role="menuitem" children has to be transparent, and a list would
          // sit in that gap.
          <div className="max-h-[60vh] overflow-y-auto py-1 scrollbar-thin">
            {items.map((item) => {
              const Icon = KIND_ICON[item.kind]
              return (
                <DropdownMenuItem key={item.id} asChild className="items-start gap-2.5 px-3 py-2">
                  <Link href={item.href}>
                    <Icon
                      aria-hidden
                      className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', KIND_ICON_CLASS[item.kind])}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption text-foreground">{item.title}</span>
                      <span className="block truncate text-label text-muted-foreground">
                        {item.subtitle}
                      </span>
                    </span>
                  </Link>
                </DropdownMenuItem>
              )
            })}
          </div>
        )}

        <DropdownMenuSeparator className="mx-0" />
        {/* The route survives this change — deep links, bookmarks and every
            in-app link to /notifications still resolve. It just no longer
            occupies a nav slot. */}
        <DropdownMenuItem asChild className="justify-center py-2">
          <Link href="/notifications" className="text-caption font-medium">
            View all notifications
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
