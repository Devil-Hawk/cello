// Eightfold adapter: the public search behind careers sites such as
// explore.jobs.netflix.net and apply.careers.microsoft.com. No auth.
//   GET https://{host}/api/apply/v2/jobs?domain={domain}&query={q}&start={n}&sort_by=timestamp
//   GET https://{host}/api/pcsx/search?domain={domain}&query={q}&location=&start={n}&sort_by=timestamp
//
// A tenant answers one of the two (Netflix: v2 yes, pcsx 403 "not enabled";
// Microsoft: the reverse), so a 403 on v2 falls back to pcsx. Both return 10 per
// page. The host is the employer's own careers host, not a vendor domain, so the
// token carries it: "{host}_{domain}" ("explore.jobs.netflix.net_netflix.com").
// Hostnames have no underscore, so the token splits once. discover.ts only
// hands this adapter a host whose page names an Eightfold config with the
// company's own domain; nothing here is guessed.

import type { AtsJob, AtsProvider, DetectInput, FetchContext } from './types'
import { isValidToken } from './types'
import { HttpError, fetchJson } from './http'
import { htmlToPlainText } from './html'
import { mapWithConcurrency } from './concurrency'
import { isStalePosting } from '../jobs/freshness'
import { assertSsrfSafe } from '../security/untrusted'
import { makeSiteFetcher, type SiteFetcher } from '../ingest/reader/site-fetch'

const PAGE_SIZE = 10
/** 5 pages x 10 = 50 roles per search word; at most 3 words, and 20 pages (200 roles) with none. */
const MAX_PAGES_PER_QUERY = 5
const MAX_PAGES_UNQUERIED = 20
const MAX_QUERIES = 3
const DESCRIPTION_BUDGET = 8
/** Pause between the requests to one host: Microsoft answers 429 to a quick run of them. */
const PAGE_PAUSE_MS = 400
/** One read of a board: robots.txt, at most 3 words x 5 pages (or 20 unqueried), 8 bodies, and some room for a retry. */
const REQUEST_BUDGET = 40
const MAX_DESCRIPTION_CHARS = 20_000

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function splitEightfoldToken(token: string): { host: string; domain: string } | null {
  const at = token.indexOf('_')
  if (at <= 0) return null
  const host = token.slice(0, at).toLowerCase()
  const domain = token.slice(at + 1).toLowerCase()
  if (!DOMAIN_RE.test(host) || !DOMAIN_RE.test(domain)) return null
  return { host, domain }
}

export function eightfoldToken(host: string, domain: string): string | null {
  const token = `${host.toLowerCase()}_${domain.toLowerCase()}`
  return isValidToken(token) && splitEightfoldToken(token) ? token : null
}

interface V2Position {
  id?: number | string
  name?: string
  posting_name?: string
  location?: string
  locations?: string[]
  t_create?: number
  ats_job_id?: string
  display_job_id?: string
  canonicalPositionUrl?: string
  job_description?: string
}

interface PcsxPosition {
  id?: number | string
  name?: string
  locations?: string[]
  postedTs?: number
  creationTs?: number
  atsJobId?: string
  displayJobId?: string
  positionUrl?: string
  publicUrl?: string
}

const iso = (seconds: unknown): string | undefined =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined

function fromV2(host: string, p: V2Position): AtsJob | null {
  const title = (p.posting_name || p.name || '').trim()
  if (!title || p.id == null) return null
  const url = p.canonicalPositionUrl || `https://${host}/careers/job/${p.id}`
  const requisitionId = p.ats_job_id || p.display_job_id
  return {
    title,
    url,
    externalId: url,
    location: p.location || (Array.isArray(p.locations) ? p.locations.join(' · ') : undefined) || undefined,
    postedAt: iso(p.t_create),
    ...(requisitionId ? { requisitionId } : {}),
    ...(p.job_description ? { description: htmlToPlainText(p.job_description, MAX_DESCRIPTION_CHARS) } : {}),
  }
}

function fromPcsx(host: string, p: PcsxPosition): AtsJob | null {
  const title = (p.name || '').trim()
  if (!title || p.id == null) return null
  const path = p.positionUrl || `/careers/job/${p.id}`
  const url = p.publicUrl || new URL(path, `https://${host}`).toString()
  const requisitionId = p.atsJobId || p.displayJobId
  return {
    title,
    url,
    externalId: url,
    location: Array.isArray(p.locations) && p.locations.length ? p.locations.join(' · ') : undefined,
    postedAt: iso(p.postedTs ?? p.creationTs),
    ...(requisitionId ? { requisitionId } : {}),
  }
}

type Flavor = 'v2' | 'pcsx'

function searchUrl(flavor: Flavor, host: string, domain: string, query: string, start: number): string {
  const q = encodeURIComponent(query)
  return flavor === 'v2'
    ? `https://${host}/api/apply/v2/jobs?domain=${domain}&query=${q}&start=${start}&sort_by=timestamp`
    : `https://${host}/api/pcsx/search?domain=${domain}&query=${q}&location=&start=${start}&sort_by=timestamp`
}

async function page(
  flavor: Flavor,
  host: string,
  domain: string,
  query: string,
  start: number,
  site: SiteFetcher,
  sleep?: (ms: number) => Promise<void>
): Promise<{ jobs: AtsJob[]; count: number }> {
  const url = searchUrl(flavor, host, domain, query, start)
  await site.gate(url)
  const json = await fetchJson<Record<string, unknown>>(url, { redirect: 'manual', retries: 2, sleep })
  if (flavor === 'v2') {
    const positions = Array.isArray(json.positions) ? (json.positions as V2Position[]) : []
    return { jobs: positions.map((p) => fromV2(host, p)).filter((j): j is AtsJob => !!j), count: Number(json.count) || 0 }
  }
  const data = (json.data ?? {}) as { positions?: PcsxPosition[]; count?: number }
  const positions = Array.isArray(data.positions) ? data.positions : []
  return { jobs: positions.map((p) => fromPcsx(host, p)).filter((j): j is AtsJob => !!j), count: Number(data.count) || 0 }
}

async function description(flavor: Flavor, host: string, domain: string, job: AtsJob, site: SiteFetcher): Promise<string | undefined> {
  const id = job.url.match(/\/careers\/job\/(\d+)/)?.[1]
  if (!id) return undefined
  try {
    if (flavor === 'v2') {
      const url = `https://${host}/api/apply/v2/jobs/${id}?domain=${domain}`
      await site.gate(url)
      const json = await fetchJson<V2Position>(url, { redirect: 'manual', retries: 1 })
      return json.job_description ? htmlToPlainText(json.job_description, MAX_DESCRIPTION_CHARS) : undefined
    }
    const url = `https://${host}/api/pcsx/position_details?position_id=${id}&domain=${domain}&hl=en`
    await site.gate(url)
    const json = await fetchJson<{ data?: { jobDescription?: string } }>(url, { redirect: 'manual', retries: 1 })
    return json.data?.jobDescription ? htmlToPlainText(json.data.jobDescription, MAX_DESCRIPTION_CHARS) : undefined
  } catch {
    return undefined
  }
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  if (!url.hostname.endsWith('.eightfold.ai')) return null
  const domain = url.searchParams.get('domain')
  const token = domain ? eightfoldToken(url.hostname, domain) : null
  return token ? { token } : null
}

async function fetchJobs(token: string, ctx?: FetchContext): Promise<AtsJob[]> {
  const parts = splitEightfoldToken(token)
  if (!parts) throw new Error('eightfold: invalid board token')
  const { host, domain } = parts
  await assertSsrfSafe(`https://${host}/`)
  // Every request of this read goes through the one polite door: the host's robots.txt for the exact path, a request budget, a gap.
  const site = makeSiteFetcher({ budget: { requests: REQUEST_BUDGET, gapMs: PAGE_PAUSE_MS }, sleep: ctx?.sleep })

  const queries = (ctx?.query ?? []).map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES)
  const terms = queries.length ? queries : ['']
  const maxPages = queries.length ? MAX_PAGES_PER_QUERY : MAX_PAGES_UNQUERIED
  const byId = new Map<string, AtsJob>()

  let flavor: Flavor = 'v2'
  for (const query of terms) {
    for (let p = 0; p < maxPages; p++) {
      let got: { jobs: AtsJob[]; count: number }
      // Pages come one after another, a gap apart; a host that says slow down ends the read with what it gave.
      try {
        got = await page(flavor, host, domain, query, p * PAGE_SIZE, site, ctx?.sleep)
      } catch (error) {
        // The tenant answers the other flavor of the same search.
        if (error instanceof HttpError && (error.status === 403 || error.status === 404) && flavor === 'v2' && byId.size === 0 && p === 0) {
          flavor = 'pcsx'
          got = await page(flavor, host, domain, query, 0, site, ctx?.sleep)
        } else if (byId.size > 0 || p > 0) {
          break
        } else {
          throw error
        }
      }
      for (const job of got.jobs) byId.set(job.externalId, job)
      if (got.jobs.length < PAGE_SIZE || (p + 1) * PAGE_SIZE >= got.count) break
      // Newest first: a whole page past the age limit means the rest is older still.
      if (got.jobs.every((j) => isStalePosting(j.postedAt))) break
    }
  }

  const jobs = [...byId.values()]
  // The search lists no body; the few that have none stored yet get one.
  // The search words decide which: roles whose title carries one of them (the person's targets) are read first.
  const words = queries.flatMap((q) => q.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2))
  const wanted = (j: AtsJob) => (words.some((w) => j.title.toLowerCase().includes(w)) ? 0 : 1)
  const needBody = jobs
    .filter((j) => !isStalePosting(j.postedAt) && !j.description && !ctx?.hasDescription?.(j.externalId))
    .sort((a, b) => wanted(a) - wanted(b))
    .slice(0, DESCRIPTION_BUDGET)
  const bodies = await mapWithConcurrency(needBody, 2, (j) => description(flavor, host, domain, j, site))
  needBody.forEach((j, i) => {
    if (bodies[i]) j.description = bodies[i]
  })
  return jobs
}

export const eightfold: AtsProvider = {
  id: 'eightfold',
  detect,
  fetch: fetchJobs,
  searchesByQuery: true,
}
