'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { motion } from '@/components/ui/motion'
import {
  AlertCircle,
  ArrowLeft,
  Briefcase,
  Building2,
  CheckCircle,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Star,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { StatRow } from '@/components/ui/stat-row'
import { CompanyLogo, getCompanyLogoSrc } from '@/components/companies/company-logo'
import { DossierPanel } from '@/components/companies/dossier-panel'
import { refreshCompanyJobs } from '@/components/companies/refresh'
import { ContactNetworkPanel } from '@/components/contacts/contact-network-panel'
import { formatShortDate, matchTone } from '@/lib/format'
import { createClient } from '@/lib/supabase/client'

interface Company {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  career_url: string
  is_dream_company: boolean
  notes: string | null
  created_at: string
  last_scraped_at: string | null
  scrape_frequency: number
}

interface Job {
  id: string
  title: string
  description: string
  url: string
  location: string | null
  salary_range: string | null
  job_type: string | null
  posted_at: string | null
  discovered_at: string
  match_score: number | null
  is_new: boolean
}

export default function CompanyDetailPage() {
  const router = useRouter()
  const params = useParams()
  const companyId = params.id as string
  const supabase = createClient()

  const [company, setCompany] = useState<Company | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<{ success: boolean; message: string } | null>(
    null
  )

  useEffect(() => {
    if (companyId) {
      fetchCompanyData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function fetchCompanyData() {
    // RLS scopes this fetch to the signed-in user.
    const { data: companyData } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .single()

    if (companyData) {
      setCompany(companyData)

      const { data: jobsData } = await supabase
        .from('jobs')
        .select('*')
        .eq('company_id', companyId)
        .order('discovered_at', { ascending: false })

      if (jobsData) {
        setJobs(jobsData)
      }
    }

    setIsLoading(false)
  }

  async function toggleDreamCompany() {
    if (!company) return
    const { error } = await supabase
      .from('companies')
      .update({ is_dream_company: !company.is_dream_company })
      .eq('id', company.id)

    if (!error) {
      setCompany({ ...company, is_dream_company: !company.is_dream_company })
    }
  }

  async function refreshJobs() {
    if (!company || isRefreshing) return
    setIsRefreshing(true)
    setRefreshResult(null)

    const outcome = await refreshCompanyJobs(company.id)
    setRefreshResult({ success: outcome.success, message: outcome.message })
    if (outcome.success) {
      await fetchCompanyData()
    }

    setIsRefreshing(false)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
        <h1 className="sr-only">Company — loading…</h1>
        <Skeleton className="h-8 w-40" />
        <Card className="p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="h-16 w-16 rounded-control" />
            <div className="space-y-2">
              <Skeleton className="h-6 w-52" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </Card>
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-48 w-full rounded-card" />
      </div>
    )
  }

  if (!company) {
    return (
      <EmptyState
        icon={Building2}
        title="Company not found"
        headingLevel="h1"
        body="It may have been deleted, or the link is wrong."
        action={
          <Button variant="outline" onClick={() => router.push('/companies')}>
            <ArrowLeft className="h-4 w-4" />
            Back to companies
          </Button>
        }
      />
    )
  }

  const newThisWeek = jobs.filter((j) => j.is_new).length

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => router.push('/companies')}>
        <ArrowLeft className="h-4 w-4" />
        Back to companies
      </Button>

      {/* Company header */}
      <Card className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <CompanyLogo
              src={getCompanyLogoSrc(company.logo_url, company.domain, company.career_url)}
              name={company.name}
              className="h-16 w-16"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate font-display text-title text-foreground">{company.name}</h1>
                {company.is_dream_company && (
                  <Badge tone="warn">
                    <Star className="h-3 w-3 fill-current" />
                    Dream company
                  </Badge>
                )}
              </div>
              {company.domain && (
                <a
                  href={`https://${company.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 text-caption text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Globe className="h-3.5 w-3.5" />
                  {company.domain}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={toggleDreamCompany}>
              <Star
                className={`h-4 w-4 ${
                  company.is_dream_company ? 'fill-amber-400 text-amber-400' : ''
                }`}
              />
              {company.is_dream_company ? 'Unmark dream' : 'Mark as dream'}
            </Button>
            <Button variant="outline" size="sm" onClick={refreshJobs} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh jobs
            </Button>
            <Button size="sm" onClick={() => window.open(company.career_url, '_blank')}>
              <Briefcase className="h-4 w-4" />
              Careers page
            </Button>
          </div>
        </div>
      </Card>

      {/* Stats */}
      <StatRow
        stats={[
          { label: 'Open roles', value: jobs.length },
          { label: 'New this week', value: newThisWeek },
          { label: 'Check interval', value: company.scrape_frequency, hint: 'min' },
          {
            label: 'Last checked',
            value: company.last_scraped_at ? formatShortDate(company.last_scraped_at) : 'Never',
          },
        ]}
      />

      {/* Company research dossier (free public sources) */}
      <DossierPanel companyId={companyId} />

      {/* Contacts, warm intros, and outreach drafting for this company */}
      <ContactNetworkPanel companyId={companyId} variant="card" />

      {/* Refresh feedback */}
      {refreshResult && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className={
            refreshResult.success
              ? 'flex items-start gap-3 border-l-2 border-emerald-400/60 bg-emerald-50/60 py-3 pl-4 dark:bg-emerald-500/5'
              : 'flex items-start gap-3 border-l-2 border-red-400/60 bg-red-50/60 py-3 pl-4 dark:bg-red-500/5'
          }
          role="status"
        >
          {refreshResult.success ? (
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
          ) : (
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          )}
          <p className="text-body text-foreground">{refreshResult.message}</p>
        </motion.div>
      )}

      {/* Jobs */}
      <div className="space-y-3">
        <h2 className="font-display text-section text-foreground">
          Open positions ({jobs.length})
        </h2>

        {jobs.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No jobs found yet"
            body='Click "Refresh jobs" to check this company&#39;s career page for open roles.'
            action={
              <Button variant="outline" onClick={() => window.open(company.career_url, '_blank')}>
                <ExternalLink className="h-4 w-4" />
                Visit career page
              </Button>
            }
          />
        ) : (
          <Card className="divide-y">
            {jobs.map((job) => {
              const tone = matchTone(job.match_score)
              const meta = [
                job.location,
                job.salary_range,
                job.job_type,
                job.posted_at
                  ? `Posted ${formatShortDate(job.posted_at)}`
                  : `Found ${formatShortDate(job.discovered_at)}`,
              ].filter(Boolean)

              return (
                <div key={job.id} className="flex items-center gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {job.is_new && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                          title="New"
                        />
                      )}
                      <span className="truncate text-body font-medium text-foreground">
                        {job.title}
                      </span>
                      {tone !== 'none' && (
                        <Badge tone={tone}>{job.match_score}%</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-caption text-muted-foreground">
                      {meta.join(' · ')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => window.open(job.url, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4" />
                    View
                  </Button>
                </div>
              )
            })}
          </Card>
        )}
      </div>

      {/* Notes */}
      {company.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-body text-muted-foreground">{company.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
