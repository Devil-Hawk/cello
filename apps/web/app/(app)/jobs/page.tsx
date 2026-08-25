'use client'

import { LogoMark } from '@/components/brand/logo'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Briefcase, Building2, Loader2, Plus, SearchX, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useAccountStatus } from '@/hooks/use-account-status'
import {
  FacetChips,
  FRESHNESS_HOURS,
  isFreshness,
  LANGUAGE_OPTIONS,
  type FreshnessValue,
  type FunctionFacet,
  type LanguageFacet,
  type SeniorityFacet,
} from '@/components/jobs/facet-chips'
import { JobRow, type JobRowJob } from '@/components/jobs/job-row'
import { RefreshJobsButton } from '@/components/jobs/refresh-button'
import { JobDetailModal } from '@/components/jobs/job-detail-modal'
import { ProvenanceSummaryBar } from '@/components/jobs/provenance-summary-bar'
import { JOB_FUNCTIONS, QUALITY_REJECT_THRESHOLD, SENIORITY_LEVELS } from '@/lib/jobs/classify'
import { resolveTargeting, type Targeting } from '@/lib/targeting'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VisaSignal } from '@/lib/dossier/store'

const VISA_VALUES = ['all', 'likely', 'unknown', 'unlikely'] as const
type VisaFilter = (typeof VISA_VALUES)[number]
function isVisaFilter(v: string | null): v is VisaFilter {
  return v !== null && (VISA_VALUES as readonly string[]).includes(v)
}

function isJobFunctionFacet(v: string): v is FunctionFacet {
  return v === 'all' || (JOB_FUNCTIONS as readonly string[]).includes(v)
}
function isSeniorityFacet(v: string): v is SeniorityFacet {
  return v === 'all' || (SENIORITY_LEVELS as readonly string[]).includes(v)
}
function isLanguageFacet(v: string): v is LanguageFacet {
  return (LANGUAGE_OPTIONS.map((o) => o.value) as readonly string[]).includes(v)
}

interface Company {
  id: string
  name: string
  logo_url: string | null
  domain: string | null
}

interface Job extends JobRowJob {
  description: string | null
  job_type: string | null
  job_function: string | null
  seniority: string | null
  language: string | null
  country: string | null
  is_remote: boolean | null
  quality_score: number | null
}

type SortKey = 'newest' | 'best_match'

/** Response shape from POST /api/agents/match/batch — batches the whole backlog server-side. */
interface BatchMatchResult {
  scored: number
  failed: number
  /** Back-compat alias for remainingInTargeting — see the route's header. */
  remaining: number
  /** Unscored rows the scorer can ACTUALLY reach: they pass quality + targeting. */
  remainingInTargeting?: number
  /** Unscored rows targeting/quality exclude. Never scored under current filters. */
  excludedByTargeting?: number
  skippedReasons?: Record<string, number>
}

const PAGE_SIZE = 30
/** Jobs scored per click of the batch trigger — click again to keep draining the backlog. */
// The route's own default is 200 with a 500 hard cap, and bulk_matcher is built
// to triage a whole backlog in internal 60-job batches. Sending 25 meant ~451
// manual clicks to cover 11,275 rows — against a finish line that, before the
// route's remaining-count fix, did not exist. One round now does real work and
// runBatchUntilDone below keeps going until the reachable backlog is empty.
const BATCH_LIMIT = 200

/** Hard stop on the auto-continue loop. Every round spends metered LLM calls,
 *  so a runaway loop is a money bug, not just a slow one. At 200/round this
 *  still covers 4,000 jobs, far past any real in-targeting backlog. */
const MAX_BATCH_ROUNDS = 20

const JOB_SELECT_COLUMNS =
  'id, company_id, title, url, location, salary_range, posted_at, discovered_at, ' +
  'match_score, match_details, is_new, job_function, seniority, language, country, ' +
  'is_remote, quality_score, description, job_type, companies(name, logo_url, domain)'

/** Same default as lib/harness/spend.ts DEFAULT_MONTHLY_USD — duplicated (not
 *  imported) because that module is server-only (imports the AdminClient type
 *  and calls that take an admin client), while this needs to run client-side
 *  purely to read the already-fetched profiles.preferences payload. */
const DEFAULT_MONTHLY_BUDGET_USD = 10

/**
 * Plain-language "$X of your $Y monthly AI budget left" from
 * profiles.preferences.budget — the same shape lib/harness/spend.ts reads and
 * writes when it meters a real LLM call. Mirrors that module's period-reset
 * rule (a new UTC month means $0 spent so far) so this never shows a stale
 * spent total carried over from last month. Returns null (never blocks
 * anything) when preferences carries nothing usable yet.
 */
function computeBudgetHint(preferences: unknown): string | null {
  if (!preferences || typeof preferences !== 'object') return null
  const budget = (preferences as Record<string, unknown>).budget
  if (!budget || typeof budget !== 'object') return null
  const raw = budget as Record<string, unknown>

  const capUsd = typeof raw.monthlyUsd === 'number' && raw.monthlyUsd > 0 ? raw.monthlyUsd : DEFAULT_MONTHLY_BUDGET_USD

  const now = new Date()
  const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const samePeriod = raw.periodStart === currentPeriod
  const spentUsd = samePeriod && typeof raw.spentUsd === 'number' && raw.spentUsd > 0 ? raw.spentUsd : 0

  const remainingUsd = Math.max(0, capUsd - spentUsd)
  return `$${remainingUsd.toFixed(2)} of your $${capUsd.toFixed(2)} monthly AI budget left`
}

function JobsPageSkeleton() {
  return (
    <div className="space-y-6">
      {/* sr-only real h1 so a screen reader has a page landmark to announce
          during the loading window too, not just once data arrives — the
          skeleton bars below aren't real headings. */}
      <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <h1 className="sr-only">Jobs — loading…</h1>
        <span className="text-caption text-muted-foreground">Loading your jobs…</span>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="divide-y overflow-hidden rounded-card border bg-card shadow-card">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-10 w-10 rounded-control" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-8 w-28" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function JobsPage() {
  return (
    <Suspense fallback={<JobsPageSkeleton />}>
      <JobsPageInner />
    </Suspense>
  )
}

function JobsPageInner() {
  const supabase = createClient()
  // jobs.job_function/seniority/language/country/is_remote/quality_score and
  // company_dossiers aren't in the generated Database type (additive columns
  // / a table the codegen hasn't picked up), so read them through an untyped
  // view of the same cookie-scoped client — same pattern as the dossiers read
  // below used before this change.
  const untyped = supabase as unknown as SupabaseClient
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [jobs, setJobs] = useState<Job[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [companies, setCompanies] = useState<Company[]>([])
  const [companiesLoaded, setCompaniesLoaded] = useState(false)
  const [targeting, setTargeting] = useState<Targeting | null>(null)
  // Plain-language remaining monthly AI budget, e.g. "$6.20 of your $10.00
  // monthly AI budget left" — surfaced next to the "calculate match" trigger
  // because that single click fires a real, metered LLM call with no other
  // confirmation step (see match-badge.tsx's budgetHint prop). Mirrors
  // lib/harness/spend.ts's readState()/currentPeriod() logic (that module is
  // server-only — AdminClient — so the tiny period-reset check is duplicated
  // here rather than imported) against the same profiles.preferences.budget
  // shape the harness itself writes to when it meters a real call.
  const [budgetHint, setBudgetHint] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [addingToPipeline, setAddingToPipeline] = useState<string | null>(null)
  const [addedToPipeline, setAddedToPipeline] = useState<Set<string>>(new Set())
  const [calculatingMatch, setCalculatingMatch] = useState<string | null>(null)
  const [calculatingAll, setCalculatingAll] = useState(false)
  const [batchRemaining, setBatchRemaining] = useState<number | null>(null)
  // Live progress across the auto-continue rounds, and the user's Stop.
  const [batchProgress, setBatchProgress] = useState<{ scored: number; remaining: number } | null>(null)
  const stopBatchRef = useRef(false)
  // Store the id, not the row by value — deriving the object from `jobs` below
  // means a match calculated anywhere (row action, badge, batch) updates an
  // already-open modal instead of it holding a stale snapshot forever.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  // A job arrived at by deep link (?job=<id>) that is NOT on the loaded page.
  // Notifications name a specific role — "AI Engineer at Nimble Gravity scored
  // 86" — and used to link at bare /jobs, dropping the user into an unfiltered
  // list of 11,843 rows to find it by title from memory. Resolving the id needs
  // its own fetch because the row is very unlikely to be in the first page.
  const [deepLinkedJob, setDeepLinkedJob] = useState<Job | null>(null)

  // Focus restore for the job detail modal, owned HERE rather than inside the
  // modal. The modal does have an onCloseAutoFocus handler, but it can never
  // run: this page renders it as `{selectedJob && <JobDetailModal/>}`, so
  // clearing the id unmounts the whole Dialog synchronously and Radix's close
  // sequence — focus restore included — is destroyed mid-flight. Verified
  // symptom: Escape left document.activeElement on <body>, so a keyboard user
  // was dumped back to the top of a long job list every time they closed a
  // posting. Capturing the trigger where the open/close state lives sidesteps
  // the unmount race entirely.
  const jobTriggerRef = useRef<HTMLElement | null>(null)

  const closeJobModal = useCallback(() => {
    setSelectedJobId(null)
    const trigger = jobTriggerRef.current
    jobTriggerRef.current = null
    if (!trigger) return
    // After the unmount commits, and only if the row still exists (a filter or
    // refresh may have removed it) — focusing a detached node silently sends
    // focus to <body>, which is the bug we are fixing.
    requestAnimationFrame(() => {
      if (document.contains(trigger)) trigger.focus()
    })
  }, [])
  // company_id -> visa-sponsorship signal from the user's dossiers.
  const [visaByCompany, setVisaByCompany] = useState<Map<string, VisaSignal>>(new Map())

  // Single source of truth for "has a resume / has an LLM key", shared with
  // the dashboard. Retries once on failure and surfaces a real error instead
  // of silently freezing both flags at `false` forever.
  const { status: accountStatus, loading: statusLoading, error: statusError, refetch: refetchStatus } = useAccountStatus()
  const hasResume = accountStatus?.hasResume ?? false
  const hasApiKey = accountStatus?.hasKey ?? false

  // Filter + sort state lives in the URL (deep-linkable); search text stays local
  // (debounced before it drives a query, see below).
  const freshParam = searchParams.get('fresh')
  const freshness: FreshnessValue = isFreshness(freshParam) ? freshParam : 'all'
  const includeUndated = searchParams.get('undated') === '1'
  const selectedCompany = searchParams.get('company') ?? 'all'
  const sortBy: SortKey = searchParams.get('sort') === 'best_match' ? 'best_match' : 'newest'
  const visaParam = searchParams.get('visa')
  const visaFilter: VisaFilter = isVisaFilter(visaParam) ? visaParam : 'all'
  // Show-low-quality is the inverse of the default-on "hide low quality" toggle.
  const hideLowQuality = searchParams.get('showLowQuality') !== '1'
  // Only rows the scorer has not reached yet. Exists so the dashboard's
  // "Unscored 11,603" readout — by far the largest number in the product — can
  // link somewhere that actually shows those rows. It used to point at bare
  // /jobs, which opens the default recency feed and answers nothing.
  const unscoredOnly = searchParams.get('unscored') === '1'
  const deepLinkJobId = searchParams.get('job')

  // Open the job named in ?job=<id>, fetching the row directly when it is not
  // on the loaded page — which is the normal case, since a notification can
  // point at any one of ~11,800 rows and the list loads 30 at a time. Runs once
  // per id: the modal's own close clears selectedJobId, and re-opening on every
  // render would make the modal impossible to dismiss while the param is set.
  const openedDeepLinkRef = useRef<string | null>(null)
  useEffect(() => {
    if (!deepLinkJobId || openedDeepLinkRef.current === deepLinkJobId) return
    openedDeepLinkRef.current = deepLinkJobId
    setSelectedJobId(deepLinkJobId)

    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('jobs')
          .select(JOB_SELECT_COLUMNS)
          .eq('id', deepLinkJobId)
          .maybeSingle()
        if (cancelled || error || !data) return
        setDeepLinkedJob(data as unknown as Job)
      } catch {
        // Non-fatal: if the row cannot be fetched the modal simply does not
        // open, and the user still has the full list. Never blank the page.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkJobId])


  // Classification facets default to the user's configured targeting
  // (functions/seniority/countries/languages/remoteOnly) when the URL param is
  // entirely absent; once the user touches the control in the UI, the param is
  // always written (even back to "all"/false) so an explicit override sticks
  // instead of snapping back to the targeting default.
  const fnParam = searchParams.get('fn')
  const jobFunction: FunctionFacet =
    fnParam !== null
      ? isJobFunctionFacet(fnParam)
        ? fnParam
        : 'all'
      : (targeting?.functions[0] as FunctionFacet | undefined) ?? 'all'

  const srParam = searchParams.get('sr')
  const seniority: SeniorityFacet =
    srParam !== null
      ? isSeniorityFacet(srParam)
        ? srParam
        : 'all'
      : (targeting?.seniority[0] as SeniorityFacet | undefined) ?? 'all'

  const remoteParam = searchParams.get('remote')
  const remoteOnly = remoteParam !== null ? remoteParam === '1' : targeting?.remoteOnly ?? false

  const countryParam = searchParams.get('country')
  const country = countryParam !== null ? countryParam : targeting?.countries[0] ?? ''

  const langParam = searchParams.get('lang')
  const language: LanguageFacet =
    langParam !== null
      ? isLanguageFacet(langParam)
        ? langParam
        : 'all'
      : (targeting?.languages[0] as LanguageFacet | undefined) ?? 'all'

  const [locationQuery, setLocationQuery] = useState('')
  const [debouncedLocationQuery, setDebouncedLocationQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedLocationQuery(locationQuery), 350)
    return () => clearTimeout(t)
  }, [locationQuery])

  /** Delete-on-default param setter, for the pre-existing shareable filters. */
  function setParam(key: 'fresh' | 'company' | 'sort' | 'visa' | 'undated' | 'showLowQuality', value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (!value || value === 'all' || (key === 'sort' && value === 'newest')) {
      params.delete(key)
    } else {
      params.set(key, value)
    }
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  /** Always-write param setter, for facets with a targeting-derived default. */
  function setFacetParam(key: 'fn' | 'sr' | 'remote' | 'country' | 'lang', value: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  function clearFilters() {
    setLocationQuery('')
    router.replace(pathname, { scroll: false })
  }

  const companyIds = useMemo(() => companies.map((c) => c.id), [companies])
  const companyIdsKey = companyIds.join(',')

  // One-time load: companies, applications (for "in pipeline"), visa dossiers,
  // account status (resume/key presence), and targeting preferences.
  useEffect(() => {
    loadAccountData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAccountData() {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setCompaniesLoaded(true)
      setIsLoading(false)
      return
    }

    const [companiesRes, applicationsRes, dossiersRes, profileRes] = await Promise.all([
      supabase.from('companies').select('id, name, logo_url, domain').eq('user_id', user.id).order('name'),
      supabase.from('applications').select('job_id').eq('user_id', user.id),
      untyped.from('company_dossiers').select('company_id, sponsors_visa').eq('user_id', user.id),
      supabase.from('profiles').select('preferences').eq('id', user.id).maybeSingle(),
    ])

    if (companiesRes.data) setCompanies(companiesRes.data)

    if (applicationsRes.data) {
      setAddedToPipeline(new Set(applicationsRes.data.map((a) => a.job_id)))
    }

    if (dossiersRes.data) {
      const map = new Map<string, VisaSignal>()
      for (const d of dossiersRes.data as { company_id: string; sponsors_visa: VisaSignal | null }[]) {
        if (d.sponsors_visa) map.set(d.company_id, d.sponsors_visa)
      }
      setVisaByCompany(map)
    }

    setTargeting(resolveTargeting(profileRes.data?.preferences))
    setBudgetHint(computeBudgetHint(profileRes.data?.preferences))

    setCompaniesLoaded(true)
  }

  async function fetchJobsPage(pageIndex: number, append: boolean) {
    if (companyIds.length === 0) {
      setJobs([])
      setTotalCount(0)
      setIsLoading(false)
      setIsLoadingMore(false)
      return
    }

    if (append) setIsLoadingMore(true)
    else setIsLoading(true)

    let query = untyped.from('jobs').select(JOB_SELECT_COLUMNS, { count: 'exact' })

    if (selectedCompany !== 'all') {
      query = query.eq('company_id', selectedCompany)
    } else {
      query = query.in('company_id', companyIds)
    }

    if (freshness !== 'all') {
      const cutoffIso = new Date(Date.now() - FRESHNESS_HOURS[freshness] * 60 * 60 * 1000).toISOString()
      query = includeUndated
        ? query.or(`posted_at.gte.${cutoffIso},posted_at.is.null`)
        : query.gte('posted_at', cutoffIso)
    }

    if (jobFunction !== 'all') query = query.eq('job_function', jobFunction)
    if (seniority !== 'all') query = query.eq('seniority', seniority)
    if (remoteOnly) query = query.eq('is_remote', true)
    if (country.trim().length === 2) query = query.eq('country', country.trim().toUpperCase())
    if (language !== 'all') query = query.eq('language', language)
    if (hideLowQuality) {
      // NULL quality_score means "not classified yet" — never hide those,
      // only rows the classifier has actually scored below the threshold.
      query = query.or(`quality_score.gte.${QUALITY_REJECT_THRESHOLD},quality_score.is.null`)
    }
    if (debouncedLocationQuery.trim()) {
      query = query.ilike('location', `%${debouncedLocationQuery.trim()}%`)
    }
    if (unscoredOnly) query = query.is('match_score', null)

    // Sort on posted_at (never discovered_at, a single per-batch timestamp).
    // best_match puts scored jobs above unscored via nullsFirst:false instead
    // of collapsing null match_score to 0 in a client-side sort.
    if (sortBy === 'best_match') {
      query = query
        .order('match_score', { ascending: false, nullsFirst: false })
        .order('posted_at', { ascending: false, nullsFirst: false })
    } else {
      query = query.order('posted_at', { ascending: false, nullsFirst: false })
    }
    // Deterministic tiebreaker so range() pagination never skips/repeats rows.
    query = query.order('id', { ascending: true })

    const from = pageIndex * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, count, error } = await query.range(from, to)

    if (error) {
      console.error('[jobs] fetchJobsPage failed:', error)
      toast({
        title: 'Failed to load jobs',
        description: error.message || 'Something went wrong loading this page of jobs — try again.',
        variant: 'destructive',
      })
      // Deliberately leave `jobs`/`totalCount` as-is on error rather than
      // clearing them — a failed refetch shouldn't blank out a list the user
      // was already looking at.
    } else if (data) {
      const rows = data as unknown as Job[]
      setJobs((prev) => (append ? [...prev, ...rows] : rows))
      setTotalCount(count ?? 0)
      setPage(pageIndex)
    }

    if (append) setIsLoadingMore(false)
    else setIsLoading(false)
  }

  // Refetch page 0 whenever any server-side facet changes.
  useEffect(() => {
    if (!companiesLoaded) return
    fetchJobsPage(0, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    companiesLoaded,
    companyIdsKey,
    selectedCompany,
    freshness,
    includeUndated,
    jobFunction,
    seniority,
    remoteOnly,
    country,
    language,
    hideLowQuality,
    debouncedLocationQuery,
    sortBy,
    unscoredOnly,
  ])

  function loadMore() {
    fetchJobsPage(page + 1, true)
  }

  async function refreshAll() {
    refetchStatus()
    await loadAccountData()
    await fetchJobsPage(0, false)
  }

  async function addToPipeline(jobId: string) {
    setAddingToPipeline(jobId)
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setAddingToPipeline(null)
      return
    }

    const { error } = await supabase.from('applications').insert({
      user_id: user.id,
      job_id: jobId,
      stage: 'discovered',
    })

    if (!error) {
      setAddedToPipeline((prev) => new Set([...prev, jobId]))
    }
    setAddingToPipeline(null)
  }

  async function calculateMatch(jobId: string) {
    setCalculatingMatch(jobId)
    try {
      const response = await fetch('/api/agents/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
      // Read as text first — a non-JSON body (platform error page, etc.)
      // must not collapse into an opaque generic error.
      const rawText = await response.text()
      let result: { error?: string; overallScore?: number } | null = null
      try {
        result = rawText ? JSON.parse(rawText) : null
      } catch (parseErr) {
        console.error('[jobs] calculateMatch: non-JSON response', {
          status: response.status,
          body: rawText.slice(0, 500),
        })
        toast({
          title: 'Error',
          description: `Match calculation returned an unexpected response (HTTP ${response.status}).`,
          variant: 'destructive',
        })
        return
      }

      if (!response.ok || !result || result.error) {
        toast({
          title: 'Error',
          description: result?.error ?? `Failed to calculate match (HTTP ${response.status})`,
          variant: 'destructive',
        })
      } else {
        // Update local state with new score
        setJobs((prevJobs) =>
          prevJobs.map((j) =>
            j.id === jobId ? { ...j, match_score: result.overallScore ?? null, match_details: result } : j
          )
        )
        toast({
          title: 'Match calculated',
          description: `Score: ${result.overallScore}%`,
        })
      }
    } catch (error) {
      console.error('[jobs] calculateMatch failed:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? `Failed to calculate match: ${error.message}` : 'Failed to calculate match',
        variant: 'destructive',
      })
    }
    setCalculatingMatch(null)
  }

  /**
   * One round of the server-side batch scorer. Returns the parsed result so
   * runBatchUntilDone can decide whether another round is worth spending money
   * on, or null when the round failed (it has already toasted the reason).
   */
  async function runOneBatch(): Promise<BatchMatchResult | null> {
    {
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
        console.error('[jobs] calculateBatch: non-JSON response', {
          status: response.status,
          body: rawText.slice(0, 500),
        })
        toast({
          title: 'Batch scoring failed',
          description: `Unexpected response from the server (HTTP ${response.status}). Try again.`,
          variant: 'destructive',
        })
        return null
      }

      if (!response.ok || !data || typeof data.scored !== 'number') {
        const message = data?.error ?? `Batch scoring failed (HTTP ${response.status})`
        console.error('[jobs] calculateBatch failed:', message)
        toast({ title: 'Batch scoring failed', description: message, variant: 'destructive' })
        return null
      }

      setBatchRemaining(data.remaining)
      return data
    }
  }

  /**
   * Score the reachable backlog, not 200 rows of it.
   *
   * WHY A LOOP AND NOT A BUTTON YOU PRESS 451 TIMES
   *   The button used to send 25 per click against a route that accepts 500,
   *   which made clearing this account's backlog a manual exercise in the
   *   hundreds. It keeps going now until one of four things is true:
   *   the reachable backlog is empty, a round scored nothing (no progress —
   *   the guard that stops an infinite loop when the server has nothing left
   *   it can reach), the user pressed Stop, or MAX_BATCH_ROUNDS.
   *
   *   Every round spends real money, so the stop conditions are the feature.
   */
  async function calculateBatch() {
    stopBatchRef.current = false
    setCalculatingAll(true)
    setBatchProgress(null)
    let totalScored = 0
    let totalFailed = 0
    let last: BatchMatchResult | null = null

    try {
      for (let round = 0; round < MAX_BATCH_ROUNDS; round++) {
        if (stopBatchRef.current) break

        const data = await runOneBatch()
        if (!data) return // runOneBatch already explained the failure

        totalScored += data.scored
        totalFailed += data.failed
        last = data

        const reachable = data.remainingInTargeting ?? data.remaining
        setBatchProgress({ scored: totalScored, remaining: reachable })

        if (reachable === 0) break
        // No progress this round: the server could not reach anything, so
        // another round would spend money to score nothing.
        if (data.scored === 0) break
      }

      if (last) {
        const reachable = last.remainingInTargeting ?? last.remaining
        const excluded = last.excludedByTargeting ?? 0
        const parts = [
          `Scored ${totalScored}${totalFailed > 0 ? `, ${totalFailed} failed` : ''}.`,
          reachable === 0
            ? 'Everything your filters allow is now scored.'
            : `${reachable} still to score.`,
        ]
        // The number that actually explains this account: rows the scorer can
        // never reach. Reporting them as "left to score" was the original lie.
        if (excluded > 0) {
          parts.push(
            `${excluded} more are excluded by your targeting and will not be scored — widen it in Settings → Job targeting.`
          )
        }
        toast({
          title: stopBatchRef.current ? 'Scoring stopped' : 'Scoring complete',
          description: parts.join(' '),
        })
      }

      // Refresh the current page so freshly scored jobs show updated badges.
      await fetchJobsPage(0, false)
    } catch (error) {
      console.error('[jobs] calculateBatch network error:', error)
      toast({
        title: 'Batch scoring failed',
        description: error instanceof Error ? error.message : 'Network error while scoring jobs.',
        variant: 'destructive',
      })
    } finally {
      stopBatchRef.current = false
      setCalculatingAll(false)
      setBatchProgress(null)
    }
  }

  // Visa signal isn't a jobs-table column (it lives on company_dossiers), so
  // it can't be pushed into the server query alongside the other facets — it
  // still filters the currently-loaded page client-side.
  const filteredJobs = useMemo(() => {
    if (visaFilter === 'all') return jobs
    return jobs.filter((job) => visaByCompany.get(job.company_id) === visaFilter)
  }, [jobs, visaFilter, visaByCompany])

  // Single reason string drives every match/optimize affordance on this page
  // (row trigger, header batch button) — never a boolean that just makes a
  // control vanish. Checked in priority order: a failed status check is
  // itself the most actionable thing to fix first.
  const matchDisabledReason: string | null = statusError
    ? "Couldn't check your account status — retry"
    : statusLoading
      ? 'Checking your account status…'
      : !hasResume
        ? 'Upload a resume in Settings'
        : !hasApiKey
          ? // /api/settings/status distinguishes "no key at all" from "an
            // openai/anthropic key is saved but the harness only runs
            // OpenRouter" — prefer that precise copy when present.
            (accountStatus?.llmKeyMessage ?? 'Add an API key in Settings')
          : null
  const hasVisaData = visaByCompany.size > 0
  const hasActiveFilters =
    freshness !== 'all' ||
    includeUndated ||
    selectedCompany !== 'all' ||
    visaFilter !== 'all' ||
    locationQuery.trim() !== '' ||
    jobFunction !== 'all' ||
    seniority !== 'all' ||
    remoteOnly ||
    country.trim() !== '' ||
    language !== 'all' ||
    !hideLowQuality
  const canLoadMore = jobs.length < totalCount
  // Derived from the live `jobs` array (not captured by value) so a match
  // calculated from a row, its badge, or a batch run updates this modal
  // while it's open instead of leaving it showing a stale score forever.
  const selectedJob = selectedJobId
    ? (jobs.find((j) => j.id === selectedJobId) ??
       (deepLinkedJob?.id === selectedJobId ? deepLinkedJob : null))
    : null

  if (isLoading) {
    return <JobsPageSkeleton />
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-title text-foreground">Jobs</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            Open roles discovered across your tracked companies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {totalCount > 0 && (
            <Select value={sortBy} onValueChange={(v) => setParam('sort', v)}>
              <SelectTrigger className="h-9 w-36" aria-label="Sort jobs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="best_match">Best match</SelectItem>
              </SelectContent>
            </Select>
          )}
          {totalCount > 0 && hasVisaData && (
            <Select value={visaFilter} onValueChange={(v) => setParam('visa', v)}>
              <SelectTrigger className="h-9 w-36" aria-label="Filter by visa sponsorship">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sponsorship</SelectItem>
                <SelectItem value="likely">Visa likely</SelectItem>
                <SelectItem value="unknown">Visa unknown</SelectItem>
                <SelectItem value="unlikely">Visa unlikely</SelectItem>
              </SelectContent>
            </Select>
          )}
          {companies.length > 0 && (() => {
            const isBusy = calculatingAll || calculatingMatch !== null
            const isBlocked = !!matchDisabledReason
            const allScored = batchRemaining === 0
            const batchButton = (
              <Button
                variant="outline"
                onClick={() => {
                  if (!isBusy && !isBlocked) calculateBatch()
                }}
                // aria-disabled, not native `disabled`: keeps the reason
                // tooltip reachable by hover AND keyboard instead of the
                // control just going dead with no explanation.
                aria-disabled={isBusy || isBlocked}
                className={cn(isBlocked && 'cursor-not-allowed opacity-60')}
              >
                {calculatingAll ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {/* Live count across rounds, so a multi-minute run is not a
                        spinner the user has to take on faith. */}
                    {batchProgress
                      ? `Scored ${batchProgress.scored} · ${batchProgress.remaining} left`
                      : 'Scoring…'}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    {allScored ? 'All jobs scored' : 'Score unscored jobs'}
                  </>
                )}
              </Button>
            )
            // A run that keeps going until the backlog is clear needs a way
            // out that is not closing the tab: every round spends real money.
            if (calculatingAll) {
              return (
                <div className="flex items-center gap-2">
                  {batchButton}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      stopBatchRef.current = true
                    }}
                  >
                    Stop
                  </Button>
                </div>
              )
            }
            // Enabled + work left to do: this click can fire up to
            // BATCH_LIMIT real, metered LLM calls in one go — the biggest
            // single spend exposed on this page — so it's worth a budget
            // hint even though nothing is blocking the click.
            if (!isBlocked && !allScored) {
              if (!budgetHint) return batchButton
              return (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>{batchButton}</TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs p-3">
                      <p className="text-caption text-muted-foreground">
                        Keeps scoring until everything your filters allow is
                        done — {BATCH_LIMIT} at a time, one metered AI call per
                        job. You can stop it at any point. {budgetHint}.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            }
            return (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>{batchButton}</TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs p-3">
                    <div className="space-y-2">
                      <p className="text-caption">
                        {matchDisabledReason ?? 'No unscored jobs left in your backlog — nice work.'}
                      </p>
                      {statusError && (
                        <Button size="sm" variant="outline" onClick={refetchStatus}>
                          Retry
                        </Button>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )
          })()}
          {companies.length > 0 && <RefreshJobsButton onRefreshed={refreshAll} />}
        </div>
      </div>

      {totalCount > 0 && <ProvenanceSummaryBar />}

      {companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Track your first company"
          body="Add the companies you care about and their open roles will show up here automatically."
          action={
            <Button asChild>
              <Link href="/companies">
                <Plus className="h-4 w-4" />
                Add companies
              </Link>
            </Button>
          }
        />
      ) : totalCount === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No jobs discovered yet"
          body={`Cello checks your ${companies.length} ${
            companies.length === 1 ? 'company' : 'companies'
          } hourly — or refresh now to fetch open roles.`}
          action={<RefreshJobsButton onRefreshed={refreshAll} />}
        />
      ) : (
        <>
          <FacetChips
            freshness={freshness}
            onFreshnessChange={(v) => setParam('fresh', v)}
            includeUndated={includeUndated}
            onIncludeUndatedChange={(v) => setParam('undated', v ? '1' : '')}
            companies={companies}
            selectedCompany={selectedCompany}
            onCompanyChange={(id) => setParam('company', id)}
            locationQuery={locationQuery}
            onLocationQueryChange={setLocationQuery}
            jobFunction={jobFunction}
            onJobFunctionChange={(v) => setFacetParam('fn', v)}
            seniority={seniority}
            onSeniorityChange={(v) => setFacetParam('sr', v)}
            remoteOnly={remoteOnly}
            onRemoteOnlyChange={(v) => setFacetParam('remote', v ? '1' : '0')}
            country={country}
            onCountryChange={(v) => setFacetParam('country', v)}
            language={language}
            onLanguageChange={(v) => setFacetParam('lang', v)}
            hideLowQuality={hideLowQuality}
            onHideLowQualityChange={(v) => setParam('showLowQuality', v ? '' : '1')}
            shown={filteredJobs.length}
            total={totalCount}
          />

          {filteredJobs.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="No jobs match these filters"
              body={
                hasActiveFilters
                  ? 'Try widening the freshness window or clearing your filters.'
                  : 'Nothing to show right now.'
              }
              action={
                hasActiveFilters ? (
                  <Button variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="divide-y overflow-hidden rounded-card border bg-card shadow-card">
                {filteredJobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    inPipeline={addedToPipeline.has(job.id)}
                    isAdding={addingToPipeline === job.id}
                    isCalculating={calculatingMatch === job.id}
                    calculateDisabled={calculatingAll}
                    calculateDisabledReason={matchDisabledReason}
                    onRetryStatus={refetchStatus}
                    visaSignal={visaByCompany.get(job.company_id) ?? null}
                    budgetHint={budgetHint}
                    onOpen={() => {
                      // Remember what the user activated, so closing can put
                      // focus back on it. See closeJobModal.
                      jobTriggerRef.current =
                        document.activeElement instanceof HTMLElement ? document.activeElement : null
                      setSelectedJobId(job.id)
                    }}
                    onAddToPipeline={() => addToPipeline(job.id)}
                    onCalculateMatch={() => calculateMatch(job.id)}
                  />
                ))}
              </div>

              {canLoadMore && (
                <div className="flex flex-col items-center gap-2 py-2">
                  <p className="font-readout text-caption tabular-nums text-muted-foreground">
                    Showing {jobs.length} of {totalCount}
                  </p>
                  <Button variant="outline" onClick={loadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      'Load more'
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Job Detail Modal */}
      {selectedJob && (
        <JobDetailModal
          job={selectedJob}
          onClose={closeJobModal}
          hasResume={hasResume}
          hasApiKey={hasApiKey}
          apiKeyMessage={accountStatus?.llmKeyMessage}
          statusError={statusError}
          onRetryStatus={refetchStatus}
        />
      )}
    </div>
  )
}
