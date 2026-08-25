'use client'

import { LogoMark } from '@/components/brand/logo'
import { useCallback, useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionTransition } from '@/components/ui/motion'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { StatRow, type StatRowItem } from '@/components/ui/stat-row'
import { createClient } from '@/lib/supabase/client'
import { FunnelBar } from '@/components/insights/funnel-bar'
import { WhatsWorking } from '@/components/insights/whats-working'
import { DigestCard } from '@/components/insights/digest-card'
import { StrategyPanel } from '@/components/insights/strategy-panel'
import { ScoreHistogramCard } from '@/components/insights/score-histogram-card'
import { SourcePerformanceCard } from '@/components/insights/source-performance-card'
import { ProvenanceMixCard } from '@/components/insights/provenance-mix-card'
import { useInsightsSummary } from '@/components/insights/use-insights-summary'
import {
  computeInsights,
  type AppInput,
  type ActivityInput,
  type OutreachInput,
  type FollowUpInput,
  type Insights,
} from '@/components/insights/compute'

function pct(value: number | null): string {
  return value == null ? '—' : `${value}%`
}

function days(value: number | null): StatRowItem['value'] {
  return value == null ? '—' : value
}

export default function InsightsPage() {
  const supabase = createClient()
  const [insights, setInsights] = useState<Insights | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [digestHasContent, setDigestHasContent] = useState(false)
  const jobsSummary = useInsightsSummary()

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setIsLoading(false)
      return
    }

    const [appsRes, activitiesRes, outreachJson, followUpsRes, digestRes] = await Promise.all([
      supabase
        .from('applications')
        .select('id, job_id, stage, applied_at, source, created_at, updated_at, jobs(match_score)')
        .eq('user_id', user.id),
      supabase.from('activities').select('application_id, type, occurred_at'),
      // outreach_messages is not in the generated Database type — read it through
      // the RLS-scoped API route instead of the typed client.
      fetch('/api/outreach?limit=200').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      supabase.from('follow_ups').select('due_date, is_completed'),
      fetch('/api/digest').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])

    const apps: AppInput[] = ((appsRes.data as unknown as (Omit<AppInput, 'match_score'> & {
      jobs: { match_score: number | null } | null
    })[]) ?? []).map((row) => ({
      id: row.id,
      job_id: row.job_id,
      stage: row.stage,
      applied_at: row.applied_at,
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      match_score: row.jobs?.match_score ?? null,
    }))

    const activities = (activitiesRes.data as ActivityInput[] | null) ?? []
    const outreach = ((outreachJson?.messages as OutreachInput[] | undefined) ?? []).map((m) => ({
      job_id: m.job_id,
      status: m.status,
      kind: m.kind,
      sent_at: m.sent_at,
    }))
    const followUps = (followUpsRes.data as FollowUpInput[] | null) ?? []

    setInsights(computeInsights(apps, activities, outreach, followUps))

    if (digestRes) {
      setDigestEnabled(digestRes.preferences?.enabled === true)
      setDigestHasContent(digestRes.digest ? digestRes.digest.empty === false : false)
    }
    setIsLoading(false)
  }, [supabase])

  useEffect(() => {
    load()
  }, [load])

  if (isLoading) {
    return (
      <div className="space-y-8">
        {/* sr-only real h1 so a screen reader has a page landmark to announce
            during the load — see jobs/page.tsx's JobsPageSkeleton for the
            same pattern. Without it, axe-core's page-has-heading-one rule
            (correctly) flags the loading state: the visible "Insights" h1
            below doesn't exist yet while this branch renders. */}
        <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <h1 className="sr-only">Insights — loading…</h1>
        <span className="text-caption text-muted-foreground">Loading your insights…</span>
      </div>
        <div className="space-y-2.5">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-24 w-full rounded-card" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-card" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      </div>
    )
  }

  const noData = !insights || insights.totalApplications === 0

  const rateStats: StatRowItem[] = insights
    ? [
        { label: 'Applied', value: insights.appliedCount },
        { label: 'Response rate', value: pct(insights.responseRate), hint: 'reached screen+' },
        { label: 'Interview rate', value: pct(insights.interviewRate) },
        { label: 'Offer rate', value: pct(insights.offerRate) },
      ]
    : []

  const timingStats: StatRowItem[] = insights
    ? [
        { label: 'Ghost rate', value: pct(insights.ghostRate) },
        {
          label: 'Median time to reply',
          value: days(insights.medianTimeToFirstResponse),
          hint: insights.medianTimeToFirstResponse == null ? undefined : 'days',
        },
        {
          label: 'Avg time in stage',
          value: days(insights.avgTimeInCurrentStage),
          hint: insights.avgTimeInCurrentStage == null ? undefined : 'days',
        },
        { label: 'Outreach sent', value: insights.outreachSent },
      ]
    : []

  const followUpStats: StatRowItem[] = insights
    ? [
        { label: 'Follow-ups due', value: insights.followUpsDue, href: '/contacts' },
        { label: 'Overdue', value: insights.followUpsOverdue, href: '/contacts' },
        { label: 'Outreach reply rate', value: pct(insights.outreachReplyRate) },
        { label: 'Total tracked', value: insights.totalApplications },
      ]
    : []

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-display text-foreground">Insights</h1>
          <p className="mt-1 text-body text-muted-foreground">
            What&apos;s working across your search — computed from your own pipeline, no guesswork.
          </p>
        </div>
      </div>

      {noData ? (
        <EmptyState
          icon={BarChart3}
          title="No data to analyze yet"
          body="Once you start applying and tracking activity, your funnel, response rates, and what's working will show up here."
          action={
            <Button variant="outline" asChild>
              <a href="/jobs">Browse jobs</a>
            </Button>
          }
        />
      ) : (
        <>
          <SectionTransition className="space-y-6">
            <StatRow stats={rateStats} />
            <StatRow stats={timingStats} />
            <StatRow stats={followUpStats} />
          </SectionTransition>

          <Card className="overflow-hidden p-0">
            <div className="grid divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <div className="p-5">
                <h2 className="font-display text-section text-foreground">Pipeline funnel</h2>
                <div className="mt-4">
                  <FunnelBar funnel={insights!.funnel} />
                </div>
              </div>

              <div className="space-y-6 p-5">
                <h2 className="font-display text-section text-foreground">What&apos;s working</h2>
                <WhatsWorking
                  title="By match score"
                  description="Response rate for applications, bucketed by the match score Cello assigned."
                  rows={insights!.byScoreBand}
                />
                <WhatsWorking
                  title="By source"
                  description="Which channels are converting to a first response."
                  rows={insights!.bySource}
                />
                <WhatsWorking
                  title="With vs. without outreach"
                  description="Did sending a personal note move the needle?"
                  rows={insights!.byOutreach}
                />
              </div>
            </div>
          </Card>
        </>
      )}

      {/* Job-corpus charts — independent of the application funnel above, so
          they render even before the pipeline has real volume: match quality
          and sourcing are visible from day one, not just after applying. */}
      <div className="space-y-6">
        <ScoreHistogramCard
          summary={jobsSummary.summary}
          loading={jobsSummary.loading}
          error={jobsSummary.error}
          onRetry={jobsSummary.retry}
        />
        <div className="grid gap-6 lg:grid-cols-2">
          <SourcePerformanceCard
            summary={jobsSummary.summary}
            loading={jobsSummary.loading}
            error={jobsSummary.error}
            onRetry={jobsSummary.retry}
          />
          <ProvenanceMixCard />
        </div>
      </div>

      <StrategyPanel />

      <DigestCard initialEnabled={digestEnabled} hasContent={digestHasContent} />
    </div>
  )
}
