// Working Nomads public feed — https://www.workingnomads.com/api/exposed_jobs/
// Public, keyless, a flat JSON array (no pagination — verified live
// 2026-07-28: 44 postings across 17 distinct employers in one response).
//
// job.url stays on workingnomads.com/job/go/… (a tracked redirect, not a
// direct employer link we can safely resolve without following it), so
// companyDomain is left null — same reasoning as remotive.ts.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'

const HOSTS = new Set(['www.workingnomads.com'])
const FEED_URL = 'https://www.workingnomads.com/api/exposed_jobs/'

interface WorkingNomadsJob {
  url?: string
  title?: string
  description?: string
  company_name?: string
  location?: string
  tags?: string
  pub_date?: string
}

function toLead(job: WorkingNomadsJob): JobLead | null {
  const title = job.title?.trim()
  const company = job.company_name?.trim()
  const rawUrl = job.url?.trim()
  if (!title || !company || !rawUrl || !/^https?:\/\//i.test(rawUrl)) return null
  const postedAt = job.pub_date && !Number.isNaN(Date.parse(job.pub_date)) ? new Date(job.pub_date).toISOString() : null
  return {
    company,
    title,
    url: rawUrl,
    location: job.location?.trim() || null,
    salary: null,
    description: truncate(stripHtml(job.description)),
    source: 'workingnomads',
    externalId: rawUrl,
    companyDomain: null, // url is a workingnomads.com/job/go/ redirect, not a direct employer link
    postedAt,
    tags: job.tags ? job.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
  }
}

export const workingnomads: SourceAdapter = {
  id: 'workingnomads',
  label: 'Working Nomads',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    let rows: WorkingNomadsJob[]
    try {
      rows = await getJson<WorkingNomadsJob[]>(FEED_URL, HOSTS)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    const leads: JobLead[] = []
    for (const job of rows) {
      const lead = toLead(job)
      if (lead) leads.push(lead)
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
