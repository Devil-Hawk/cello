// Remotive public feed — https://remotive.com/api/remote-jobs
// Public, keyless. Returns { jobs: [...] } as a single page (no pagination
// param needed — verified live 2026-07-28: `job-count` equals `total-job-count`
// for the unfiltered feed, currently 36 open roles across 20 employers).
//
// Every job's `url` is Remotive's OWN posting page (remotive.com/remote-jobs/…),
// not the employer's site — Remotive is a genuine job board here, not a
// fan-out like EchoJobs. So companyDomain is left null rather than guessed:
// employerDomainFromUrl(job.url) would just return "remotive.com" (remotive.com
// is not in util.ts's NON_EMPLOYER_HOSTS list), which is exactly the
// aggregator-mislabeled-as-employer bug this port is required to avoid.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'

const HOSTS = new Set(['remotive.com'])

interface RemotiveJob {
  id?: number
  url?: string
  title?: string
  company_name?: string
  tags?: string[]
  job_type?: string
  publication_date?: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

interface RemotiveResponse {
  jobs?: RemotiveJob[]
}

function toLead(job: RemotiveJob): JobLead | null {
  const title = job.title?.trim()
  const company = job.company_name?.trim()
  const rawUrl = job.url?.trim()
  if (!title || !company || !rawUrl || !/^https?:\/\//i.test(rawUrl)) return null
  return {
    company,
    title,
    url: rawUrl,
    location: job.candidate_required_location?.trim() || null,
    salary: job.salary?.trim() || null,
    description: truncate(stripHtml(job.description)),
    source: 'remotive',
    externalId: rawUrl,
    companyDomain: null, // job.url stays on remotive.com — no real employer domain in this feed
    postedAt: job.publication_date ?? null,
    tags: [...(job.tags ?? []), ...(job.job_type ? [job.job_type] : [])],
  }
}

export const remotive: SourceAdapter = {
  id: 'remotive',
  label: 'Remotive',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    let res: RemotiveResponse
    try {
      res = await getJson<RemotiveResponse>('https://remotive.com/api/remote-jobs', HOSTS)
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
