// TheMuse public jobs API — https://www.themuse.com/developers/api/v2
// Public, keyless (rate-limited). When the caller's targeting names job
// functions, we ask the API to filter server-side via `category` (verified
// live against the real API — see CATEGORY_BY_FUNCTION below) and pass
// `locations` through as `location`. We still page a few times and
// keyword-filter client side on top of that. No HTML scraping.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'
import type { JobFunction } from '../jobs/classify'

const HOSTS = new Set(['www.themuse.com'])
const MAX_PAGES = 3

/**
 * lib/jobs/classify.ts JobFunction -> TheMuse `category` query values.
 * Confirmed against the live API (each category filters correctly and these
 * exact strings are the ones TheMuse's job objects report back in
 * `results[].categories[].name`). 'other' has no mapping — no category param
 * is added, matching the API's own "Unknown" bucket rather than guessing.
 */
const CATEGORY_BY_FUNCTION: Partial<Record<JobFunction, string[]>> = {
  engineering: ['Software Engineering', 'Science and Engineering'],
  data: ['Data and Analytics'],
  product: ['Product Management'],
  design: ['Design and UX'],
  sales: ['Sales', 'Account Management'],
  marketing: ['Advertising and Marketing', 'Media, PR, and Communications', 'Writing and Editing'],
  support: ['Customer Service'],
  operations: ['Business Operations', 'Project Management', 'Management', 'Transportation and Logistics'],
  finance: ['Accounting and Finance'],
  hr: ['Human Resources and Recruitment'],
  legal: ['Legal Services'],
}

interface MuseJob {
  name?: string
  contents?: string
  publication_date?: string
  locations?: { name?: string }[]
  refs?: { landing_page?: string }
  company?: { name?: string; short_name?: string }
  tags?: { name?: string }[]
}

interface MuseResponse {
  page?: number
  page_count?: number
  results?: MuseJob[]
}

function toLead(job: MuseJob): JobLead | null {
  const url = job.refs?.landing_page
  const title = job.name?.trim()
  const company = job.company?.name?.trim()
  if (!url || !title || !company) return null
  const location = (job.locations ?? [])
    .map((l) => l.name)
    .filter((n): n is string => !!n)
    .join(', ')
  return {
    company,
    title,
    url,
    location: location || null,
    salary: null, // TheMuse does not expose compensation
    description: truncate(stripHtml(job.contents)),
    source: 'themuse',
    externalId: url,
    companyDomain: null, // employer domain not provided
    postedAt: job.publication_date ?? null,
    tags: (job.tags ?? []).map((t) => t.name).filter((n): n is string => !!n),
  }
}

/** Build the repeated `category=`/`location=` params from targeting + locations. */
function buildQueryParams(q: SourceQuery): string {
  const params = new URLSearchParams()
  const functions = q.targeting?.functions ?? []
  const categories = new Set<string>()
  for (const fn of functions) {
    for (const cat of CATEGORY_BY_FUNCTION[fn as JobFunction] ?? []) categories.add(cat)
  }
  for (const cat of categories) params.append('category', cat)
  for (const loc of q.locations) params.append('location', loc)
  return params.toString()
}

export const themuse: SourceAdapter = {
  id: 'themuse',
  label: 'The Muse',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    const extraParams = buildQueryParams(q)
    const leads: JobLead[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (q.signal?.aborted) break
      const url =
        `https://www.themuse.com/api/public/jobs?page=${page}&descending=true` +
        (extraParams ? `&${extraParams}` : '')
      let res: MuseResponse
      try {
        res = await getJson<MuseResponse>(url, HOSTS)
      } catch {
        break // stop paging on error; return what we have
      }
      const rows = res.results ?? []
      for (const job of rows) {
        const lead = toLead(job)
        if (lead) leads.push(lead)
      }
      if (rows.length === 0 || (res.page_count && page >= res.page_count)) break
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
