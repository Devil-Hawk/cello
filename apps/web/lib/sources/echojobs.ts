// EchoJobs public feed — https://echojobs.io/api/jobs
// Public, keyless, paginated (?per_page=N&page=N). Verified live 2026-07-28:
// a single page of 100 returned 100 real postings spanning 24 distinct
// employers/domains (Ashby, Eightfold, and other ATS boards).
//
// THE HIGH-LEVERAGE PART: EchoJobs is a fan-out aggregator, not a job board —
// every row's `url` is the ORIGINAL posting on the employer's own ATS/careers
// host (e.g. jobs.ashbyhq.com/…, *.eightfold.ai/…), not an echojobs.io page,
// and `domain_name` is the employer's real web domain. So unlike remotive/
// jobicy/workingnomads/himalayas (whose posting URLs stay on the aggregator's
// own site), EchoJobs leads get a REAL companyDomain and a REAL outbound URL —
// preserving provenance honesty per lib/sources/provenance.ts's distinction
// between "employer_via_aggregator" and "aggregator_as_employer". Only the
// FEED fetch itself is host-locked to echojobs.io; the resulting job URLs are
// deliberately NOT restricted to that host (see toLead below).

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { employerDomainFromUrl, getJson, rankAndLimit, sanitizeLeads } from './util'

const FEED_HOSTS = new Set(['echojobs.io'])
const PER_PAGE = 100
const MAX_PAGES = 3

interface EchoJobsJob {
  id?: string
  title?: string
  company_name?: string
  domain_name?: string
  url?: string
  locations?: string[]
  countries?: string[]
  remote_type?: string
  job_function?: string
  role?: string
  required_skills?: string[]
  employment_type?: string
  posted_at?: number // epoch ms
}

interface EchoJobsResponse {
  found?: number
  page?: number
  per_page?: number
  jobs?: EchoJobsJob[]
}

/** `domain_name` is a bare host ("recraft.ai"), not a URL — validate it the
 *  same way employerDomainFromUrl validates a real URL's host (and reject it
 *  if it turns out to be a known aggregator/social host), by wrapping it. */
function cleanCompanyDomain(domainName: string | undefined, fallbackUrl: string): string | null {
  if (domainName?.trim()) {
    const viaField = employerDomainFromUrl(`https://${domainName.trim()}`)
    if (viaField) return viaField
  }
  return employerDomainFromUrl(fallbackUrl)
}

function toLead(job: EchoJobsJob): JobLead | null {
  const title = job.title?.trim()
  const company = job.company_name?.trim()
  const rawUrl = job.url?.trim()
  if (!title || !company || !rawUrl) return null
  let url: string
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return null
    url = parsed.href
  } catch {
    return null
  }

  const location =
    (job.locations ?? []).filter(Boolean).join(', ') ||
    (job.remote_type === 'remote' || job.remote_type === 'hybrid' ? 'Remote' : null)

  return {
    company,
    title,
    url,
    location: location || null,
    salary: null,
    description: '', // EchoJobs' list feed carries no posting body
    source: 'echojobs',
    externalId: url,
    // Real employer domain (or a URL-derived fallback) — never echojobs.io.
    companyDomain: cleanCompanyDomain(job.domain_name, url),
    postedAt: typeof job.posted_at === 'number' && job.posted_at > 0 ? new Date(job.posted_at).toISOString() : null,
    tags: [...(job.required_skills ?? []), ...(job.role ? [job.role] : [])],
  }
}

export const echojobs: SourceAdapter = {
  id: 'echojobs',
  label: 'EchoJobs',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    const leads: JobLead[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (q.signal?.aborted) break
      const url = `https://echojobs.io/api/jobs?per_page=${PER_PAGE}&page=${page}`
      let res: EchoJobsResponse
      try {
        res = await getJson<EchoJobsResponse>(url, FEED_HOSTS)
      } catch {
        break
      }
      const rows = res.jobs ?? []
      for (const job of rows) {
        const lead = toLead(job)
        if (lead) leads.push(lead)
      }
      if (rows.length < PER_PAGE) break
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
