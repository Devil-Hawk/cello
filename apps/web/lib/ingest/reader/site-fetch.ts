// The one door to a company's own site.
//
// Every request the reader makes to a host a person typed in (a careers page, a
// sitemap, a role page) goes through here, and so does every request to the few
// sites with a known JSON search. What this door does, in order:
//
//   - refuses an address that is not a public https/http one (SSRF guard)
//   - reads the origin's robots.txt once and obeys it (RFC 9309: 4xx = allowed,
//     5xx or no answer = nothing is fetched, reported as unreachable, not as a rule)
//   - says who is asking: CELLO_USER_AGENT, which names Cello and the repository
//   - waits between requests to one host, and stops at a request, byte and time
//     budget per site
//   - follows redirects by hand (4 at most), checking every hop
//   - times out and caps what it reads
//
// It never solves, bypasses or works around anything. A bot check, a login
// wall or a robots.txt rule ends the read of that site with a typed reason.

import robotsParser from 'robots-parser'
import { CELLO_USER_AGENT, assertAllowedHost, fetchJson } from '../../ats/http'
import { assertSsrfSafe, readLimitedText } from '../../security/untrusted'

/**
 * Why a site could not be read. `role_pages`: it lists roles but their pages hold nothing Cello can read without a browser.
 * `render_failed`: the browser step that was to read it crashed or timed out, which says nothing about the site.
 */
export type ReaderReason = 'bot_check' | 'login_required' | 'robots' | 'no_roles' | 'unreachable' | 'reading' | 'budget' | 'role_pages' | 'render_failed'

/** Why Cello stopped reading a site, never carrying the address. */
export class ReaderError extends Error {
  readonly reason: ReaderReason
  constructor(reason: ReaderReason) {
    super(reason)
    this.name = 'ReaderError'
    this.reason = reason
  }
}

export type ReaderMode = 'inline' | 'scheduled'

export interface Budget {
  requests: number
  bytes: number
  ms: number
  /** Minimum gap between two requests to one host. */
  gapMs: number
}

/** What one site may cost per refresh. Inline runs in a request a person waits for; scheduled runs in the background. */
export const BUDGETS: Record<ReaderMode, Budget> = {
  inline: { requests: 25, bytes: 20_000_000, ms: 20_000, gapMs: 300 },
  scheduled: { requests: 120, bytes: 60_000_000, ms: 300_000, gapMs: 1000 },
}

const MAX_HOPS = 4
const MAX_BYTES = 3_000_000
const TIMEOUT_MS = 15_000
/** The token a robots.txt writer addresses us by. */
const ROBOTS_TOKEN = 'cello-job-tracker'

export interface SiteResponse {
  status: number
  ok: boolean
  text: string
  /** The address that answered, after redirects. */
  finalUrl: string
  contentType: string
}

export interface SiteFetcherOptions {
  mode?: ReaderMode
  budget?: Partial<Budget>
  /** Test seams. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  assertSafe?: (url: string) => Promise<void>
}

export interface SiteFetcher {
  mode: ReaderMode
  /** A page or file as text. Throws ReaderError for robots, a bot check, a login wall, an unreachable site or a spent budget. */
  get(url: string, opts?: { accept?: string; follow?: (to: string) => boolean }): Promise<SiteResponse>
  /** A JSON answer from a host in `allowedHosts`, under the same robots, delay and budget rules. */
  json<T>(url: string, opts: { allowedHosts: ReadonlySet<string>; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> }): Promise<T>
  /** Take a turn for a request another client is about to make to `url`: robots.txt, the request budget and the gap between requests. Throws ReaderError. */
  gate(url: string): Promise<void>
  /** Where the first request to `url` redirects, without following it; null when it does not redirect. */
  redirectOf(url: string): Promise<string | null>
  /** Does the site's robots.txt allow this address? */
  allowed(url: string): Promise<boolean>
  /** The sitemaps its robots.txt names. */
  sitemapsOf(origin: string): Promise<string[]>
  spent(): { requests: number; bytes: number }
}

const CHALLENGE = /just a moment|cf-chl|challenge-platform|captcha|attention required|access denied|verify you are (a )?human|px-captcha/i
/** Is this page a bot check (a challenge page the browser was given), not the site? A small page that says so, or a title that says so. */
export function looksLikeChallenge(html: string): boolean {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? ''
  return /just a moment|attention required|access denied|verify you are (a )?human|are you a robot/i.test(title) || (html.length < 30_000 && CHALLENGE.test(html))
}
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sso|auth)(\/|$|\?)/i

/** Up to `max` bytes as text. A heavy page is read as far as the cap, not refused: its links are nearly always in the part that was read. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return (await res.text()).slice(0, max)
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(total, max))
  let offset = 0
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset
    if (room <= 0) break
    bytes.set(chunk.byteLength > room ? chunk.subarray(0, room) : chunk, offset)
    offset += Math.min(chunk.byteLength, room)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** `unreachable`: robots.txt could not be read (no such host, a timeout, a 5xx), so Cello does not read the site, but says that, not that a rule forbids it. */
type Robots = ReturnType<typeof robotsParser> | 'allow' | 'unreachable'

export function makeSiteFetcher(options: SiteFetcherOptions = {}): SiteFetcher {
  const mode = options.mode ?? 'inline'
  const budget: Budget = { ...BUDGETS[mode], ...options.budget }
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? Date.now
  const safe = options.assertSafe ?? assertSsrfSafe
  const startedAt = now()
  const used = { requests: 0, bytes: 0 }
  const lastByHost = new Map<string, number>()
  const chains = new Map<string, Promise<void>>()
  const robotsByOrigin = new Map<string, Promise<Robots>>()

  const doFetch = (url: string, init: RequestInit) => (options.fetchImpl ?? globalThis.fetch)(url, init)

  function spend(): void {
    if (used.requests >= budget.requests || used.bytes >= budget.bytes || now() - startedAt >= budget.ms) {
      throw new ReaderError('budget')
    }
    used.requests++
  }

  /** Wait our turn for this host: requests to one host are at least gapMs apart, in order. */
  function politely(host: string): Promise<void> {
    const prev = chains.get(host) ?? Promise.resolve()
    const mine = prev.then(async () => {
      const wait = (lastByHost.get(host) ?? -Infinity) + budget.gapMs - now()
      if (wait > 0) await sleep(wait)
      lastByHost.set(host, now())
    })
    chains.set(host, mine.catch(() => undefined))
    return mine
  }

  async function plain(url: string, accept: string): Promise<Response> {
    await safe(url)
    return doFetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': CELLO_USER_AGENT, accept },
    })
  }

  async function loadRobots(origin: string): Promise<Robots> {
    const url = `${origin}/robots.txt`
    try {
      spend()
      await politely(new URL(origin).host)
      let res = await plain(url, 'text/plain')
      // A site may send robots.txt through a redirect on its own host (www or not).
      for (let hop = 0; hop < MAX_HOPS && res.status >= 300 && res.status < 400; hop++) {
        const to = res.headers.get('location')
        if (!to) break
        const next = new URL(to, url)
        if (next.protocol !== 'https:' && next.protocol !== 'http:') break
        res = await plain(next.toString(), 'text/plain')
      }
      if (res.status >= 500) return 'unreachable'
      if (res.status >= 400 || res.status >= 300) return 'allow'
      // A redirect that lands on a web page (a site that sends /robots.txt to its home page) means there is no robots file.
      if (/html/i.test(res.headers.get('content-type') ?? '')) return 'allow'
      const text = await readLimitedText(res, 500_000)
      used.bytes += text.length
      return robotsParser(url, text)
    } catch (error) {
      if (error instanceof ReaderError && error.reason === 'budget') throw error
      return 'unreachable'
    }
  }

  function robotsFor(url: string): Promise<Robots> {
    const origin = new URL(url).origin
    let entry = robotsByOrigin.get(origin)
    if (!entry) {
      entry = loadRobots(origin)
      robotsByOrigin.set(origin, entry)
      // A budget stop is not a verdict on the site: ask again next time.
      entry.catch(() => robotsByOrigin.delete(origin))
    }
    return entry
  }

  /** Why this address may not be fetched: a robots.txt rule that disallows it, or robots.txt that could not be read (RFC 9309: then nothing is fetched). Null when allowed. */
  async function refusal(url: string): Promise<'robots' | 'unreachable' | null> {
    const robots = await robotsFor(url)
    if (robots === 'allow') return null
    if (robots === 'unreachable') return 'unreachable'
    return robots.isAllowed(url, ROBOTS_TOKEN) === false ? 'robots' : null
  }

  async function allowed(url: string): Promise<boolean> {
    return (await refusal(url)) === null
  }

  async function mustBeAllowed(url: string): Promise<void> {
    const why = await refusal(url)
    if (why) throw new ReaderError(why)
  }

  function classify(res: { status: number }, body: string, finalUrl: string): void {
    if (res.status === 401 || LOGIN_PATH.test(new URL(finalUrl).pathname)) throw new ReaderError('login_required')
    if ((res.status === 403 || res.status === 503 || res.status === 429) && CHALLENGE.test(body)) throw new ReaderError('bot_check')
    if (res.status === 403) throw new ReaderError('bot_check')
  }

  const api: SiteFetcher = {
    mode,
    allowed,
    spent: () => ({ ...used }),

    async sitemapsOf(origin) {
      const robots = await robotsFor(`${origin}/`)
      if (robots === 'allow' || robots === 'unreachable') return []
      return robots.getSitemaps()
    },

    async get(url, opts = {}) {
      let current = url
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        await mustBeAllowed(current)
        spend()
        await politely(new URL(current).host)
        let res: Response
        try {
          res = await plain(current, opts.accept ?? 'text/html,application/xhtml+xml')
        } catch (error) {
          if (error instanceof ReaderError) throw error
          throw new ReaderError('unreachable')
        }
        if (res.status >= 300 && res.status < 400) {
          const to = res.headers.get('location')
          if (!to) throw new ReaderError('unreachable')
          const next = new URL(to, current).toString()
          // The caller may keep a read on one site: a hop elsewhere is not followed.
          if (opts.follow && !opts.follow(next)) throw new ReaderError('unreachable')
          current = next
          if (LOGIN_PATH.test(new URL(current).pathname)) throw new ReaderError('login_required')
          continue
        }
        let text = ''
        try {
          text = await readCapped(res, MAX_BYTES)
        } catch {
          throw new ReaderError('unreachable')
        }
        used.bytes += text.length
        classify(res, text, current)
        if (res.status === 429 || res.status >= 500) throw new ReaderError('unreachable')
        return { status: res.status, ok: res.ok, text, finalUrl: current, contentType: res.headers.get('content-type') ?? '' }
      }
      throw new ReaderError('unreachable')
    },

    async gate(url) {
      await mustBeAllowed(url)
      spend()
      await politely(new URL(url).host)
    },

    async redirectOf(url) {
      await mustBeAllowed(url)
      spend()
      await politely(new URL(url).host)
      try {
        const res = await plain(url, 'text/html')
        if (res.status >= 300 && res.status < 400) {
          const to = res.headers.get('location')
          return to ? new URL(to, url).toString() : null
        }
        return null
      } catch (error) {
        if (error instanceof ReaderError) throw error
        return null
      }
    },

    async json<T>(url: string, opts: { allowedHosts: ReadonlySet<string>; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> }) {
      assertAllowedHost(url, opts.allowedHosts)
      await mustBeAllowed(url)
      spend()
      await politely(new URL(url).host)
      try {
        return await fetchJson<T>(url, { method: opts.method, body: opts.body, headers: opts.headers, retries: 1, sleep })
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 401) throw new ReaderError('login_required')
        if (status === 403) throw new ReaderError('bot_check')
        throw new ReaderError('unreachable')
      }
    },
  }
  return api
}

/**
 * The items whose address robots.txt allows. The answer for a site is read once and cached, so
 * this costs no extra request: one disallowed address among many is dropped, not a verdict on the site.
 */
export async function allowedOnly<T>(f: SiteFetcher, items: T[], urlOf: (item: T) => string): Promise<T[]> {
  const keep: T[] = []
  for (const item of items) {
    try {
      if (await f.allowed(urlOf(item))) keep.push(item)
    } catch (error) {
      if (error instanceof ReaderError && error.reason === 'budget') throw error
      // an address that is not a url cannot be fetched either
    }
  }
  return keep
}
