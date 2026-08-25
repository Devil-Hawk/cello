// Arbeitnow public job-board API — https://www.arbeitnow.com/api/job-board-api
// Public, keyless. One page = 100 jobs; we page via ?page=N. No HTML scraping.
//
// Arbeitnow is overwhelmingly a GERMAN-market board (German-language titles
// and descriptions even for roles it tags "remote"). Fetching it unconditionally
// was how German-language jobs ended up in every user's feed regardless of
// their targeting. It is now only queried when the caller's targeting
// explicitly signals interest in Germany/EU-adjacent geography or the German
// language — otherwise it is skipped entirely (not even fetched).

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import {
  employerDomainFromUrl,
  getJson,
  rankAndLimit,
  sanitizeLeads,
  stripHtml,
  truncate,
} from './util'

const HOSTS = new Set(['www.arbeitnow.com'])
const MAX_PAGES = 2

/** Countries this DACH/EU-leaning board is relevant for. */
const RELEVANT_COUNTRIES = new Set(['DE', 'AT', 'CH'])

/** True when the caller's targeting opts into this board's market. */
function wantsGermanMarket(q: SourceQuery): boolean {
  const t = q.targeting
  if (!t) return false
  if (t.languages.includes('de')) return true
  return t.countries.some((c) => RELEVANT_COUNTRIES.has(c))
}

interface ArbeitnowJob {
  slug?: string
  company_name?: string
  title?: string
  description?: string
  remote?: boolean
  url?: string
  tags?: string[]
  job_types?: string[]
  location?: string
  created_at?: number // unix seconds
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[]
  links?: { next?: string | null }
}

function toLead(job: ArbeitnowJob): JobLead | null {
  const url = job.url
  const title = job.title?.trim()
  const company = job.company_name?.trim()
  if (!url || !title || !company) return null
  const location = job.location?.trim() || (job.remote ? 'Remote' : null)
  return {
    company,
    title,
    url,
    location: location || null,
    salary: null,
    description: truncate(stripHtml(job.description)),
    source: 'arbeitnow',
    externalId: url,
    companyDomain: employerDomainFromUrl(url),
    postedAt:
      typeof job.created_at === 'number'
        ? new Date(job.created_at * 1000).toISOString()
        : null,
    tags: [...(job.tags ?? []), ...(job.job_types ?? [])],
  }
}

export const arbeitnow: SourceAdapter = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    if (!wantsGermanMarket(q)) return []
    const leads: JobLead[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (q.signal?.aborted) break
      const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`
      let res: ArbeitnowResponse
      try {
        res = await getJson<ArbeitnowResponse>(url, HOSTS)
      } catch {
        break
      }
      const rows = res.data ?? []
      for (const job of rows) {
        const lead = toLead(job)
        if (lead) leads.push(lead)
      }
      if (rows.length === 0 || !res.links?.next) break
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
