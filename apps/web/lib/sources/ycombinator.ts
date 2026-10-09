// Y Combinator hiring companies via the yc-oss public API (a keyless, public
// JSON mirror of YC's own company directory — https://yc-oss.github.io/api).
//
// NOTE on granularity: workatastartup.com's per-role listings sit behind bot
// protection (HTTP 406 to non-browser clients) and have no keyless JSON feed, so
// scraping them would violate the "no HTML scraping" boundary. Instead we surface
// each *hiring* YC company as a company-level lead that links to its public YC
// profile (which lists its open roles). One lead per hiring company.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, truncate } from './util'

const HOSTS = new Set(['yc-oss.github.io'])
const HIRING_URL = 'https://yc-oss.github.io/api/companies/hiring.json'

export interface YcCompany {
  name?: string
  slug?: string
  website?: string
  all_locations?: string
  one_liner?: string
  long_description?: string
  tags?: string[]
  industry?: string
  industries?: string[]
  regions?: string[]
  team_size?: number | null
  small_logo_thumb_url?: string
  isHiring?: boolean
  status?: string
  url?: string // public YC profile, e.g. https://www.ycombinator.com/companies/<slug>
  batch?: string
}

function domainFromWebsite(website?: string): string | null {
  if (!website) return null
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

function toLead(c: YcCompany): JobLead | null {
  const company = c.name?.trim()
  const url = c.url || (c.slug ? `https://www.ycombinator.com/companies/${c.slug}` : null)
  if (!company || !url || !c.isHiring) return null
  if (c.status && /inactive|dead/i.test(c.status)) return null
  const desc = c.long_description || c.one_liner || ''
  const industryTag = c.industry ? [c.industry] : []
  return {
    company,
    title: `Open roles at ${company}`,
    url,
    location: c.all_locations?.trim() || null,
    salary: null,
    description: truncate(
      [c.one_liner, desc].filter(Boolean).join(' — '),
      2000
    ),
    source: 'ycombinator',
    externalId: url,
    companyDomain: domainFromWebsite(c.website),
    postedAt: null,
    tags: [...(c.tags ?? []), ...industryTag, ...(c.batch ? [c.batch] : [])],
  }
}

/**
 * The full hiring list as YC publishes it, or [] when the mirror is down. The
 * company directory (lib/companies/directory.ts) reads the same list so one
 * fetch shape serves both the job source and type-ahead.
 */
export async function fetchYcHiringCompanies(): Promise<YcCompany[]> {
  try {
    const rows = await getJson<YcCompany[]>(HIRING_URL, HOSTS, { timeoutMs: 20_000 })
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export const ycombinator: SourceAdapter = {
  id: 'ycombinator',
  label: 'Y Combinator',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    const rows = await fetchYcHiringCompanies()
    const leads: JobLead[] = []
    for (const c of rows) {
      const lead = toLead(c)
      if (lead) leads.push(lead)
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
