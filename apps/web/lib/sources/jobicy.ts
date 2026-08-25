// Jobicy public feed — https://jobicy.com/api/v2/remote-jobs
// Public, keyless. Verified live 2026-07-28: ?count=100 returned 100 real
// postings across 82 distinct employers (count=5 and count=100 both honored
// exactly, unlike Himalayas).
//
// job.url stays on jobicy.com (a jobicy.com/jobs/<id>-<slug> posting page, not
// the employer's own site), so companyDomain is left null — same reasoning as
// remotive.ts.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'

const HOSTS = new Set(['jobicy.com'])
const COUNT = 100

interface JobicyJob {
  id?: number
  url?: string
  jobTitle?: string
  companyName?: string
  jobIndustry?: string[]
  jobType?: string[]
  jobGeo?: string
  jobExcerpt?: string
  jobDescription?: string
  pubDate?: string
}

interface JobicyResponse {
  jobs?: JobicyJob[]
}

function cleanUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    const host = parsed.hostname.toLowerCase()
    const trusted = host === 'jobicy.com' || host === 'www.jobicy.com'
    return parsed.protocol === 'https:' && trusted ? parsed.href : null
  } catch {
    return null
  }
}

function toLead(job: JobicyJob): JobLead | null {
  const title = job.jobTitle?.trim()
  const company = job.companyName?.trim()
  const url = cleanUrl(job.url)
  if (!title || !company || !url) return null
  const postedAt = job.pubDate && !Number.isNaN(Date.parse(job.pubDate)) ? new Date(job.pubDate).toISOString() : null
  return {
    company,
    title,
    url,
    location: job.jobGeo?.trim() || null,
    salary: null,
    description: truncate(stripHtml(job.jobDescription || job.jobExcerpt)),
    source: 'jobicy',
    externalId: url,
    companyDomain: null, // url is jobicy's own posting page, not the employer's site
    postedAt,
    tags: [...(job.jobIndustry ?? []), ...(job.jobType ?? [])],
  }
}

export const jobicy: SourceAdapter = {
  id: 'jobicy',
  label: 'Jobicy',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    let res: JobicyResponse
    try {
      res = await getJson<JobicyResponse>(`https://jobicy.com/api/v2/remote-jobs?count=${COUNT}`, HOSTS)
    } catch {
      return []
    }
    const rows = res.jobs ?? []
    const leads: JobLead[] = []
    for (const job of rows) {
      const lead = toLead(job)
      if (lead) leads.push(lead)
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
