'use client'

import { LogoMark } from '@/components/brand/logo'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { useAccountStatus } from '@/hooks/use-account-status'
import { PulseRibbon } from '@/components/dashboard/pulse-ribbon'
import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist'
import { GmailSyncCard } from '@/components/dashboard/gmail-sync-card'
import { PipelineSnapshot, type FollowUpSummary } from '@/components/dashboard/pipeline-snapshot'
import { AgentActivityCard, type LatestAgentRun } from '@/components/dashboard/agent-activity-card'
import {
  RecentCompaniesList,
  type RecentCompany,
} from '@/components/dashboard/recent-companies-list'
import { BudgetMeterCard, type BudgetSummary } from '@/components/dashboard/budget-meter-card'
import type { PipelineStage } from '@/lib/format'

interface Stats {
  companiesCount: number
  jobsPosted24h: number
  unscoredCount: number
  applicationsCount: number
  inPipelineCount: number
  stageCounts: Partial<Record<PipelineStage, number>>
}

// Applications still "alive" — everything except the two terminal stages.
const ACTIVE_STAGES = new Set<string>(['discovered', 'applied', 'screen', 'interview', 'offer'])

/** Response shape from POST /api/agents/match/batch — see app/(app)/jobs/page.tsx for the same contract. */
interface BatchMatchResult {
  scored: number
  failed: number
  remaining: number
  skippedReasons?: Record<string, number>
}

const BATCH_LIMIT = 25

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
      <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <h1 className="sr-only">Dashboard — loading…</h1>
        <span className="text-caption text-muted-foreground">Loading your dashboard…</span>
      </div>
      <div className="overflow-hidden rounded-card border bg-card shadow-card">
        <div className="flex items-end justify-between gap-4 px-6 py-5">
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-6 w-72 max-w-full" />
          </div>
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="grid grid-cols-2 border-t sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2.5 border-r px-6 py-4 last:border-r-0">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-12" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-control" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const supabase = createClient()
  const [stats, setStats] = useState<Stats>({
    companiesCount: 0,
    jobsPosted24h: 0,
    unscoredCount: 0,
    applicationsCount: 0,
    inPipelineCount: 0,
    stageCounts: {},
  })
  const [followUps, setFollowUps] = useState<FollowUpSummary>({ overdueCount: 0, upcomingCount: 0 })
  const [latestRun, setLatestRun] = useState<LatestAgentRun | null>(null)
  const [recentCompanies, setRecentCompanies] = useState<RecentCompany[]>([])
  const [lastScrapedAt, setLastScrapedAt] = useState<string | null>(null)
  const [lastGmailSyncAt, setLastGmailSyncAt] = useState<string | null>(null)
  const [budget, setBudget] = useState<BudgetSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [userName, setUserName] = useState<string | null>(null)
  const [calculatingBatch, setCalculatingBatch] = useState(false)

  // Single source of truth for "is this account set up yet?" — shared with
  // the jobs page. Fixes the dashboard always claiming no API key was saved
  // (profiles.api_keys does not exist as a column) AND retries once instead
  // of silently freezing at "false" on a flaky request.
  const {
    status: accountStatus,
    loading: statusLoading,
    error: statusError,
    refetch: refetchStatus,
  } = useAccountStatus()
  const hasResume = accountStatus?.hasResume ?? false
  const hasApiKey = accountStatus?.hasKey ?? false
  const matchDisabledReason: string | null = statusError
    ? "Couldn't check your account status — retry"
    : statusLoading
      ? 'Checking your account status…'
      : !hasResume
        ? 'Upload a resume in Settings'
        : !hasApiKey
          ? (accountStatus?.llmKeyMessage ?? 'Add an API key in Settings')
          : null

  useEffect(() => {
    fetchDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchDashboardData() {
    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser()
      if (error || !user) {
        console.error('Auth error:', error)
        setIsLoading(false)
        return
      }

      setUserName(user.user_metadata?.full_name || user.user_metadata?.name || null)

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      // agent_runs isn't in the generated Database type (it's a harness table
      // queried through the service-role admin client server-side only), so
      // fetch it through the same JSON route the /agent page uses rather than
      // a directly-typed Supabase query.
      const latestRunPromise = fetch('/api/harness/run?limit=1')
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)

      const [
        companiesCountRes,
        recentRes,
        lastScrapedRes,
        jobsPosted24hRes,
        unscoredRes,
        applicationsRes,
        followUpsRes,
        runJson,
        profileRes,
      ] = await Promise.all([
        supabase.from('companies').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase
          .from('companies')
          .select('id, name, logo_url, domain, career_url, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('companies')
          .select('last_scraped_at')
          .eq('user_id', user.id)
          .not('last_scraped_at', 'is', null)
          .order('last_scraped_at', { ascending: false })
          .limit(1),
        // RLS restricts jobs to rows whose company belongs to this user — no
        // manual company_id join needed. posted_at, NOT discovered_at: the
        // scraper stamps discovered_at with one `now` for the whole batch, so
        // filtering on it makes "24h" match everything.
        supabase
          .from('jobs')
          .select('*', { count: 'exact', head: true })
          .gte('posted_at', dayAgo),
        supabase.from('jobs').select('*', { count: 'exact', head: true }).is('match_score', null),
        supabase.from('applications').select('id, stage').eq('user_id', user.id),
        supabase
          .from('follow_ups')
          .select('id, due_date, is_completed')
          .eq('is_completed', false),
        latestRunPromise,
        supabase.from('profiles').select('preferences').eq('id', user.id).maybeSingle(),
      ])

      const applications = applicationsRes.data || []
      const stageCounts: Partial<Record<PipelineStage, number>> = {}
      let inPipelineCount = 0
      for (const app of applications) {
        const stage = app.stage as PipelineStage
        stageCounts[stage] = (stageCounts[stage] || 0) + 1
        if (ACTIVE_STAGES.has(stage)) inPipelineCount += 1
      }

      const now = Date.now()
      let overdueCount = 0
      let upcomingCount = 0
      for (const fu of followUpsRes.data || []) {
        if (new Date(fu.due_date).getTime() < now) overdueCount += 1
        else upcomingCount += 1
      }

      const runRow = runJson?.runs?.[0] as
        | {
            id: string
            goal: string
            status: string
            created_at: string
            finished_at: string | null
            error: string | null
          }
        | undefined
      setLatestRun(
        runRow
          ? {
              id: runRow.id,
              goal: runRow.goal,
              status: runRow.status as LatestAgentRun['status'],
              createdAt: runRow.created_at,
              finishedAt: runRow.finished_at,
              error: runRow.error,
            }
          : null
      )

      const preferences = (profileRes.data?.preferences || {}) as Record<string, unknown>
      const gmailSync = (preferences.gmail_sync || {}) as { lastSyncDate?: string }
      setLastGmailSyncAt(gmailSync.lastSyncDate ?? null)

      const rawBudget = preferences.budget as
        | { spentUsd?: unknown; monthlyUsd?: unknown; periodStart?: unknown }
        | undefined
      setBudget(
        rawBudget && typeof rawBudget.spentUsd === 'number' && typeof rawBudget.monthlyUsd === 'number'
          ? {
              spentUsd: rawBudget.spentUsd,
              monthlyUsd: rawBudget.monthlyUsd,
              periodStart: typeof rawBudget.periodStart === 'string' ? rawBudget.periodStart : '',
            }
          : null
      )

      setStats({
        companiesCount: companiesCountRes.count || 0,
        jobsPosted24h: jobsPosted24hRes.count || 0,
        unscoredCount: unscoredRes.count || 0,
        applicationsCount: applications.length,
        inPipelineCount,
        stageCounts,
      })
      setFollowUps({ overdueCount, upcomingCount })
      setRecentCompanies(recentRes.data || [])
      setLastScrapedAt(lastScrapedRes.data?.[0]?.last_scraped_at ?? null)
      setIsLoading(false)
    } catch (error) {
      console.error('Dashboard fetch error:', error)
      setIsLoading(false)
    }
  }

  /**
   * Same server batch scorer the jobs page drives (POST /api/agents/match/batch)
   * — the dashboard's "Unscored" tile used to be a plain link to /jobs that
   * scored nothing on its own. Safe to click repeatedly; each call reports
   * how many are left so the count can keep draining.
   */
  async function calculateBatch() {
    setCalculatingBatch(true)
    try {
      const response = await fetch('/api/agents/match/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: BATCH_LIMIT }),
      })
      const rawText = await response.text()
      let data: (BatchMatchResult & { error?: string }) | null = null
      try {
        data = rawText ? JSON.parse(rawText) : null
      } catch (parseErr) {
        console.error('[dashboard] calculateBatch: non-JSON response', {
          status: response.status,
          body: rawText.slice(0, 500),
        })
        toast({
          title: 'Batch scoring failed',
          description: `Unexpected response from the server (HTTP ${response.status}). Try again.`,
          variant: 'destructive',
        })
        return
      }

      if (!response.ok || !data || typeof data.scored !== 'number') {
        const message = data?.error ?? `Batch scoring failed (HTTP ${response.status})`
        console.error('[dashboard] calculateBatch failed:', message)
        toast({ title: 'Batch scoring failed', description: message, variant: 'destructive' })
        return
      }

      const skippedSummary = data.skippedReasons
        ? Object.entries(data.skippedReasons)
            .map(([reason, count]) => `${count} ${reason}`)
            .join(', ')
        : null

      toast({
        title: 'Batch scoring complete',
        description:
          `Scored ${data.scored}, ${data.failed} failed, ${data.remaining} left to score.` +
          (skippedSummary ? ` Skipped — ${skippedSummary}.` : ''),
      })

      // Refresh the unscored count (and everything else) so the tile reflects it.
      await fetchDashboardData()
    } catch (error) {
      console.error('[dashboard] calculateBatch network error:', error)
      toast({
        title: 'Batch scoring failed',
        description: error instanceof Error ? error.message : 'Network error while scoring jobs.',
        variant: 'destructive',
      })
    } finally {
      setCalculatingBatch(false)
    }
  }

  if (isLoading || statusLoading) {
    return <DashboardSkeleton />
  }

  return (
    <div className="space-y-8">
      <PulseRibbon
        userName={userName}
        companiesCount={stats.companiesCount}
        jobsPosted24h={stats.jobsPosted24h}
        unscoredCount={stats.unscoredCount}
        inPipelineCount={stats.inPipelineCount}
        lastScrapedAt={lastScrapedAt}
        onCalculateBatch={calculateBatch}
        isCalculatingBatch={calculatingBatch}
        calculateDisabledReason={matchDisabledReason}
        onRetryStatus={refetchStatus}
      />

      <OnboardingChecklist
        hasCompany={stats.companiesCount > 0}
        hasResume={hasResume}
        hasApiKey={hasApiKey}
      />

      {/*
        Two columns, both carrying real weight.

        This was a 2/3 column holding one card beside a 1/3 rail holding four,
        under `items-start` so the short side never stretched — which left
        roughly 450px of dead background under the Pipeline card while the rail
        ran on past it. The fix is not to stretch the gap but to fill it: the
        agent's state and what it is spending are the same subject as the
        pipeline (what is happening to my search, and what is it costing), so
        they belong in the primary column with it. The rail keeps the two
        genuine side-references — a company list and an optional integration.
      */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <PipelineSnapshot
            applicationsCount={stats.applicationsCount}
            stageCounts={stats.stageCounts}
            followUps={followUps}
          />
          {/* Side by side from `sm` up: neither of these needs full width, and
              pairing them stops the primary column ending in a ragged stack. */}
          <div className="grid gap-6 sm:grid-cols-2">
            <AgentActivityCard run={latestRun} />
            <BudgetMeterCard
              budget={budget}
              // Patch the cap in place rather than refetching the whole
              // dashboard for one number the card already knows.
              onBudgetChange={(monthlyUsd) =>
                setBudget((b) => (b ? { ...b, monthlyUsd } : b))
              }
            />
          </div>
        </div>
        <div className="space-y-6">
          <RecentCompaniesList companies={recentCompanies} />
          {/* Optional utility, not a core widget — placed last in the secondary
              column so it doesn't compete with the primary pipeline view. Cello
              tracks applications without it; see the card's own description for
              the actual monitoring mechanism. */}
          <GmailSyncCard onSynced={fetchDashboardData} lastSyncedAt={lastGmailSyncAt} />
        </div>
      </div>
    </div>
  )
}
