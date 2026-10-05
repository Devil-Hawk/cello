/*
 * Client helpers around the frozen POST /api/jobs/refresh contract,
 * with a fallback to POST /api/scraper/trigger for companies where no
 * ATS board was detected (provider: null).
 * Both now end in the one reader (lib/ingest/reader).
 */

export type AtsProvider = 'greenhouse' | 'lever' | 'ashby'

export interface RefreshCompanyResult {
  companyId: string
  companyName: string
  provider: AtsProvider | null
  found: number
  inserted: number
  errors: string[]
}

export interface RefreshResponse {
  ok: boolean
  results: RefreshCompanyResult[]
  totals: { found: number; inserted: number; updated: number; closed: number; busy: number; companiesWithAts: number }
}

export interface ScraperTriggerResult {
  success: boolean
  jobsFound: number
  inserted: number
  /** Only a browser can read the site, and the scheduled check will. */
  reading: boolean
  message: string
}

/** POST /api/jobs/refresh — omit companyId to refresh all of the user's companies. */
export async function refreshViaAts(companyId?: string): Promise<RefreshResponse> {
  const res = await fetch('/api/jobs/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(companyId ? { companyId } : {}),
  })
  if (!res.ok) {
    throw new Error(`Refresh failed (${res.status})`)
  }
  return res.json()
}

/** POST /api/scraper/trigger: one company through the one reader (board, search, sitemap, lists), with the answer in words. */
export async function triggerScraperFallback(companyId: string): Promise<ScraperTriggerResult> {
  try {
    const res = await fetch('/api/scraper/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId }),
    })
    const data = await res.json()
    return {
      success: Boolean(data.success),
      jobsFound: data.jobsFound || 0,
      inserted: data.inserted || 0,
      reading: Boolean(data.reading),
      message: data.message || data.error || (data.success ? 'Scrape complete' : 'Scrape failed'),
    }
  } catch {
    return { success: false, jobsFound: 0, inserted: 0, reading: false, message: 'Failed to connect to scraper' }
  }
}

export interface CompanyRefreshOutcome {
  success: boolean
  /** Jobs found, whichever way the site was read. */
  found: number
  /** Newly stored jobs. */
  inserted: number
  via: 'ats' | 'scraper'
  /** Only a browser can read the site, and the scheduled check will. */
  reading: boolean
  message: string
}

/**
 * Refresh a single company through the one reader: its job board, else the
 * site's own search, sitemaps and role lists. A site that needs a browser is
 * read by the scheduled check, and the message says so.
 */
export async function refreshCompanyJobs(companyId: string): Promise<CompanyRefreshOutcome> {
  const r = await triggerScraperFallback(companyId)
  return { success: r.success, found: r.jobsFound, inserted: r.inserted, via: 'scraper', reading: r.reading, message: r.message }
}
