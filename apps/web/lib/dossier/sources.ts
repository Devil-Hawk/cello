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
import { assertSsrfSafe } from '@/lib/security/untrusted'
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

/** How many redirects to follow before giving up. Apex -> www is one hop; two
 *  more covers http -> https -> www without opening a redirect maze. */
const MAX_REDIRECT_HOPS = 3

/**
 * HTML/text fetch for a company's own site, guarded at every hop.
 *
 * WHY THIS IS NOT JUST `assertAllowedHost` + `fetch`
 *   It used to be, and both halves of that were weaker than they looked.
 *
 *   1. THE ALLOWLIST WAS TAUTOLOGICAL AT THE MAIN CALL SITE.
 *      fetchCompanyPages builds `allow = new Set([host, 'www.' + host])` and
 *      then fetches `https://${host}` — i.e. it checks the URL against a set
 *      derived from that same URL. It can never reject anything. It reads like
 *      a guard and is an assertion that 1 === 1.
 *
 *   2. NOTHING RESOLVED DNS. assertAllowedHost compares hostname STRINGS. A
 *      company domain that resolves to 127.0.0.1, to an RFC1918 address, or to
 *      169.254.169.254 passed every check, because the hostname never changed —
 *      only what it pointed at. And `domain` is not trusted input: it is
 *      derived by employerDomainFromUrl() from scraped job-board data.
 *      normalizeDomain only requires a dot and an alphabetic TLD, so
 *      `metadata.google.internal` satisfies it exactly.
 *
 *   3. REDIRECTS WERE FOLLOWED BLIND. `redirect: 'follow'` was introduced for
 *      the very common apex -> www hop, which was the right problem to fix, but
 *      it moved the trust boundary: the host was validated once on the URL we
 *      chose, and every hop after that went wherever the server said. The
 *      sameSite(url, res.url) check afterwards does catch a cross-domain
 *      landing — but only AFTER the request was issued, and for SSRF the
 *      request IS the damage.
 *
 * WHAT IT DOES NOW
 *   Redirects are followed BY HAND, and every hop — including the first — is
 *   re-validated against both the host allowlist and assertSsrfSafe(), which
 *   resolves the name and refuses loopback, link-local, RFC1918 and cloud
 *   metadata addresses. A hop that fails either check ends the fetch.
 *
 * WHAT IT STILL DOES NOT DO — see lib/security/untrusted.ts's own TOCTOU note.
 *   assertSsrfSafe resolves DNS itself, and the fetch that follows resolves
 *   again independently; nothing in stock fetch pins a connection to the
 *   address just verified. A resolver that answers differently between the two
 *   can still get through. Closing that needs a custom agent with a pinned
 *   address, which is a bigger change than this function. Recorded here rather
 *   than papered over, because a guard whose limits are undocumented is how the
 *   next reader over-trusts it.
 */
async function fetchHtml(
  url: string,
  allowedHosts: ReadonlySet<string>,
  timeoutMs = 10_000,
  // 4000 is what the dossier summarizer wants and must keep getting. Contact
  // sourcing asks for more because the thing it is looking for — a published
  // `careers@` address — lives in the page FOOTER, i.e. exactly the part a
  // 4k truncation throws away.
  maxChars = 4000
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let current = url

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      // Both checks, on EVERY hop. The allowlist keeps us on the company's own
      // site; assertSsrfSafe is the one that looks at where the name actually
      // points, which is the check this function never had.
      try {
        assertAllowedHost(current, allowedHosts)
        await assertSsrfSafe(current)
      } catch {
        return null
      }

      const res = await fetch(current, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain' },
        // Manual, so each hop can be validated before it is taken. The apex ->
        // www case that motivated `follow` still works — it is simply checked.
        redirect: 'manual',
        signal: controller.signal,
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return null
        const next = new URL(location, current).toString()
        // An open redirect off the company's own registrable domain is not
        // something we follow, whatever the allowlist would say about it.
        if (!sameSite(current, next)) return null
        current = next
        continue
      }

      if (!res.ok) return null
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      if (ct && !/text\/html|application\/xhtml|text\/plain|xml/.test(ct)) return null
      const raw = await res.text()
      const text = truncate(stripHtml(raw), maxChars)
      return text || null
    }

    // Ran out of hops.
    return null
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

/** One fetched first-party page, tagged with the URL it came from. */
export interface FetchedPage {
  url: string
  text: string
}

// Pages a company publishes about ITSELF that plausibly name a human or an
// address a candidate may write to. Deliberately short and first-party only:
// every one of these is on the company's own domain, publicly readable, and
// behind no login — the same rule lib/dossier/comp.ts states ("we NEVER scrape
// levels.fyi / Glassdoor / any paid or login-walled vendor").
const CONTACT_PAGE_PATHS = ['', '/about', '/about-us', '/team', '/careers', '/contact']

/**
 * The company's own public pages, each tagged with its URL so a consumer can
 * CITE where a name or address came from.
 *
 * Intentionally a sibling of fetchCompanyPages() rather than a refactor of it:
 * that function's exact three-page shape is what the dossier pipeline
 * (lib/harness/agents/company_researcher.ts) stores and summarizes, and
 * changing it to serve contact sourcing would silently change what every
 * dossier contains. Both share the same guarded fetchHtml above — the SSRF
 * host-allowlist (assertAllowedHost), https-only, same-site-redirect-only and
 * content-type checks all apply here unchanged.
 */
export async function fetchCompanyContactPages(
  domain: string,
  timeoutMs = 6000,
  maxCharsPerPage = 12_000
): Promise<FetchedPage[]> {
  const host = normalizeDomain(domain)
  if (!host) return []
  // Exactly the company's own domain (bare + www variant) — nothing else.
  const allow = new Set([host, `www.${host}`])
  const base = `https://${host}`
  const settled = await Promise.all(
    CONTACT_PAGE_PATHS.map(async (path) => {
      const url = `${base}${path}`
      const text = await fetchHtml(url, allow, timeoutMs, maxCharsPerPage)
      return text ? { url, text } : null
    })
  )
  return settled.filter((p): p is FetchedPage => p !== null)
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
