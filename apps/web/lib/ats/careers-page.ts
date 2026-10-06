// Reading a company's own careers page for the one thing we need from it: which
// job board it links to or embeds. A branded careers page ("acme.com/careers")
// usually carries a link or script tag pointing at the real board, and that is
// the strongest proof a guessed board is the company's.
//
// The line Cello does not cross applies here: one plain unauthenticated GET per
// page, through the site fetcher (robots.txt obeyed, Cello user agent, request
// budget and delay), no cookies, no JavaScript, no challenge solving. A page that
// needs more than that, or that robots.txt disallows, is not read: the answer is null.
//
// Unlike the ATS APIs, this host is whatever the person typed, so every hop goes
// through the SSRF check, only https is followed, redirects must stay on the
// company's own site, and the body is size-capped and never stored.
//
// Uses node:dns (through ../security/untrusted); no client component imports lib/ats.

import { makeSiteFetcher, type SiteFetcher } from '../ingest/reader/site-fetch'
import { onCompanyDomain } from './verify'
import type { BoardRef } from './verify'

/** More boards than this on one page is a directory or portfolio, not "their" board. */
const MAX_BOARDS_PER_PAGE = 3

const URL_RE = /https?:\/\/[^\s"'<>\\)\]}]+/gi

/** Provider boards a page links to or embeds, at most MAX_BOARDS_PER_PAGE distinct ones. */
export function findBoardLinks(
  html: string,
  detect: (url: string) => BoardRef | null
): BoardRef[] {
  // Script bundles carry URLs as https:\/\/host\/path or with /.
  const text = html
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
  const seen = new Map<string, BoardRef>()
  for (const match of text.matchAll(URL_RE)) {
    const hit = detect(match[0].replace(/[.,;]+$/, ''))
    if (!hit) continue
    const key = `${hit.provider}:${hit.token.toLowerCase()}`
    if (!seen.has(key)) seen.set(key, { provider: hit.provider, token: hit.token })
  }
  return seen.size > MAX_BOARDS_PER_PAGE ? [] : [...seen.values()]
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/**
 * The page's HTML, or null. Never throws. Every request goes through the site
 * fetcher, so robots.txt, the Cello user agent, the delay and the request
 * budget apply, and every hop is checked for a public address. Redirects are
 * followed only within the company's own site (its domain, or the host we
 * started on). Pass one fetcher for all the pages of a read so they share its
 * budget and its robots.txt answer.
 */
export async function fetchCareersHtml(
  startUrl: string,
  companyDomain: string | null,
  fetcher: SiteFetcher = makeSiteFetcher({ mode: 'inline' })
): Promise<string | null> {
  try {
    const start = new URL(startUrl)
    if (start.protocol === 'http:') start.protocol = 'https:'
    if (start.protocol !== 'https:') return null
    const startHost = bare(start.hostname)
    const res = await fetcher.get(start.toString(), {
      accept: 'text/html',
      follow: (to) => {
        const next = new URL(to)
        return next.protocol === 'https:' && (bare(next.hostname) === startHost || onCompanyDomain(to, companyDomain))
      },
    })
    return res.ok ? res.text : null
  } catch {
    return null
  }
}
