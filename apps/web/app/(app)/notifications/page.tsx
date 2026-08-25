'use client'

import { LogoMark } from '@/components/brand/logo'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Bell, CalendarClock, FileWarning, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { StaggerGroup, StaggerItem } from '@/components/ui/motion'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { cn, formatRelativeTime } from '@/lib/utils'

interface HotJob {
  id: string
  title: string
  match_score: number | null
  posted_at: string | null
  discovered_at: string
  companies: { name: string | null } | null
}

interface InterviewActivity {
  id: string
  type: string
  title: string
  occurred_at: string
  application_id: string
  applications: {
    id: string
    jobs: { title: string; companies: { name: string | null } | null } | null
  } | null
}

interface OverdueFollowUp {
  id: string
  note: string
  due_date: string
  application_id: string | null
  contact_id: string | null
}

function NotificationsSkeleton() {
  return (
    <div className="space-y-6">
      {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
      <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <h1 className="sr-only">Notifications — loading…</h1>
        <span className="text-caption text-muted-foreground">Loading your notifications…</span>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card className="divide-y">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </Card>
    </div>
  )
}

type Section = {
  key: string
  icon: typeof AlertTriangle
  title: string
  description: string
  tone: 'urgent' | 'signal' | 'opportunity'
  rows: React.ReactNode[]
}

const TONE_ICON_CLASS: Record<Section['tone'], string> = {
  urgent: 'bg-red-500/10 text-red-600 dark:text-red-400',
  signal: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  opportunity: 'bg-accent-soft text-accent-deep',
}

const TONE_DOT_CLASS: Record<Section['tone'], string> = {
  urgent: 'bg-red-500',
  signal: 'bg-teal-500',
  opportunity: 'bg-accent',
}

export default function NotificationsPage() {
  const supabase = createClient()
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hotJobs, setHotJobs] = useState<HotJob[]>([])
  const [interviews, setInterviews] = useState<InterviewActivity[]>([])
  const [overdueFollowUps, setOverdueFollowUps] = useState<OverdueFollowUp[]>([])

  // Guards state updates once the component (or the effect that first fired
  // this load) has unmounted — a plain closure var can't survive being
  // called again from the Retry button below, so it lives in a ref instead.
  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    // setIsLoading matters on RETRY: without it the retry clears loadError
    // while isLoading is already false, so the "all caught up" state shows
    // while the refetch is still in flight.
    if (!cancelledRef.current) setIsLoading(true)
    setLoadError(null)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        if (!cancelledRef.current) setLoadError("Couldn't verify your session. Sign in again and try again.")
        return
      }

      const now = new Date().toISOString()

      const [hotJobsRes, interviewsRes, followUpsRes] = await Promise.all([
        // New, unreviewed jobs that scored well. RLS already scopes jobs to
        // this user's tracked companies.
        supabase
          .from('jobs')
          .select('id, title, match_score, posted_at, discovered_at, companies(name)')
          .eq('is_new', true)
          .gte('match_score', 70)
          .order('match_score', { ascending: false })
          .limit(8),
        // Interview-stage signal picked up from Gmail sync (or manual notes).
        supabase
          .from('activities')
          .select(
            'id, type, title, occurred_at, application_id, applications(id, jobs(title, companies(name)))'
          )
          .ilike('type', '%interview%')
          .order('occurred_at', { ascending: false })
          .limit(8),
        supabase
          .from('follow_ups')
          .select('id, note, due_date, application_id, contact_id')
          .eq('is_completed', false)
          .lt('due_date', now)
          .order('due_date', { ascending: true })
          .limit(8),
      ])

      if (cancelledRef.current) return

      const failure = hotJobsRes.error ?? interviewsRes.error ?? followUpsRes.error
      if (failure) {
        console.error('Error loading notifications:', failure)
        setLoadError("Couldn't load your notifications. Check your connection and try again.")
        return
      }

      setHotJobs((hotJobsRes.data as unknown as HotJob[]) || [])
      setInterviews((interviewsRes.data as unknown as InterviewActivity[]) || [])
      setOverdueFollowUps((followUpsRes.data as OverdueFollowUp[]) || [])
    } catch {
      // A thrown failure never produces a Supabase `{ error }` object, so
      // checking only that left a dead backend rendering "Nothing needs your
      // attention" — the single most misleading sentence this page can print.
      if (!cancelledRef.current) {
        setLoadError("Couldn't load your notifications. Check your connection and try again.")
      }
    } finally {
      if (!cancelledRef.current) setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    load()
    return () => {
      cancelledRef.current = true
    }
  }, [load])

  if (isLoading) {
    return <NotificationsSkeleton />
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-title text-foreground">Notifications</h1>
          <p className="mt-1 text-body text-muted-foreground">
            New high-scoring jobs, interview signal from Gmail, and follow-ups you're late on.
          </p>
        </div>
        <EmptyState
          icon={FileWarning}
          title="Couldn't load your notifications"
          body={loadError}
          action={<Button onClick={load}>Retry</Button>}
        />
      </div>
    )
  }

  const isEmpty = hotJobs.length === 0 && interviews.length === 0 && overdueFollowUps.length === 0

  const sections: Section[] = []

  if (overdueFollowUps.length > 0) {
    sections.push({
      key: 'overdue',
      icon: AlertTriangle,
      title: 'Overdue follow-ups',
      description: `${overdueFollowUps.length} follow-up${overdueFollowUps.length === 1 ? '' : 's'} past due`,
      tone: 'urgent',
      rows: overdueFollowUps.map((fu) => (
        <Row
          key={fu.id}
          tone="urgent"
          title={fu.note}
          subtitle={`Due ${formatRelativeTime(fu.due_date)}`}
          subtitleClassName="text-red-600 dark:text-red-400"
          href={fu.application_id ? '/pipeline' : '/contacts'}
        />
      )),
    })
  }

  if (interviews.length > 0) {
    sections.push({
      key: 'interviews',
      icon: CalendarClock,
      title: 'Interview signal',
      description: 'Picked up from your Gmail tracker',
      tone: 'signal',
      rows: interviews.map((activity) => (
        <Row
          key={activity.id}
          tone="signal"
          title={activity.title}
          subtitle={[
            activity.applications?.jobs?.title,
            activity.applications?.jobs?.companies?.name,
            formatRelativeTime(activity.occurred_at),
          ]
            .filter(Boolean)
            .join(' · ')}
          href="/pipeline"
        />
      )),
    })
  }

  if (hotJobs.length > 0) {
    sections.push({
      key: 'hot-jobs',
      icon: Sparkles,
      title: 'New high-scoring jobs',
      description: 'Unreviewed jobs matching your resume well',
      tone: 'opportunity',
      rows: hotJobs.map((job) => (
        <Row
          key={job.id}
          tone="opportunity"
          title={job.title}
          subtitle={[job.companies?.name ?? 'Unknown company', formatRelativeTime(job.posted_at ?? job.discovered_at)].join(
            ' · '
          )}
          // Opens THIS job, not the list. This row names a specific role and
          // its score; linking at bare /jobs dropped the user into an
          // unfiltered feed of ~11,800 rows to find it by title from memory.
          href={`/jobs?job=${job.id}`}
          trailing={<Badge tone="good">{job.match_score}</Badge>}
        />
      )),
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-title text-foreground">Notifications</h1>
        <p className="mt-1 text-body text-muted-foreground">
          New high-scoring jobs, interview signal from Gmail, and follow-ups you're late on.
        </p>
      </div>

      {isEmpty ? (
        <EmptyState
          icon={Bell}
          title="Nothing needs your attention"
          body="This fills in once jobs are scored, an interview email is picked up by the Gmail tracker, or a follow-up goes overdue."
          action={
            <Button asChild>
              <Link href="/jobs">Review jobs</Link>
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <StaggerGroup>
            {sections.map((section, i) => {
              const Icon = section.icon
              return (
                <StaggerItem key={section.key}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center gap-3 px-5 pb-3 pt-5">
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-control',
                        TONE_ICON_CLASS[section.tone]
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-body font-semibold text-foreground">{section.title}</h2>
                      <p className="text-caption text-muted-foreground">{section.description}</p>
                    </div>
                  </div>
                  <ul className="divide-y divide-border/60 px-5 pb-2">{section.rows}</ul>
                </StaggerItem>
              )
            })}
          </StaggerGroup>
        </Card>
      )}
    </div>
  )
}

function Row({
  tone,
  title,
  subtitle,
  subtitleClassName,
  href,
  trailing,
}: {
  tone: Section['tone']
  title: string
  subtitle: string
  subtitleClassName?: string
  href: string
  trailing?: React.ReactNode
}) {
  return (
    <li className="group flex items-center gap-3 py-2.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT_CLASS[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-foreground">{title}</p>
        <p className={cn('truncate text-caption text-muted-foreground', subtitleClassName)}>{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {trailing}
        <Button
          size="sm"
          variant="outline"
          asChild
          className="opacity-80 transition-opacity group-hover:opacity-100"
        >
          <Link href={href}>Open</Link>
        </Button>
      </div>
    </li>
  )
}
