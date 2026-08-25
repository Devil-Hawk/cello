/*
 * Client helpers around the frozen POST /api/jobs/refresh contract,
 * with a fallback to POST /api/scraper/trigger for companies where no
 * ATS board was detected (provider: null).
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
  totals: { found: number; inserted: number; companiesWithAts: number }
}

export interface ScraperTriggerResult {
  success: boolean
  jobsFound: number
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

/** POST /api/scraper/trigger — legacy scraper path for non-ATS companies. */
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
      message: data.message || data.error || (data.success ? 'Scrape complete' : 'Scrape failed'),
    }
  } catch {
    return { success: false, jobsFound: 0, message: 'Failed to connect to scraper' }
  }
}

export interface CompanyRefreshOutcome {
  success: boolean
  /** Jobs found across whichever path ran. */
  found: number
  /** Newly inserted jobs (ATS path only; scraper path reports found). */
  inserted: number
  via: 'ats' | 'scraper'
  message: string
}

/**
 * Refresh a single company: try the ATS route first; when no ATS board was
 * detected (provider: null), fall back to the legacy scraper trigger.
 */
export async function refreshCompanyJobs(companyId: string): Promise<CompanyRefreshOutcome> {
  let result: RefreshCompanyResult | undefined
  try {
    const response = await refreshViaAts(companyId)
    result = response.results.find((r) => r.companyId === companyId) ?? response.results[0]
  } catch {
    // Route unavailable — fall through to the scraper.
  }

  if (result && result.provider !== null) {
    const hadErrors = result.errors.length > 0
    return {
      success: !hadErrors,
      found: result.found,
      inserted: result.inserted,
      via: 'ats',
      message: hadErrors
        ? result.errors.join('; ')
        : `Found ${result.found} open roles (${result.inserted} new)`,
    }
  }

  const fallback = await triggerScraperFallback(companyId)
  return {
    success: fallback.success,
    found: fallback.jobsFound,
    inserted: fallback.jobsFound,
    via: 'scraper',
    message: fallback.message,
  }
}
