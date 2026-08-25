// Keyless, FREE, public-source fetchers for the company dossier.
//
// Every fetch is host-allowlisted (SSRF-safe) and never follows redirects.
// Sources used, all public and free:
//   - Wikipedia REST summary (en.wikipedia.org)         -> company overview
//   - HN Algolia search (hn.algolia.com)                -> recent public news
//   - GitHub orgs API (api.github.com)                  -> public org profile
//   - the company's OWN domain (home / /about / /careers) -> first-party text
//
// NO logins, NO LinkedIn, NO paid vendors, NO scraping behind auth walls.
// JSON endpoints go through getJson() (which reuses the retry/timeout transport
// and blocks redirects). The company's own pages are HTML, so they use a small
// guarded text fetch that reuses the SAME host-allowlist guard (assertAllowedHost)
// plus redirect:'error' + https-only.

import { getJson, stripHtml, truncate } from '@/lib/sources/util'
import { assertAllowedHost } from '@/lib/ats/http'
import type { SourceMatchReason, SourceRef } from './store'

const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

export interface NewsItem {
  title: string
  url: string
  points?: number
  date?: string
  /** Why this story earned a place in the dossier — see SourceMatchReason. */
  matchedBy: 'domain' | 'exact-title'
}

export interface GithubOrgInfo {
  login?: string
  description?: string | null
  publicRepos?: number
  followers?: number
  blog?: string | null
  location?: string | null
}

export interface PublicSignals {
  wikipediaSummary?: string
  wikipediaUrl?: string
  news: NewsItem[]
  github?: GithubOrgInfo
  homeText?: string
  aboutText?: string
  careersText?: string
  sources: SourceRef[]
}

/** Normalize a stored domain to a bare hostname (no scheme, no www, no path). */
export function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  let host = domain.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}

/** Escape a string for safe interpolation into a RegExp source string. */
/**
 * True when `after` is the same site as `before`, ignoring a leading "www.".
 *
 * Used to bound redirect following: the apex -> www hop is legitimate and very
 * common, but a hop to an unrelated host (open redirect, parked domain, link
 * shortener) must not be treated as the company's own page.
 */
function sameSite(before: string, after: string): boolean {
  try {
    const a = new URL(before).hostname.replace(/^www\./, '').toLowerCase()
    const b = new URL(after).hostname.replace(/^www\./, '').toLowerCase()
    return a === b
  } catch {
    return false
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive, WORD-BOUNDARY match of `phrase` — "Distyl" must match the
 * word "Distyl" and NOT match inside "Distill"/"distilling"/"distillation".
 * This is a real regex check, never a substring test, and it is applied on
 * top of any API-level "exact" flags (never trusted alone — see fetchHackerNews).
 */
function wordBoundaryRe(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(phrase.trim())}\\b`, 'i')
}

/** Loose signal that a block of text describes an organization, not a person/place/other topic. */
const ORG_HINT_RE =
  /\b(compan(?:y|ies)|corporation|corp\.?|business(?:es)?|start-?up|organi[sz]ation|firm|enterprise|manufacturer|non-?profit|agency|bank|airline|retailer|publisher|studio|platform|software|technology|app(?:lication)?|service provider|subsidiary|brand|marketplace|fintech|saas)\b/i

/** Signals the page is about something else entirely (a person, place, work, or concept). */
const NON_ORG_HINT_RE =
  /\b(surname|given name|village|town|city in|river|mountain|island|album|film|movie|song|novel|book by|actor|actress|footballer|politician|athlete|singer|musician|born in \d{4}|genus|species|inclined plane|theorem|automated theorem proving|topics referred to)\b/i

/** Heuristic: does this description/extract read like an organization rather than an unrelated subject? */
function looksLikeOrganization(text: string): boolean {
  if (!text) return false
  return ORG_HINT_RE.test(text) && !NON_ORG_HINT_RE.test(text)
}

/** HTML/text fetch that reuses the JSON transport's SSRF guard + no-redirect policy. */
async function fetchHtml(
  url: string,
  allowedHosts: ReadonlySet<string>,
  timeoutMs = 10_000
): Promise<string | null> {
  try {
    assertAllowedHost(url, allowedHosts)
  } catch {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain' },
      // Follow redirects. This was `redirect: 'error'`, which threw on the
      // extremely common apex -> www hop (distyl.ai 308s to www.distyl.ai), so
      // every page fetch for such a company returned null, leaving the dossier
      // with no text to summarize and reporting "no signals" for a company
      // whose site was perfectly reachable.
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) return null
    // Only trust a redirect that stayed on the same registrable domain, so an
    // open redirect or a parked-domain hop can't inject third-party content.
    if (!sameSite(url, res.url)) return null
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (ct && !/text\/html|application\/xhtml|text\/plain|xml/.test(ct)) return null
    const raw = await res.text()
    const text = truncate(stripHtml(raw), 4000)
    return text || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface WikipediaSummary {
  title?: string
  description?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
  type?: string
}

/**
 * Wikipedia REST page summary for the company name — but ONLY returned when
 * it's verifiably about this company. A page surviving the exact-title REST
 * lookup is not enough proof: common one-word company names (e.g. "Ramp",
 * "Rippling") frequently land on a "standard" (non-disambiguation) page about
 * something else entirely (an inclined plane; a theorem-proving heuristic).
 * Corroboration required, in order of strength:
 *   1. the page text mentions the company's own domain, OR
 *   2. the returned page TITLE contains the company name at a word boundary
 *      AND the description/extract reads like an organization, not an
 *      unrelated person/place/concept.
 * Any other outcome (disambiguation, no corroboration, fetch failure) returns
 * undefined — a missing summary is correct; a wrong one is not.
 */
export async function fetchWikipedia(
  name: string,
  domain?: string | null
): Promise<{ summary: string; url: string } | undefined> {
  const trimmedName = name.trim()
  const title = encodeURIComponent(trimmedName.replace(/\s+/g, '_'))
  if (!title) return undefined
  try {
    const data = await getJson<WikipediaSummary>(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
      new Set(['en.wikipedia.org'])
    )
    // Disambiguation pages are noise, not an overview.
    if (!data || data.type === 'disambiguation') return undefined
    const summary = stripHtml(data.extract ?? '')
    if (!summary) return undefined

    const host = normalizeDomain(domain)
    const domainMentioned = Boolean(host) && summary.toLowerCase().includes(host!.toLowerCase())
    const titleMatchesName = wordBoundaryRe(trimmedName).test(data.title ?? '')
    const orgLike = looksLikeOrganization(`${data.description ?? ''} ${summary}`)
    if (!domainMentioned && !(titleMatchesName && orgLike)) return undefined

    const url =
      data.content_urls?.desktop?.page ||
      `https://en.wikipedia.org/wiki/${title}`
    return { summary: truncate(summary, 1500), url }
  } catch {
    return undefined
  }
}

interface HnHit {
  title?: string
  url?: string
  points?: number
  created_at?: string
  objectID?: string
}
interface HnResponse {
  hits?: HnHit[]
}

// Over-fetch raw candidates from Algolia before strict post-filtering — most
// full-text hits will be dropped, so asking for exactly `limit` would starve
// the filter and under-report real matches.
const HN_CANDIDATE_POOL = 20

function hnItemFromHit(h: HnHit, matchedBy: NewsItem['matchedBy']): NewsItem | null {
  const title = (h.title ?? '').trim()
  if (!title) return null
  const url = h.url && /^https?:\/\//.test(h.url)
    ? h.url
    : `https://news.ycombinator.com/item?id=${h.objectID}`
  return {
    title: truncate(title, 160),
    url,
    points: typeof h.points === 'number' ? h.points : undefined,
    date: h.created_at,
    matchedBy,
  }
}

/**
 * STRONGEST signal: a story whose own URL host is the company's domain (or a
 * subdomain of it) — e.g. a Show HN linking to distyl.ai, or a company blog
 * post at stripe.com/blog/... . Restricted to the url field server-side, and
 * ALWAYS re-verified client-side by parsing the returned URL's hostname —
 * the API flag alone is not trusted.
 */
async function fetchHnByDomain(domain: string, limit: number): Promise<NewsItem[]> {
  try {
    const data = await getJson<HnResponse>(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}` +
        `&tags=story&restrictSearchableAttributes=url&hitsPerPage=${HN_CANDIDATE_POOL}`,
      new Set(['hn.algolia.com'])
    )
    const out: NewsItem[] = []
    for (const h of data?.hits ?? []) {
      if (out.length >= limit) break
      if (!h.url) continue
      let host: string
      try {
        host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, '')
      } catch {
        continue
      }
      if (host !== domain && !host.endsWith(`.${domain}`)) continue
      const item = hnItemFromHit(h, 'domain')
      if (item) out.push(item)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Fallback signal: a story whose TITLE contains an EXACT, case-insensitive,
 * word-boundary match of the company name — "Distyl" must not match
 * "Distill"/"distilling"/"distillation". Typo tolerance is disabled and the
 * query is sent as a quoted phrase server-side, but that alone is not
 * trusted either: every hit is re-checked with the same word-boundary regex
 * used for Wikipedia title verification.
 */
async function fetchHnByExactTitle(name: string, limit: number): Promise<NewsItem[]> {
  try {
    const data = await getJson<HnResponse>(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(`"${name}"`)}` +
        `&tags=story&typoTolerance=false&advancedSyntax=true&hitsPerPage=${HN_CANDIDATE_POOL}`,
      new Set(['hn.algolia.com'])
    )
    const re = wordBoundaryRe(name)
    const out: NewsItem[] = []
    for (const h of data?.hits ?? []) {
      if (out.length >= limit) break
      if (!re.test(h.title ?? '')) continue
      const item = hnItemFromHit(h, 'exact-title')
      if (item) out.push(item)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Recent HN stories that have EARNED relevance to the company. Relevance is
 * decided in two passes, strongest signal first:
 *   1. domain match — the story's own URL is on the company's domain.
 *   2. exact-title match — the story title contains the company name at a
 *      word boundary (fuzzy/stemmed Algolia hits are rejected).
 * Anything matching neither is dropped. Returning FEWER, correct items is the
 * goal: an empty array is a correct answer and must never be padded with
 * unrelated filler.
 */
export async function fetchHackerNews(
  name: string,
  domain?: string | null,
  limit = 5
): Promise<NewsItem[]> {
  const trimmedName = name.trim()
  if (!trimmedName) return []
  const host = normalizeDomain(domain)

  const out: NewsItem[] = []
  const seen = new Set<string>()
  const merge = (items: NewsItem[]) => {
    for (const item of items) {
      if (out.length >= limit) break
      if (seen.has(item.url)) continue
      seen.add(item.url)
      out.push(item)
    }
  }

  if (host) merge(await fetchHnByDomain(host, limit))
  if (out.length < limit) merge(await fetchHnByExactTitle(trimmedName, limit - out.length))
  return out
}

interface GithubOrgResponse {
  login?: string
  description?: string | null
  public_repos?: number
  followers?: number
  blog?: string | null
  location?: string | null
}

/** Public GitHub org profile (optional — many companies have none). */
export async function fetchGithubOrg(slug: string): Promise<GithubOrgInfo | undefined> {
  const clean = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!clean) return undefined
  try {
    const data = await getJson<GithubOrgResponse>(
      `https://api.github.com/orgs/${clean}`,
      new Set(['api.github.com'])
    )
    if (!data?.login) return undefined
    return {
      login: data.login,
      description: data.description ?? null,
      publicRepos: typeof data.public_repos === 'number' ? data.public_repos : undefined,
      followers: typeof data.followers === 'number' ? data.followers : undefined,
      blog: data.blog ?? null,
      location: data.location ?? null,
    }
  } catch {
    return undefined
  }
}

export interface CompanyPageText {
  homeText?: string
  aboutText?: string
  careersText?: string
}

/** First-party text from the company's own home / about / careers pages. */
export async function fetchCompanyPages(domain: string): Promise<CompanyPageText> {
  const host = normalizeDomain(domain)
  if (!host) return {}
  // Exactly the company's own domain (bare + www variant) — nothing else.
  const allow = new Set([host, `www.${host}`])
  const base = `https://${host}`
  const [homeText, aboutText, careersText] = await Promise.all([
    fetchHtml(base, allow),
    fetchHtml(`${base}/about`, allow),
    fetchHtml(`${base}/careers`, allow),
  ])
  return {
    homeText: homeText ?? undefined,
    aboutText: aboutText ?? undefined,
    careersText: careersText ?? undefined,
  }
}

/** Derive a plausible GitHub org slug from a company name / domain. */
function githubSlugCandidate(name: string, domain: string | null): string | null {
  const host = normalizeDomain(domain)
  if (host) {
    const label = host.split('.')[0]
    if (label && label !== 'www') return label
  }
  const fromName = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  return fromName || null
}

/**
 * Run every free public fetch in parallel and aggregate into one PublicSignals
 * bundle plus a de-duplicated `sources[]` list for attribution.
 */
export async function collectPublicSignals(company: {
  name: string
  domain: string | null
}): Promise<PublicSignals> {
  const host = normalizeDomain(company.domain)
  const slug = githubSlugCandidate(company.name, company.domain)

  const [wiki, news, github, pages] = await Promise.all([
    fetchWikipedia(company.name, company.domain),
    fetchHackerNews(company.name, company.domain),
    slug ? fetchGithubOrg(slug) : Promise.resolve(undefined),
    host ? fetchCompanyPages(host) : Promise.resolve({} as CompanyPageText),
  ])

  const sources: SourceRef[] = []
  const seen = new Set<string>()
  const addSource = (title: string, url: string, matchedBy: SourceMatchReason) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    sources.push({ title, url, matchedBy })
  }

  if (wiki) addSource('Wikipedia', wiki.url, 'wikipedia')
  if (host) addSource(`${company.name} — official site`, `https://${host}`, 'official-site')
  if (pages.careersText) addSource(`${company.name} — careers`, `https://${host}/careers`, 'careers')
  if (github?.login) addSource('GitHub', `https://github.com/${github.login}`, 'github')
  for (const n of news) addSource(n.title, n.url, n.matchedBy)

  return {
    wikipediaSummary: wiki?.summary,
    wikipediaUrl: wiki?.url,
    news,
    github,
    homeText: pages.homeText,
    aboutText: pages.aboutText,
    careersText: pages.careersText,
    sources,
  }
}
