// Job discovery via the harness's own open-web search tool — the LAST rung of
// sourcer.ts's broaden-on-empty ladder (see lib/harness/agents/sourcer.ts).
//
// THE GAP THIS CLOSES: Cello can only find jobs on boards it already knows —
// 3 ATS adapters (lib/ats/*) + 11 keyless aggregators (lib/sources/*). A query
// for "10 AI Engineer roles" fails whenever those 14 sources don't happen to
// hold 10 matches. This module gives Cello a real web_search tool, exactly
// like Claude Code / opencode own theirs — provider-agnostic (works the same
// on OpenRouter, a local model, or a signed-in CLI subscription), via the
// shared `webSearch()` contract in lib/search (DuckDuckGo HTML by default,
// zero key; Exa as an optional BYOK upgrade — see that module).
//
// QUERY BUILDING: `site:` filters against the real ATS board hosts
// (boards.greenhouse.io, job-boards.greenhouse.io, jobs.lever.co,
// jobs.ashbyhq.com) combined with role title terms — the same pattern
// career-ops's portals.yml search_queries uses (e.g.
// `site:jobs.ashbyhq.com "AI Engineer" OR "Machine Learning Engineer" ...`).
// Role terms come from the EXISTING lib/jobs/role-taxonomy.ts taxonomy — this
// module does not invent a second synonym list.
//
// VERIFICATION, NOT TRUST: a search hit is unverified data — the URL may be
// dead, a listing page, or not a job at all. Nothing here becomes a JobLead
// without first being resolved to a real, live posting:
//   - a hit on a known ATS host is re-resolved through the SAME ATS adapters
//     (lib/ats/greenhouse|lever|ashby.ts) used everywhere else in the
//     product: detect the board token from the URL (pure, no network), fetch
//     that board's real API, and require the exact job to still be listed
//     there. This yields real structured data (title/description/salary),
//     not a scraped guess — and a hit that no longer appears on the board
//     (closed, moved, a stale index) is correctly DROPPED, never retried via
//     the looser liveness check below.
//   - a hit on any other host gets a bounded liveness fetch: HTTP 200, real
//     HTML, a non-empty <title>, and no "no longer accepting
//     applications"/"404"/"expired" phrasing. This is the fallback path for
//     the rare case a search result isn't cleanly on one of the four ATS
//     hosts above (a redirect wrapper, a near-miss from the search engine).
// Every drop is counted and explained in the returned `notes`, never silent.
//
// PROVENANCE HONESTY: every lead this module produces is tagged
// `source: 'web_search'` (lib/sources/types.ts) — never 'greenhouse' /
// 'lever' / 'ashby', even when it was verified through those adapters — so a
// search-discovered job is never presented as if Cello already tracks that
// employer's board. See lib/sources/provenance.ts's deliberate omission of
// 'web_search' from ADAPTER_SOURCE_KIND: its "unknown source" fallback
// already re-derives the right trust level from the verified job URL's host.
//
// COST DISCIPLINE: this only runs when sourcer.ts's free keyless sources
// (lib/sources/*) still come up short after every broaden-on-empty round —
// never on every pass. Query count and hits-considered are hard-bounded
// (see MAX_HITS_CONSIDERED) so one call can't turn into a crawl.

import type { SupabaseClient } from '@supabase/supabase-js'
import { webSearch, type SearchResult } from '@/lib/search'
import { getSearchProviderKeys, getSearxngBaseUrl } from './keys'
import type { AtsJob, AtsProvider, AtsProviderId } from '../ats/types'
import { detectFromUrl } from '../ats/detect'
import { greenhouse } from '../ats/greenhouse'
import { lever } from '../ats/lever'
import { ashby } from '../ats/ashby'
import type { JobLead } from '../sources/types'
import type { Targeting } from '../targeting'
import type { RoleIntentDef } from '../jobs/role-taxonomy'
import { employerDomainFromUrl } from '../sources/util'

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/** The real ATS board hosts search queries are scoped to via `site:`. */
export const ATS_SEARCH_SITES = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
] as const

/** Cap the OR'd title terms per query — a search engine query string has a
 *  practical length limit, and beyond ~6 phrases the extra terms add noise,
 *  not precision. */
const MAX_TITLE_TERMS_PER_QUERY = 6

function quoteTerm(term: string): string {
  const t = term.trim()
  if (!t) return ''
  return t.includes(' ') ? `"${t}"` : t
}

/** Title terms to search with: the resolved intent's precise titleKeywords
 *  (never adjacentKeywords — search precision matters more here than for the
 *  keyword-scored aggregator path, since nothing rescoring the hit exists
 *  before verification), or the raw free-text query as a single term when no
 *  intent resolved. Empty when there is truly nothing to search for. */
export function roleTermsForSearch(intent: RoleIntentDef | null, fallbackQuery: string | undefined): string[] {
  if (intent) return intent.titleKeywords.slice(0, MAX_TITLE_TERMS_PER_QUERY)
  const q = (fallbackQuery ?? '').trim()
  return q ? [q] : []
}

/**
 * Build one `site:`-scoped query per known ATS host — mirrors career-ops's
 * portals.yml search_queries pattern. Returns [] when there are no role terms
 * to search with (no resolved intent AND no free-text query) — callers must
 * treat that as "nothing to search", not run an unscoped query.
 */
export function buildSearchQueries(
  intent: RoleIntentDef | null,
  fallbackQuery: string | undefined,
  targeting: Targeting
): string[] {
  const terms = roleTermsForSearch(intent, fallbackQuery)
  if (terms.length === 0) return []
  const titleClause = terms.map(quoteTerm).filter(Boolean).join(' OR ')
  if (!titleClause) return []
  // Only `remote` is used as a location signal — ISO country codes
  // (Targeting.countries) don't work as free-text search terms and this
  // module doesn't own a second geography-name lookup; countries are still
  // enforced downstream the same way every other source's leads are (see
  // sourcer.ts, which runs these leads through the same targeting filters).
  const locationClause = targeting.remoteOnly ? ' remote' : ''
  return ATS_SEARCH_SITES.map((site) => `site:${site} ${titleClause}${locationClause}`.trim())
}

// ---------------------------------------------------------------------------
// ATS-host verification (reuses the real adapters)
// ---------------------------------------------------------------------------

const ATS_PROVIDERS: Record<AtsProviderId, AtsProvider> = { greenhouse, lever, ashby }

/** Strip query string/hash/trailing slash so URL variants of the same
 *  posting compare equal (a search result's URL and the ATS API's own
 *  `url`/`absolute_url` sometimes differ by tracking params only). */
export function normalizeJobUrl(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    const s = u.toString()
    return s.endsWith('/') ? s.slice(0, -1) : s
  } catch {
    return url.trim()
  }
}

interface AtsResolution {
  provider: AtsProviderId
  token: string
}

/** Pure URL-based detection (no network) — reuses lib/ats/detect.ts's
 *  provider.detect() across greenhouse/lever/ashby, same as board discovery
 *  does for a company's careers URL, just applied to a single job URL (the
 *  board token is the URL's first path segment either way). */
function resolveAtsHit(url: string): AtsResolution | null {
  const hit = detectFromUrl({ careerUrl: url, domain: null })
  return hit ? { provider: hit.provider, token: hit.token } : null
}

/** Fetch a board at most once per call, cached across hits that share a
 *  token (one search pass commonly turns up several postings from the same
 *  employer). `null` means the fetch itself failed — cached too, so a flaky
 *  board isn't retried per-hit within one discovery call. */
async function fetchBoardCached(
  cache: Map<string, AtsJob[] | null>,
  provider: AtsProviderId,
  token: string
): Promise<AtsJob[] | null> {
  const key = `${provider}:${token}`
  if (cache.has(key)) return cache.get(key) ?? null
  try {
    const jobs = await ATS_PROVIDERS[provider].fetch(token)
    cache.set(key, jobs)
    return jobs
  } catch {
    cache.set(key, null)
    return null
  }
}

// ---------------------------------------------------------------------------
// Company-name inference
// ---------------------------------------------------------------------------
//
// Neither the ATS APIs nor a liveness fetch reliably hand back a clean
// employer display name (the greenhouse/lever/ashby posting APIs don't return
// one at all — this module is discovering a company Cello has never tracked,
// unlike lib/ats/index.ts's refreshCompany() which already knows it). Best
// effort, in order of preference: an "... at Company" phrase in the search
// result's own title/snippet (how job search results are conventionally
// worded), else a titleized version of the board token / hostname. Callers
// downstream (lib/sources/index.ts ingestLeads) already create every
// aggregator-discovered company as a `suggested` row, never fully-tracked
// sight unseen — the same honest-guess handling applies here.

const AT_COMPANY_RE = /\bat\s+([A-Z][\w&.,''’·\- ]{1,60})/

function titleizeToken(token: string): string {
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

function deriveCompanyName(hit: SearchResult, fallbackLabel: string): string {
  const m = hit.title.match(AT_COMPANY_RE) ?? hit.snippet.match(AT_COMPANY_RE)
  if (m) {
    const name = m[1].replace(/\s*[|\-–—].*$/, '').trim()
    if (name.length >= 2) return name
  }
  return titleizeToken(fallbackLabel)
}

function leadFromAtsJob(job: AtsJob, provider: AtsProviderId, token: string, hit: SearchResult): JobLead {
  return {
    company: deriveCompanyName(hit, token),
    title: job.title,
    url: job.url,
    location: job.location ?? null,
    salary: job.salary ?? null,
    description: job.description ?? '',
    source: 'web_search',
    externalId: job.url,
    companyDomain: null,
    postedAt: job.postedAt ?? null,
    tags: ['web_search', `ats:${provider}`],
  }
}

// ---------------------------------------------------------------------------
// Generic liveness fallback (non-ATS-host hits)
// ---------------------------------------------------------------------------

const LIVENESS_TIMEOUT_MS = 8_000
const MAX_HTML_CHARS = 300_000
const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

/** Phrasing that reliably means "this posting is not actually open" — a
 *  liveness check that returns 200 with one of these present is a false
 *  positive on status code alone. */
const DEAD_POSTING_PHRASES = [
  'page not found',
  '404 not found',
  'no longer available',
  'no longer accepting applications',
  'this job has expired',
  'position has been filled',
  'job posting has closed',
  'this posting is no longer active',
  'job is no longer accepting',
]

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface LivenessCheck {
  ok: boolean
  title?: string
  reason: string
}

/** Fetch a candidate posting URL and confirm it LOOKS like a real, live job
 *  posting — never throws, never trusts a 200 status alone. This is the
 *  minimum bar the task calls for: "fetch it and confirm it looks like a
 *  posting (has a title, is not a 404/expired page)". */
async function checkLiveness(url: string, signal?: AbortSignal): Promise<LivenessCheck> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported-protocol' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIVENESS_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: combined,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType && !/html|text/i.test(contentType)) {
      return { ok: false, reason: `unexpected-content-type:${contentType}` }
    }
    const html = (await res.text()).slice(0, MAX_HTML_CHARS)
    const titleMatch = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : ''
    if (!title) return { ok: false, reason: 'no-title' }
    const lower = html.toLowerCase()
    if (DEAD_POSTING_PHRASES.some((p) => lower.includes(p))) return { ok: false, reason: 'looks-expired' }
    return { ok: true, title, reason: 'live' }
  } catch (e) {
    return { ok: false, reason: `fetch-error:${errMsg(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

async function leadFromLivenessCheck(hit: SearchResult, signal?: AbortSignal): Promise<JobLead | null> {
  const live = await checkLiveness(hit.url, signal)
  if (!live.ok) return null
  const domain = employerDomainFromUrl(hit.url)
  const fallbackLabel = domain ? domain.split('.')[0] : new URL(hit.url).hostname
  return {
    company: deriveCompanyName(hit, fallbackLabel),
    title: live.title || hit.title,
    url: hit.url,
    location: null,
    salary: null,
    description: hit.snippet ?? '',
    source: 'web_search',
    externalId: hit.url,
    companyDomain: domain,
    postedAt: hit.publishedAt ?? null,
    tags: ['web_search', 'unstructured'],
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface JobDiscoveryOptions {
  /** Resolved role intent (lib/jobs/role-taxonomy.ts), or null for a raw query. */
  intent: RoleIntentDef | null
  /** Free-text fallback when no intent resolved. */
  query?: string
  /** The caller's (possibly already-broadened) targeting; only remoteOnly
   *  currently shapes the query text — see buildSearchQueries. */
  targeting: Targeting
  /** Max verified leads to return. Bounds both queries-considered and the
   *  number of verification fetches this call makes. */
  limit: number
  signal?: AbortSignal
  /**
   * The signed-in user, for the ONLY DB reads this module ever does: resolving
   * every one of their configured BYOK search credentials — tavily/serper/exa
   * (lib/search/keys.ts's getSearchProviderKeys, one combined query) plus
   * searxng (getSearxngBaseUrl, which also carries the deployment-wide
   * SEARXNG_BASE_URL env fallback) — the same profiles.preferences.api_keys
   * slots every other opt-in provider key lives in. Both userId and admin
   * must be present to attempt it; either missing just means "search with
   * whatever webSearch() can do keylessly" — lib/search itself already treats
   * a missing credential as "fall through to the next backend, down to the
   * free duckduckgo", never an error. Resolved ONCE, up front, and forwarded
   * explicitly to every one of the (up to 4) site-scoped queries below so
   * they share a single pair of DB reads instead of re-resolving per query —
   * see discoverJobsViaWebSearch.
   */
  userId?: string
  admin?: SupabaseClient
}

export interface JobDiscoveryResult {
  queries: string[]
  /** Distinct raw hits considered across all queries, after dedup. */
  hits: number
  atsVerified: number
  livenessVerified: number
  dropped: number
  leads: JobLead[]
  /** Which webSearch() backend actually served the queries ('duckduckgo' | 'exa' | ...). */
  backend: string
  reason?: string
  notes: string
}

/** Per-query result cap — modest on purpose; ATS_SEARCH_SITES.length queries
 *  run per call, so this is the per-site fan-out, not the total. */
const MAX_HITS_PER_QUERY = 10
/** Hard ceiling on distinct hits considered for verification in one call —
 *  the "surgical, never a crawl" bound. */
const MAX_HITS_CONSIDERED = 30

/**
 * The final rung of sourcer.ts's broaden-on-empty ladder: search the open web
 * for real postings, verify every hit, and return only what survives.
 * Never throws — a webSearch() failure for one/all queries degrades to an
 * empty, explained result rather than blowing up the caller's sourcing pass.
 */
export async function discoverJobsViaWebSearch(opts: JobDiscoveryOptions): Promise<JobDiscoveryResult> {
  const queries = buildSearchQueries(opts.intent, opts.query, opts.targeting)
  if (queries.length === 0) {
    return {
      queries: [],
      hits: 0,
      atsVerified: 0,
      livenessVerified: 0,
      dropped: 0,
      leads: [],
      backend: 'none',
      notes: 'web_search: skipped (no resolved role intent and no query — nothing to search with)',
    }
  }
  if (opts.limit <= 0) {
    return {
      queries,
      hits: 0,
      atsVerified: 0,
      livenessVerified: 0,
      dropped: 0,
      leads: [],
      backend: 'none',
      notes: 'web_search: skipped (limit already met before this rung)',
    }
  }

  // Resolve EVERY one of this user's configured BYOK search credentials
  // ONCE, up front, so every one of the (up to) 4 site-scoped queries below
  // shares the same resolved credentials instead of a fresh DB round trip
  // each. This is what actually reaches lib/search/index.ts's failover chain
  // (see that module's CHAIN_ORDER) from automated job discovery — previously
  // only an Exa key was ever resolved here, so a user with a Tavily or Serper
  // key configured in Settings got zero benefit during sourcing: the chain
  // silently collapsed to exa-then-duckduckgo every time. Absent/failed
  // resolution is not an error — webSearch() itself falls back further down
  // the chain, to the free keyless DuckDuckGo backend, when nothing resolves.
  let tavilyKey: string | undefined
  let serperKey: string | undefined
  let exaKey: string | undefined
  let searxngUrl: string | undefined
  if (opts.userId && opts.admin) {
    const [providerKeys, resolvedSearxngUrl] = await Promise.all([
      getSearchProviderKeys(opts.admin, opts.userId),
      getSearxngBaseUrl(opts.admin, opts.userId),
    ])
    tavilyKey = providerKeys.tavily
    serperKey = providerKeys.serper
    exaKey = providerKeys.exa
    searxngUrl = resolvedSearxngUrl
  }

  const settled = await Promise.allSettled(
    queries.map((q) =>
      webSearch(q, { limit: MAX_HITS_PER_QUERY, tavilyKey, serperKey, exaKey, searxngUrl, signal: opts.signal })
    )
  )

  let backend = 'none'
  let queryErrors = 0
  const reasons = new Set<string>()
  const seen = new Set<string>()
  const hits: SearchResult[] = []
  outer: for (const r of settled) {
    if (r.status !== 'fulfilled') {
      queryErrors++
      continue
    }
    backend = r.value.backend
    if (r.value.reason) reasons.add(r.value.reason)
    for (const h of r.value.results) {
      if (!h?.url) continue
      const key = normalizeJobUrl(h.url)
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(h)
      if (hits.length >= MAX_HITS_CONSIDERED) break outer
    }
  }

  const boardCache = new Map<string, AtsJob[] | null>()
  const leads: JobLead[] = []
  let atsVerified = 0
  let livenessVerified = 0
  let dropped = 0

  for (const hit of hits) {
    if (leads.length >= opts.limit) break
    const resolved = resolveAtsHit(hit.url)
    if (resolved) {
      const board = await fetchBoardCached(boardCache, resolved.provider, resolved.token)
      const match = board?.find((j) => normalizeJobUrl(j.url) === normalizeJobUrl(hit.url))
      if (match) {
        leads.push(leadFromAtsJob(match, resolved.provider, resolved.token, hit))
        atsVerified++
      } else {
        // A hit on a known ATS host that isn't on that board's CURRENT
        // listing is a stale/closed posting — that's the correct signal to
        // drop it, not a reason to retry via the looser liveness check.
        dropped++
      }
      continue
    }
    const lead = await leadFromLivenessCheck(hit, opts.signal)
    if (lead) {
      leads.push(lead)
      livenessVerified++
    } else {
      dropped++
    }
  }

  const reason = reasons.size > 0 ? [...reasons].join(',') : undefined
  const notes =
    `web_search[backend=${backend}${reason ? ` reason=${reason}` : ''} queries=${queries.length}` +
    (queryErrors > 0 ? ` queryErrors=${queryErrors}` : '') +
    ` hits=${hits.length} atsVerified=${atsVerified} livenessVerified=${livenessVerified} dropped=${dropped} leads=${leads.length}]`

  return { queries, hits: hits.length, atsVerified, livenessVerified, dropped, leads, backend, reason, notes }
}
