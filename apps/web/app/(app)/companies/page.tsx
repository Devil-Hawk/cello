'use client'

import { useEffect, useState } from 'react'
import { Building2, FileWarning, Plus, RefreshCw, Search, Sparkles, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { StatRow } from '@/components/ui/stat-row'
import { toast } from '@/components/ui/use-toast'
import { AddCompanyDialog } from '@/components/companies/add-company-dialog'
import { CompanyRow, type CompanySummary } from '@/components/companies/company-row'
import {
  refreshCompanyJobs,
  refreshViaAts,
  triggerScraperFallback,
} from '@/components/companies/refresh'
import { formatShortDate } from '@/lib/format'
import { createClient } from '@/lib/supabase/client'

/**
 * Highest best-match-score first, unscored companies last (never coerced to
 * 0 — that would bury them among genuinely weak matches instead of the
 * honest "not scored yet" bucket). Dream company no longer wins the primary
 * sort: it stays visible via the star badge on every row (and the "Dream
 * only" filter/stat above), but a starred company with a weak or no match
 * shouldn't outrank a strong, unstarred match — that would defeat the point
 * of ranking by fit at all. Dream only breaks ties, and only among
 * companies that are otherwise equal (same score, or both unscored).
 */
function compareByMatchThenDream(a: CompanySummary, b: CompanySummary): number {
  const aScore = a.best_match_score ?? null
  const bScore = b.best_match_score ?? null
  if (aScore !== bScore) {
    if (aScore === null) return 1
    if (bScore === null) return -1
    return bScore - aScore
  }
  if (a.is_dream_company !== b.is_dream_company) {
    return a.is_dream_company ? -1 : 1
  }
  return b.created_at.localeCompare(a.created_at)
}

export default function CompaniesPage() {
  const supabase = createClient()
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDream, setFilterDream] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null)
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [isFixingNames, setIsFixingNames] = useState(false)

  useEffect(() => {
    fetchCompanies()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchCompanies() {
    // Both of these matter on RETRY, not just first load: without setIsLoading
    // the retry clears loadError while isLoading is already false, so the
    // "No companies yet" empty state flashes for the length of the refetch.
    setIsLoading(true)
    setLoadError(null)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setLoadError("Couldn't verify your session. Sign in again and try again.")
        return
      }

      // A per-company `count` aggregate can't also tell us the best score, so
      // this pulls each company's jobs' match_score in the same query and
      // reduces client-side below — one query for every company, not one
      // query per company.
      const { data, error } = await supabase
        .from('companies')
        .select(
          `
        *,
        jobs:jobs(match_score)
      `
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

      if (error) {
        setLoadError("Couldn't load your companies. Check your connection and try again.")
        return
      }

      setCompanies(
        (data ?? [])
          .map((company) => {
            const jobs = company.jobs ?? []
            const scores = jobs
              .map((j) => j.match_score)
              .filter((s): s is number => typeof s === 'number')
            return {
              ...company,
              jobs_count: jobs.length,
              // null (not 0) when nothing is scored yet — "scored badly" and
              // "not scored" are different facts and must sort differently.
              best_match_score: scores.length > 0 ? Math.max(...scores) : null,
            }
          })
          .sort(compareByMatchThenDream)
      )
    } catch {
      // A THROWN failure — offline, DNS, an aborted fetch — never produces a
      // Supabase `{ error }` object, so checking only that left this exact
      // case falling through to "No companies yet": the page telling the user
      // a false story about their own data. This is the case the copy below
      // actually describes, and it also stops the effect's unhandled rejection.
      setLoadError("Couldn't load your companies. Check your connection and try again.")
    } finally {
      setIsLoading(false)
    }
  }

  async function fixCompanyNames() {
    setIsFixingNames(true)
    try {
      const res = await fetch('/api/companies/fix-names', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast({
          title: 'Company names fixed',
          description: `Updated ${data.updates?.length || 0} company names.`,
        })
        fetchCompanies()
      }
    } catch (err) {
      console.error('Failed to fix names:', err)
      toast({
        title: 'Could not fix names',
        description: 'Please try again.',
        variant: 'destructive',
      })
    }
    setIsFixingNames(false)
  }

  async function refreshAllCompanies() {
    if (companies.length === 0 || isRefreshingAll) return
    setIsRefreshingAll(true)
    setRefreshStatus('Checking ATS boards for all companies…')

    try {
      const response = await refreshViaAts()

      // Fall back to the legacy scraper for companies without a detected ATS board.
      const noAts = response.results.filter((r) => r.provider === null)
      let fallbackFound = 0
      for (let i = 0; i < noAts.length; i++) {
        setRefreshStatus(
          `Scraping ${noAts[i].companyName} (${i + 1}/${noAts.length} without an ATS board)…`
        )
        const result = await triggerScraperFallback(noAts[i].companyId)
        if (result.success) fallbackFound += result.jobsFound
      }

      toast({
        title: 'Refresh complete',
        description: `${response.totals.found + fallbackFound} roles found, ${
          response.totals.inserted
        } new via ATS (${response.totals.companiesWithAts} companies with boards).`,
      })
      fetchCompanies()
    } catch (err) {
      console.error('Refresh all failed:', err)
      toast({ title: 'Refresh failed', description: 'Could not refresh jobs. Try again shortly.' })
    }

    setRefreshStatus(null)
    setIsRefreshingAll(false)
  }

  async function refreshCompany(company: CompanySummary) {
    if (refreshingIds.has(company.id)) return
    setRefreshingIds((prev) => new Set(prev).add(company.id))

    const outcome = await refreshCompanyJobs(company.id)
    toast({
      title: outcome.success ? company.name : `${company.name}: refresh failed`,
      description: outcome.message,
      // Without this a failed refresh rendered in the same neutral, success-
      // looking treatment as a successful one.
      ...(outcome.success ? {} : { variant: 'destructive' as const }),
    })
    if (outcome.success) fetchCompanies()

    setRefreshingIds((prev) => {
      const next = new Set(prev)
      next.delete(company.id)
      return next
    })
  }

  async function toggleDreamCompany(company: CompanySummary) {
    const { error } = await supabase
      .from('companies')
      .update({ is_dream_company: !company.is_dream_company })
      .eq('id', company.id)

    if (!error) {
      setCompanies(
        companies.map((c) =>
          c.id === company.id ? { ...c, is_dream_company: !c.is_dream_company } : c
        )
      )
    } else {
      toast({
        title: 'Could not update company',
        description: `${company.name} was not updated. Try again.`,
        variant: 'destructive',
      })
    }
  }

  async function deleteCompany(company: CompanySummary) {
    if (!confirm('Are you sure you want to delete this company?')) return
    const { error } = await supabase.from('companies').delete().eq('id', company.id)
    if (!error) {
      setCompanies(companies.filter((c) => c.id !== company.id))
    } else {
      toast({
        title: 'Could not delete company',
        description: `${company.name} was not deleted. Try again.`,
        variant: 'destructive',
      })
    }
  }

  const filteredCompanies = companies.filter((company) => {
    const q = searchQuery.toLowerCase()
    const matchesSearch =
      company.name.toLowerCase().includes(q) || company.domain?.toLowerCase().includes(q)
    const matchesDream = !filterDream || company.is_dream_company
    return matchesSearch && matchesDream
  })

  const dreamCount = companies.filter((c) => c.is_dream_company).length
  const totalJobs = companies.reduce((acc, c) => acc + (c.jobs_count || 0), 0)
  const lastChecked = companies.reduce<string | null>(
    (latest, c) =>
      c.last_scraped_at && (!latest || c.last_scraped_at > latest) ? c.last_scraped_at : latest,
    null
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-title text-foreground">Companies</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Track career pages and discover openings automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {companies.length > 0 && (
            <>
              <Button variant="outline" onClick={refreshAllCompanies} disabled={isRefreshingAll}>
                <RefreshCw className={`h-4 w-4 ${isRefreshingAll ? 'animate-spin' : ''}`} />
                {isRefreshingAll ? 'Refreshing…' : 'Refresh all'}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={fixCompanyNames}
                disabled={isFixingNames}
                title="Fix company names using known directory"
                aria-label={isFixingNames ? 'Fixing company names…' : 'Fix company names using known directory'}
              >
                <Sparkles className={`h-4 w-4 ${isFixingNames ? 'animate-spin' : ''}`} aria-hidden />
              </Button>
            </>
          )}
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4" />
            Add company
          </Button>
        </div>
      </div>

      {/* Refresh progress line */}
      {refreshStatus && (
        <p className="text-caption text-muted-foreground" role="status">
          {refreshStatus}
        </p>
      )}

      {/* Stats */}
      {companies.length > 0 && (
        <StatRow
          stats={[
            { label: 'Companies', value: companies.length },
            { label: 'Dream companies', value: dreamCount },
            { label: 'Open roles', value: totalJobs },
            {
              label: 'Last checked',
              value: lastChecked ? formatShortDate(lastChecked) : '—',
            },
          ]}
        />
      )}

      {/* Search + filter */}
      {companies.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="text"
              aria-label="Search companies"
              placeholder="Search companies…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant={filterDream ? 'secondary' : 'outline'}
            onClick={() => setFilterDream(!filterDream)}
            aria-pressed={filterDream}
          >
            <Star
              className={`h-4 w-4 ${filterDream ? 'fill-amber-400 text-amber-400' : ''}`}
              aria-hidden
            />
            Dream only
          </Button>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <Card className="divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3.5">
              <Skeleton className="h-10 w-10 rounded-control" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
          ))}
        </Card>
      ) : loadError ? (
        <EmptyState
          icon={FileWarning}
          title="Couldn't load your companies"
          body={loadError}
          action={<Button onClick={fetchCompanies}>Retry</Button>}
        />
      ) : companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No companies yet"
          body="Type a company name — or paste a career page URL — and Cello will check it for new openings automatically."
          action={
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4" />
              Add your first company
            </Button>
          }
        />
      ) : filteredCompanies.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          body="No companies match the current search or filter."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setSearchQuery('')
                setFilterDream(false)
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <Card className="divide-y">
          {filteredCompanies.map((company) => (
            <CompanyRow
              key={company.id}
              company={company}
              isRefreshing={refreshingIds.has(company.id) || isRefreshingAll}
              onToggleDream={toggleDreamCompany}
              onRefresh={refreshCompany}
              onDelete={deleteCompany}
            />
          ))}
        </Card>
      )}

      <AddCompanyDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdded={fetchCompanies}
      />
    </div>
  )
}
