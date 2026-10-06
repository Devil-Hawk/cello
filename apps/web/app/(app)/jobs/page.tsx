'use client'

import { LogoMark } from '@/components/brand/logo'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Briefcase, Building2, Loader2, Plus, SearchX, Target, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
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
import { fetchClientSafePreferences } from '@/lib/preferences/client-safe'
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
import { FIT_COLUMNS, FIT_EMBED, chanceLabel, fitToColumns, type FitRow } from '@/lib/scoring/read'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import type { RoleFit } from '@/lib/scoring/types'
import { ProvenanceSummaryBar } from '@/components/jobs/provenance-summary-bar'
import { JOB_FUNCTIONS, QUALITY_REJECT_THRESHOLD, SENIORITY_LEVELS } from '@/lib/jobs/classify'
import { resolveTargeting, type Targeting } from '@/lib/targeting'
import {
  MAX_TARGET_TITLES,
  normalizeTargetTitle,
  parseTargetTitlesParam,
  resolveTargetTitles,
  serializeTargetTitlesParam,
} from '@/lib/targeting/titles'
import { rankJobsByTargetTitles, type TitleMatch } from '@/lib/matching/title-rank'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VisaSignal } from '@/lib/dossier/store'
import { isTrackedCompany } from '@/lib/companies/watchlist'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { applyRoleTargets, excludedCompanyIds, hasRoleTargets } from '@/lib/targeting/roles'
import { TargetScopeSwitch, type TargetScope } from '@/components/jobs/target-scope-switch'

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
  metadata?: unknown
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
  /** Unassessed roles that are worth assessing: they pass quality and the function and level asked for. */
  remainingInTargeting?: number
  /** Unassessed roles outside the function and level asked for. Never assessed under current filters. */
  excludedByTargeting?: number
  skippedReasons?: Record<string, number>
}

const PAGE_SIZE = 30
/** Roles checked per click of the batch trigger; click again to keep draining the backlog. */
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

// The posting's own columns. The person's verdict on it is not one of them: it lives
// on their person_roles row. A list starts at that row (so it can be ordered by what
// the person wants) and embeds the posting; a single role starts at the posting and
// embeds the row.
const JOB_COLUMNS =
  'id, company_id, title, url, location, salary_range, posted_at, discovered_at, ' +
  'is_new, job_function, seniority, language, country, ' +
  'is_remote, quality_score, description, job_type, companies(name, logo_url, domain)'
const JOB_SELECT_COLUMNS = JOB_COLUMNS + ', ' + FIT_EMBED
const LIST_SELECT_COLUMNS = FIT_COLUMNS + ', jobs!inner(' + JOB_COLUMNS + ')'

/** A person_roles list row, as LIST_SELECT_COLUMNS returns it: the verdict columns beside the embedded posting. */
type ListRow = { jobs: Job | Job[] | null } & Record<string, unknown>

/** The posting with the person's verdict embedded, the shape every job component reads. */
function toJob(row: ListRow): Job | null {
  const { jobs, ...verdict } = row
  const job = Array.isArray(jobs) ? jobs[0] : jobs
  return job ? { ...job, person_roles: verdict as FitRow } : null
}

/**
 * Plain-language "$X of your $Y monthly AI budget left", from the same route the
 * dashboard meter reads (GET /api/settings/budget, which sums the spend ledger).
 * Money held for calls still in flight counts as spent, so the hint never
 * promises more than a batch can use. Returns null (never blocks anything) when
 * the budget cannot be read.
 */
async function loadBudgetHint(): Promise<string | null> {
  try {
    const res = await fetch('/api/settings/budget')
    if (!res.ok) return null
    const { budget } = (await res.json()) as { budget?: { monthlyUsd?: number; spentUsd?: number; heldUsd?: number } }
    if (typeof budget?.monthlyUsd !== 'number' || typeof budget.spentUsd !== 'number') return null
    const remainingUsd = Math.max(0, budget.monthlyUsd - budget.spentUsd - (budget.heldUsd ?? 0))
    return `$${remainingUsd.toFixed(2)} of your $${budget.monthlyUsd.toFixed(2)} monthly AI budget left`
  } catch {
    return null
  }
}

/**
 * The titles the user is looking for, as an add/remove chip list.
 *
 * WHY THE DRAFT NEVER TOUCHES THE URL
 *   This is the same trap the country input fell into (see committedCountry
 *   below): writing per-keystroke to a searchParams-derived value makes every
 *   character a router.replace that races the next one. Here the draft is
 *   plain local state and only a COMPLETED title — Enter, or the + button —
 *   is committed. Nothing re-ranks while you are still typing the word.
 */
function TargetTitlesBar({
  titles,
  onChange,
  sortLabel,
  matchedCount,
  rankedCount,
}: {
  titles: string[]
  onChange: (next: string[]) => void
  sortLabel: string
  matchedCount: number
  rankedCount: number
}) {
  const [draft, setDraft] = useState('')
  const atCap = titles.length >= MAX_TARGET_TITLES

  function commit() {
    const title = normalizeTargetTitle(draft)
    if (!title || atCap) return
    // De-dupe case-insensitively so "data scientist" can't shadow the "Data
    // Scientist" chip already sitting right there.
    if (!titles.some((t) => t.toLowerCase() === title.toLowerCase())) onChange([...titles, title])
    setDraft('')
  }

  return (
    <div className="rounded-card border bg-card px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="flex items-center gap-2 text-caption font-medium text-foreground">
          <Target className="h-4 w-4 text-muted-foreground" aria-hidden />
          Target titles
        </h2>
        <p className="text-caption text-muted-foreground">
          {titles.length === 0 ? (
            <>Add the roles you actually want and this list gets ranked by them.</>
          ) : (
            <>
              {/* Say exactly what was reordered and what it was reordered
                  within. Ranking runs over the rows loaded here, not all
                  {totalCount} — claiming otherwise would be the same kind of
                  lie as the old "remaining to score" count. */}
              <span className="font-readout tabular-nums">{matchedCount}</span> of{' '}
              <span className="font-readout tabular-nums">{rankedCount}</span> loaded jobs match — ranked first, then{' '}
              {sortLabel.toLowerCase()}.
            </>
          )}
        </p>
      </div>

      <div className="mt-2.5 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          disabled={atCap}
          placeholder={atCap ? `${MAX_TARGET_TITLES} titles is the limit` : 'Senior Data Scientist'}
          aria-label="Add a target job title"
          className="h-9 max-w-xs"
        />
        <Button type="button" variant="outline" size="icon" onClick={commit} disabled={atCap} aria-label="Add target title">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {titles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {titles.map((title) => (
            <span
              key={title}
              className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium text-accent-deep"
            >
              {title}
              <button
                type="button"
                onClick={() => onChange(titles.filter((t) => t !== title))}
                aria-label={`Remove target title ${title}`}
                className="opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Why this job sits where it does — the target title it matched, and how well.
 *
 * A re-ordered list with no visible reason is indistinguishable from a shuffle,
 * so every row the ranking MOVED says so on the row itself. Accent is the
 * product's one "live" signal colour and this is a live, user-driven signal, so
 * it earns it; rows that matched nothing render nothing and stay quiet.
 */
function TitleMatchReason({ match }: { match: TitleMatch }) {
  if (!match.target) return null
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-2.5 text-caption text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent-deep">
        <Target className="h-3 w-3" aria-hidden />
        {match.target}
      </span>
      <span className="font-readout tabular-nums">{match.score}% title match</span>
    </p>
  )
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

type JobsQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>

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
  // Roles inside the person's targets / all open roles, under the current facets (the switch's two counts).
  const [matchingCount, setMatchingCount] = useState(0)
  const [allCount, setAllCount] = useState(0)
  const [page, setPage] = useState(0)
  const [companies, setCompanies] = useState<Company[]>([])
  const [companiesLoaded, setCompaniesLoaded] = useState(false)
  const [targeting, setTargeting] = useState<Targeting | null>(null)
  // The titles the user wants, as stored in profiles.preferences.targeting.
  // Kept separate from `targeting` on purpose: titles RANK the list, they never
  // filter it, so they are not a Targeting facet — see lib/targeting/titles.ts.
  const [profileTargetTitles, setProfileTargetTitles] = useState<string[]>([])
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
  // Only rows that have not been assessed yet. Exists so the dashboard's
  // "Not assessed yet 11,603" readout, by far the largest number in the product, can
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


  // Classification facets start at "all". What the person targeted (Settings ->
  // Targeting) is carried by the "Matching your targets" switch below, which
  // takes every target at once; these facets only narrow further. (They used to
  // default to the FIRST target of each kind, so data + engineering showed
  // engineering only.) Once the user touches a control the param is always
  // written, so an explicit "all" sticks.
  const fnParam = searchParams.get('fn')
  const jobFunction: FunctionFacet = fnParam !== null && isJobFunctionFacet(fnParam) ? fnParam : 'all'

  const srParam = searchParams.get('sr')
  const seniority: SeniorityFacet = srParam !== null && isSeniorityFacet(srParam) ? srParam : 'all'

  const remoteOnly = searchParams.get('remote') === '1'

  const country = searchParams.get('country') ?? ''

  const langParam = searchParams.get('lang')
  const language: LanguageFacet = langParam !== null && isLanguageFacet(langParam) ? langParam : 'all'

  // The switch: with role targets set, roles inside them show by default and
  // ?scope=all shows everything. No targets, no switch, everything shows.
  const roleTargets = targeting !== null && hasRoleTargets(targeting)
  const scope: TargetScope = roleTargets && searchParams.get('scope') !== 'all' ? 'matching' : 'all'

  // Target titles follow the same override convention as the facets above: the
  // URL wins when the param is present (deep-linkable, and an empty string is a
  // real "I cleared them here" answer), otherwise fall back to what the user
  // configured. Unlike those facets this drives NO server predicate — it never
  // appears in fetchJobsPage — so changing it re-ranks without a refetch.
  const titlesParam = searchParams.get('titles')
  const targetTitles = useMemo(
    () => (titlesParam !== null ? parseTargetTitlesParam(titlesParam) : profileTargetTitles),
    [titlesParam, profileTargetTitles]
  )

  const [locationQuery, setLocationQuery] = useState('')
  const [debouncedLocationQuery, setDebouncedLocationQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedLocationQuery(locationQuery), 350)
    return () => clearTimeout(t)
  }, [locationQuery])

  // COUNTRY IS TYPED LOCALLY AND COMMITTED WHEN IT IS COMPLETE.
  //   It used to write straight to the URL on every keystroke via
  //   setFacetParam. Because `country` is *derived* from searchParams and feeds
  //   fetchJobsPage's dependencies, each character triggered a router.replace
  //   plus a refetch — and the navigation round-trip raced the next keystroke.
  //   Typing "US" measurably ended with the input holding "U" and the URL at
  //   ?country=U: the second character was swallowed, and a lone "U" filters
  //   nothing (the query below requires exactly 2 letters), so the search
  //   silently reset to unfiltered.
  const [countryInput, setCountryInput] = useState(country)
  /** The last value THIS input pushed to the URL, so the sync effect below can
   *  tell "the URL changed because of me" from "the URL changed elsewhere". */
  const committedCountry = useRef(country)

  useEffect(() => {
    // Adopt a country that changed outside this input — Clear filters, a
    // targeting default, browser back/forward — but never re-seed with a value
    // this input just wrote, which would fight the user mid-word.
    if (country !== committedCountry.current) {
      committedCountry.current = country
      setCountryInput(country)
    }
  }, [country])

  useEffect(() => {
    const trimmed = countryInput.trim()
    // Only ever commit something the query can act on: empty (no filter) or a
    // complete 2-letter code. A half-typed "U" would cost a refetch that
    // changes no rows and leave a partial code stuck in the address bar.
    if (trimmed.length !== 0 && trimmed.length !== 2) return
    if (trimmed === country.trim()) return
    const t = setTimeout(() => {
      committedCountry.current = trimmed
      setFacetParam('country', trimmed)
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryInput, country])

  /** Delete-on-default param setter, for the pre-existing shareable filters. */
  function setParam(
    key: 'fresh' | 'company' | 'sort' | 'visa' | 'undated' | 'showLowQuality' | 'scope',
    value: string
  ) {
    const params = new URLSearchParams(searchParams.toString())
    // scope=all is the explicit value (absent means matching targets), so it is kept.
    if (!value || (value === 'all' && key !== 'scope') || (key === 'sort' && value === 'newest')) {
      params.delete(key)
    } else {
      params.set(key, value)
    }
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  /** Always-write param setter, for facets with a targeting-derived default. */
  function setFacetParam(key: 'fn' | 'sr' | 'remote' | 'country' | 'lang' | 'titles', value: string) {
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
  // The watchlist is what the person added: sourcer leads stay out of the counts and the company filter.
  const trackedCompanies = useMemo(() => companies.filter(isTrackedCompany), [companies])
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

    const [companiesRes, applicationsRes, dossiersRes, safePrefs] = await Promise.all([
      supabase.from('companies').select('id, name, logo_url, domain, metadata').eq('user_id', user.id).order('name'),
      supabase.from('applications').select('job_id').eq('user_id', user.id),
      untyped.from('company_dossiers').select('company_id, sponsors_visa').eq('user_id', user.id),
      // Never supabase.from('profiles').select('preferences') here: that returns
      // the whole column (api_keys ciphertext, tokens) into browser memory for
      // the targeting and budget fields this page needs. See
      // lib/preferences/client-safe.ts.
      fetchClientSafePreferences(untyped),
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

    setTargeting(resolveTargeting(safePrefs))
    setProfileTargetTitles(resolveTargetTitles(safePrefs))
    void loadBudgetHint().then(setBudgetHint)

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

    // Every facet the person set. Applied to the page query and to the count of
    // the other side of the switch, so both counts follow the same facets.
    // Open roles only: posted in the last 180 days (or undated) and not closed.
    const excludedIds = targeting ? excludedCompanyIds(companies, targeting) : []
    // The list starts at the person's own rows (person_roles) so it can be ordered by
    // what they want; the posting's columns are filtered through the embed (OnJobs).
    // A role they said is not for them stays out of the list.
    const withFacets = (query: JobsQuery, side: TargetScope): JobsQuery => {
      query.is('hidden_reason', null)
      const start = new OnJobs(query)
      openRolesOnly(start)

      if (selectedCompany !== 'all') {
        start.eq('company_id', selectedCompany)
      }
      // No 'all companies' filter: RLS already scopes every row to the person's own
      // person_roles rows. The old .in('company_id', companyIds) re-sent every
      // company id in the querystring, which passed the gateway's URL limit until
      // the account grew past ~600 companies and then failed every load with a bare
      // 400. The empty-companies early return above keeps the zero-companies UX
      // identical.

      if (freshness !== 'all') {
        const cutoffIso = new Date(Date.now() - FRESHNESS_HOURS[freshness] * 60 * 60 * 1000).toISOString()
        if (includeUndated) start.or('posted_at.gte.' + cutoffIso + ',posted_at.is.null')
        else start.gte('posted_at', cutoffIso)
      }

      if (jobFunction !== 'all') start.eq('job_function', jobFunction)
      if (seniority !== 'all') start.eq('seniority', seniority)
      if (remoteOnly) start.eq('is_remote', true)
      if (country.trim().length === 2) start.eq('country', country.trim().toUpperCase())
      if (language !== 'all') start.eq('language', language)
      if (hideLowQuality) {
        // NULL quality_score means "not classified yet" — never hide those,
        // only rows the classifier has actually scored below the threshold.
        start.or('quality_score.gte.' + QUALITY_REJECT_THRESHOLD + ',quality_score.is.null')
      }
      if (debouncedLocationQuery.trim()) {
        start.ilike('location', '%' + debouncedLocationQuery.trim() + '%')
      }
      if (unscoredOnly) query.is('assessed_at', null)
      if (side === 'matching' && targeting) applyRoleTargets(start, targeting, excludedIds)
      return start.query
    }

    let query = withFacets(untyped.from('person_roles').select(LIST_SELECT_COLUMNS, { count: 'exact' }), scope)

    // Sort on posted_at (never discovered_at, a single per-batch timestamp).
    // best_match puts the roles the person is likely to want above unassessed ones via
    // nullsFirst:false, instead of collapsing a missing want to 0 in a client-side sort.
    if (sortBy === 'best_match') {
      query = query
        .order('want_p', { ascending: false, nullsFirst: false })
        .order('jobs(posted_at)', { ascending: false, nullsFirst: false })
    } else {
      query = query.order('jobs(posted_at)', { ascending: false, nullsFirst: false })
    }
    // Deterministic tiebreaker so range() pagination never skips/repeats rows.
    query = query.order('job_id', { ascending: true })

    const from = pageIndex * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    // The other side of the switch, counted under the same facets. Without
    // role targets there is no switch and both counts are the one count.
    const otherSide: TargetScope = scope === 'matching' ? 'all' : 'matching'
    const [{ data, count, error }, other] = await Promise.all([
      query.range(from, to),
      roleTargets
        ? withFacets(untyped.from('person_roles').select('job_id, jobs!inner(id)', { count: 'exact', head: true }), otherSide)
        : Promise.resolve(null),
    ])

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
      const rows = (data as unknown as ListRow[]).map(toJob).filter((j): j is Job => j !== null)
      setJobs((prev) => (append ? [...prev, ...rows] : rows))
      setTotalCount(count ?? 0)
      const here = count ?? 0
      const there = other && !other.error ? (other.count ?? 0) : here
      setMatchingCount(scope === 'matching' ? here : there)
      setAllCount(scope === 'matching' ? there : here)
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
    scope,
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
      const response = await fetch(`/api/roles/${jobId}/fit`, { method: 'POST' })
      // Read as text first: a non-JSON body (platform error page, etc.) must not
      // collapse into an opaque generic error.
      const rawText = await response.text()
      let result: (RoleFit & { error?: string }) | null = null
      try {
        result = rawText ? JSON.parse(rawText) : null
      } catch {
        console.error('[jobs] calculateMatch: non-JSON response', { status: response.status, body: rawText.slice(0, 500) })
        toast({
          title: 'Error',
          description: `Checking this role returned an unexpected response (HTTP ${response.status}).`,
          variant: 'destructive',
        })
        return
      }

      if (!response.ok || !result || result.error) {
        toast({
          title: 'Error',
          description: result?.error ?? `Could not check this role (HTTP ${response.status})`,
          variant: 'destructive',
        })
      } else {
        const fit = result
        setJobs((prevJobs) => prevJobs.map((j) => (j.id === jobId ? { ...j, person_roles: fitToColumns(fit) } : j)))
        toast({
          title: fit.blocked.length > 0 ? 'Filtered out' : `Your chances: ${chanceLabel(fit.chance)}`,
          description: fit.blocked[0]?.text ?? fit.want?.reason ?? undefined,
        })
      }
    } catch (error) {
      console.error('[jobs] calculateMatch failed:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? `Could not check this role: ${error.message}` : 'Could not check this role',
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
          title: 'Could not check your roles',
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
          `Checked ${totalScored}${totalFailed > 0 ? `, ${totalFailed} could not be checked` : ''}.`,
          reachable === 0
            ? 'Everything your filters allow has been checked.'
            : `${reachable} still to check.`,
        ]
        // The number that actually explains this account: roles outside the function
        // and level they asked for, which stay unchecked on purpose.
        if (excluded > 0) {
          parts.push(
            `${excluded} more are outside your targeting and will not be checked. Widen it in Settings, Job targeting.`
          )
        }
        toast({
          title: stopBatchRef.current ? 'Checking stopped' : 'Checking complete',
          description: parts.join(' '),
        })
      }

      // Refresh the current page so freshly checked roles show their chance.
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

  // TARGET-TITLE RANKING IS A RE-RANK, NOT A NEW SORT MODE.
  //   It deliberately does NOT join the `sort` control. A sort mode has to be a
  //   server ORDER BY, because the server also decides WHICH 30 of ~11,800 rows
  //   this page holds (see fetchJobsPage's range()). Title similarity isn't a
  //   jobs column and can't be expressed in that query, so a "Best title match"
  //   option would claim to sort the whole corpus while only touching the page
  //   already in memory — the same shape of lie as the old batch "remaining"
  //   count. Ranking client-side over the loaded rows is exactly as far as the
  //   data reaches, and TargetTitlesBar says so out loud.
  //
  //   It composes with the sort instead: rankJobsByTargetTitles is stable, so
  //   equal-scoring jobs keep the incoming order — which IS the current sort —
  //   and a user with no titles configured gets `filteredJobs` back untouched.
  //   Same client-side-over-the-loaded-page tier as the visa filter above.
  const rankedJobs = useMemo(
    () => rankJobsByTargetTitles(filteredJobs, targetTitles),
    [filteredJobs, targetTitles]
  )
  const titleMatchCount = useMemo(
    () => rankedJobs.reduce((n, r) => n + (r.titleMatch.score > 0 ? 1 : 0), 0),
    [rankedJobs]
  )

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
  // Target titles are deliberately NOT in hasActiveFilters: they reorder the
  // list, they never remove a row from it. Counting them would make "Clear
  // filters" the offered fix for an empty result set that titles cannot
  // possibly have caused.
  const sortLabel = sortBy === 'best_match' ? 'Best for you' : 'Newest first'
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
                <SelectItem value="best_match">Best for you</SelectItem>
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
                      ? `Checked ${batchProgress.scored} · ${batchProgress.remaining} left`
                      : 'Checking'}
                  </>
                ) : (
                  <>
                    <LogoMark className="h-4 w-4" />
                    {allScored ? 'All roles checked' : 'Check my roles'}
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
                        Keeps checking until everything your filters allow is
                        done, {BATCH_LIMIT} at a time, with metered AI calls.
                        You can stop it at any point. {budgetHint}.
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
                        {matchDisabledReason ?? 'Every role in your backlog has been checked.'}
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
      ) : allCount === 0 && !hasActiveFilters ? (
        <EmptyState
          icon={Briefcase}
          title="No jobs discovered yet"
          body={`Cello checks your ${trackedCompanies.length} ${
            trackedCompanies.length === 1 ? 'company' : 'companies'
          } on a schedule, or refresh now to fetch open roles.`}
          action={<RefreshJobsButton onRefreshed={refreshAll} />}
        />
      ) : (
        <>
          {roleTargets && (
            <TargetScopeSwitch
              scope={scope}
              matchingCount={matchingCount}
              allCount={allCount}
              onScopeChange={(next) => setParam('scope', next === 'all' ? 'all' : '')}
            />
          )}

          <FacetChips
            freshness={freshness}
            onFreshnessChange={(v) => setParam('fresh', v)}
            includeUndated={includeUndated}
            onIncludeUndatedChange={(v) => setParam('undated', v ? '1' : '')}
            companies={trackedCompanies}
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
            country={countryInput}
            onCountryChange={setCountryInput}
            language={language}
            onLanguageChange={(v) => setFacetParam('lang', v)}
            hideLowQuality={hideLowQuality}
            onHideLowQualityChange={(v) => setParam('showLowQuality', v ? '' : '1')}
            shown={filteredJobs.length}
            total={totalCount}
          />

          <TargetTitlesBar
            titles={targetTitles}
            onChange={(next) => setFacetParam('titles', serializeTargetTitlesParam(next))}
            sortLabel={sortLabel}
            matchedCount={titleMatchCount}
            rankedCount={rankedJobs.length}
          />

          {filteredJobs.length === 0 && scope === 'matching' && allCount > 0 ? (
            <EmptyState
              icon={SearchX}
              title="No roles match your targets yet"
              body={`${allCount} open ${allCount === 1 ? 'role is' : 'roles are'} outside them, or could not be placed in a function or level.`}
              action={
                <Button variant="outline" onClick={() => setParam('scope', 'all')}>
                  Show all roles ({allCount})
                </Button>
              }
            />
          ) : filteredJobs.length === 0 ? (
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
                {rankedJobs.map(({ job, titleMatch }) => (
                  // Wrapper, not a JobRow prop: the reason line belongs to the
                  // ranking this page owns, and job-row.tsx has no idea target
                  // titles exist. `divide-y` still separates these wrappers as
                  // the container's direct children, so the list reads the same.
                  <div key={job.id}>
                    <TitleMatchReason match={titleMatch} />
                    <JobRow
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
                  </div>
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
          onAssess={() => calculateMatch(selectedJob.id)}
          assessing={calculatingMatch === selectedJob.id}
        />
      )}
    </div>
  )
}
