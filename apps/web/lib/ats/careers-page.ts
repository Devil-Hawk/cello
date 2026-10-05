// Reading a company's own careers page for the one thing we need from it: which
// job board it links to or embeds. A branded careers page ("acme.com/careers")
// usually carries a link or script tag pointing at the real board, and that is
// the strongest proof a guessed board is the company's.
//
// The line Cello does not cross applies here: one plain unauthenticated GET per
// page, honest User-Agent, no cookies, no JavaScript, no challenge solving. A
// page that needs more than that is not read, and the answer is null.
//
// Unlike the ATS APIs, this host is whatever the person typed, so every hop goes
// through the SSRF check, only https is followed, redirects must stay on the
// company's own site, and the body is size-capped and never stored.
//
// Uses node:dns (through ../security/untrusted); no client component imports lib/ats.

import { assertSsrfSafe, type SsrfCheckOptions } from '../security/untrusted'
import { CELLO_USER_AGENT } from './http'
import { onCompanyDomain } from './verify'
import type { BoardRef } from './verify'

const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3
const MAX_BYTES = 1_500_000
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

/**
 * Up to MAX_BYTES of the body as text. A heavy page (a careers page with its
 * whole app bundle inline can pass 1.5 MB) is read as far as the cap, not
 * refused: the board link is nearly always in the part that was read.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(total, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset
    if (room <= 0) break
    bytes.set(chunk.byteLength > room ? chunk.subarray(0, room) : chunk, offset)
    offset += Math.min(chunk.byteLength, room)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/**
 * The page's HTML, or null. Never throws. Redirects are followed only within
 * the company's own site (its domain, or the host we started on).
 */
export async function fetchCareersHtml(
  startUrl: string,
  companyDomain: string | null,
  ssrf?: SsrfCheckOptions
): Promise<string | null> {
  try {
    let current = new URL(startUrl)
    if (current.protocol === 'http:') current.protocol = 'https:'
    const startHost = bare(current.hostname)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'https:') return null
      await assertSsrfSafe(current.toString(), ssrf)
      const response = await fetch(current.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': CELLO_USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return null
        const next = new URL(location, current)
        const sameSite = bare(next.hostname) === startHost || onCompanyDomain(next.toString(), companyDomain)
        if (!sameSite) return null
        current = next
        continue
      }
      if (!response.ok) return null
      return await readCapped(response)
    }
    return null
  } catch {
    return null
  }
}
