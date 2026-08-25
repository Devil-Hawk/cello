// RemoteOK public API — https://remoteok.com/api
// Public, keyless (requires a User-Agent, which lib/ats/http sets). The first
// array element is a legal/notice object and is skipped. All roles are remote.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import {
  employerDomainFromUrl,
  getJson,
  rankAndLimit,
  sanitizeLeads,
  stripHtml,
  truncate,
} from './util'

const HOSTS = new Set(['remoteok.com'])

interface RemoteOkJob {
  id?: string
  slug?: string
  epoch?: number
  date?: string
  company?: string
  position?: string
  tags?: string[]
  description?: string
  location?: string
  apply_url?: string
  url?: string
  salary_min?: number
  salary_max?: number
}

function formatSalary(min?: number, max?: number): string | null {
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  if (min && max) return `${fmt(min)} - ${fmt(max)}`
  if (min) return `From ${fmt(min)}`
  if (max) return `Up to ${fmt(max)}`
  return null
}

function toLead(job: RemoteOkJob): JobLead | null {
  const url = job.url || job.apply_url
  const title = job.position?.trim()
  const company = job.company?.trim()
  if (!url || !title || !company) return null
  return {
    company,
    title,
    url,
    location: job.location?.trim() || 'Remote',
    salary: formatSalary(job.salary_min, job.salary_max),
    description: truncate(stripHtml(job.description)),
    source: 'remoteok',
    externalId: url,
    // apply_url often points at the employer's own ATS/site → good favicon source.
    companyDomain: employerDomainFromUrl(job.apply_url),
    postedAt: job.date ?? (job.epoch ? new Date(job.epoch * 1000).toISOString() : null),
    tags: job.tags ?? [],
  }
}

export const remoteok: SourceAdapter = {
  id: 'remoteok',
  label: 'RemoteOK',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    let rows: RemoteOkJob[]
    try {
      rows = await getJson<RemoteOkJob[]>('https://remoteok.com/api', HOSTS)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    const leads: JobLead[] = []
    for (const job of rows) {
      // Skip the leading legal/notice object (no position/company).
      if (!job || (!job.position && !job.company)) continue
      const lead = toLead(job)
      if (lead) leads.push(lead)
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
