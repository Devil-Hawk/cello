// Himalayas public feed — https://himalayas.app/jobs/api
// Public, keyless. Verified live 2026-07-28: the API echoes back a `limit` of
// 20 regardless of the requested value (tested ?limit=100 → still 20 rows),
// so pages are walked via `offset` instead (offset=0,20,40,… confirmed to
// advance — offset=20 returned a disjoint page against a totalCount of ~96k).
//
// applicationLink/guid both stay on himalayas.app (no outbound employer URL
// in the feed), so companyDomain is left null — same reasoning as remotive.ts.
//
// LIVE UPSTREAM BUG (observed 2026-07-28, re-confirmed on a second, independent
// fetch minutes later — not a one-off blip): every job in the feed currently
// returns companyName literally as the string "name" (and companyLogo as the
// string "thumbnail_url") — an unrendered template placeholder on Himalayas'
// side, not a real employer. companySlug still carries the real value (e.g.
// "under-armour", "gitlab-com"), so companyName() below falls back to a
// humanized slug whenever companyName is missing or literally "name", rather
// than ingesting the placeholder as if it were a genuine employer name.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { getJson, rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'

const HOSTS = new Set(['himalayas.app'])
const PAGE_SIZE = 20
const MAX_PAGES = 5

interface HimalayasJob {
  title?: string
  excerpt?: string
  description?: string
  companyName?: string
  companySlug?: string
  applicationLink?: string
  guid?: string
  locationRestrictions?: string[]
  categories?: string[]
  pubDate?: number | string
}

interface HimalayasResponse {
  jobs?: HimalayasJob[]
  totalCount?: number
}

function cleanUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    const host = parsed.hostname.toLowerCase()
    const trusted = host === 'himalayas.app' || host.endsWith('.himalayas.app')
    return parsed.protocol === 'https:' && trusted ? parsed.href : null
  } catch {
    return null
  }
}

function toEpochIso(value: number | string | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return null
}

/** Humanize a slug ("under-armour" -> "Under Armour") as a fallback company
 *  name when companyName is absent or the known-broken "name" placeholder. */
function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function companyNameOf(job: HimalayasJob): string | null {
  const raw = job.companyName?.trim()
  if (raw && raw.toLowerCase() !== 'name') return raw
  const slug = job.companySlug?.trim()
  return slug ? humanizeSlug(slug) : null
}

function toLead(job: HimalayasJob): JobLead | null {
  const title = job.title?.trim()
  const company = companyNameOf(job)
  const url = cleanUrl(job.applicationLink) || cleanUrl(job.guid)
  if (!title || !company || !url) return null
  return {
    company,
    title,
    url,
    location: (job.locationRestrictions ?? []).filter(Boolean).join(', ') || null,
    salary: null,
    description: truncate(stripHtml(job.description || job.excerpt)),
    source: 'himalayas',
    externalId: url,
    companyDomain: null, // link stays on himalayas.app — no outbound employer URL in this feed
    postedAt: toEpochIso(job.pubDate),
    tags: (job.categories ?? []).filter(Boolean),
  }
}

export const himalayas: SourceAdapter = {
  id: 'himalayas',
  label: 'Himalayas',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    const leads: JobLead[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      if (q.signal?.aborted) break
      const offset = page * PAGE_SIZE
      const url = `https://himalayas.app/jobs/api?limit=${PAGE_SIZE}&offset=${offset}`
      let res: HimalayasResponse
      try {
        res = await getJson<HimalayasResponse>(url, HOSTS)
      } catch {
        break
      }
      const rows = res.jobs ?? []
      for (const job of rows) {
        const lead = toLead(job)
        if (lead) leads.push(lead)
      }
      if (rows.length < PAGE_SIZE) break
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
