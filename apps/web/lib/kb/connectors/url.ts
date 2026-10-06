// "url" connector — fetch one page, extract its readable text, chunk + index.
//
// SAFETY:
//   - timeout-bounded (FETCH_TIMEOUT_MS)
//   - http/https only; the host is resolved and every address checked before
//     the request AND before every redirect hop (lib/security/untrusted.ts
//     checkSsrf), so a name that points at a private address is refused, not
//     just a literal one
//   - caps the response body it reads (MAX_BODY_BYTES)
//   - SAME-SITE REDIRECT DISCIPLINE: redirects are followed by hand, at most
//     MAX_REDIRECTS hops, and every hop must stay on the same registrable host
//     as the one the user configured - an apex<->www hop is allowed, a hop to
//     an unrelated host is refused rather than silently indexed. Mirrors
//     lib/dossier/sources.ts's sameSite() discipline for the company-page fetch.
//
// No API key needed — this is a plain unauthenticated GET, same as a browser
// loading a public page.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSsrf, type SsrfCheckOptions } from '../../security/untrusted'
import { upsertDocument } from '../store'
import type { KbSource } from '../types'
import type { KbSyncOutcome } from './types'

const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'
const FETCH_TIMEOUT_MS = 10_000
/** 3MB cap — plenty for a text-heavy page, cheap to hold in memory. */
const MAX_BODY_BYTES = 3_000_000

const MAX_REDIRECTS = 5

function sameRegistrableHost(a: string, b: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/^www\./, '')
  try {
    return norm(new URL(a).hostname) === norm(new URL(b).hostname)
  } catch {
    return false
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    const key = code.toLowerCase()
    if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key]
    if (key.startsWith('#x')) {
      const n = parseInt(key.slice(2), 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    if (key.startsWith('#')) {
      const n = parseInt(key.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    return whole
  })
}

/**
 * Strip script/style/head noise, turn block-level tags into paragraph breaks
 * (so the chunker's blank-line paragraph splitter has something to work
 * with), drop every remaining tag, then decode entities and collapse
 * whitespace. Deliberately simpler than a real readability algorithm — good
 * enough for "index this article/docs page", not a general-purpose scraper.
 */
function extractReadableText(html: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?\s*>/gi, '\n')
    .replace(/<\s*(p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  body = decodeEntities(body)
  return body
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return title || null
}

export async function syncUrlSource(
  client: SupabaseClient,
  userId: string,
  source: KbSource,
  deps: SsrfCheckOptions = {}
): Promise<KbSyncOutcome> {
  const url = typeof source.config?.url === 'string' ? source.config.url.trim() : ''
  if (!url) return { status: 'disabled', message: 'No URL configured for this source yet.' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { status: 'error', message: `Not a valid URL: ${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'error', message: 'Only http/https URLs are supported.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let target = url
    let res: Response
    for (let hop = 0; ; hop++) {
      const safe = await checkSsrf(target, deps)
      if (!safe.ok) {
        const isPrivate = safe.reason === 'blocked_address' || safe.reason === 'blocked_hostname'
        return { status: 'error', message: isPrivate ? 'Refusing to fetch a private/internal address.' : safe.message }
      }
      res = await fetch(target, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain' },
        redirect: 'manual',
        signal: controller.signal,
      })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) break
      if (hop >= MAX_REDIRECTS) return { status: 'error', message: 'Too many redirects.' }
      target = new URL(location, target).toString()
      if (!sameRegistrableHost(url, target)) {
        return { status: 'error', message: `Refusing a cross-site redirect (${parsed.hostname} → ${new URL(target).hostname}).` }
      }
    }
    if (!res.ok) {
      return { status: 'error', message: `Fetch failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` }
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType && !/text\/html|application\/xhtml|text\/plain|xml/.test(contentType)) {
      return { status: 'error', message: `Unsupported content type for text extraction: ${contentType.split(';')[0]}` }
    }

    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { status: 'error', message: `Page is too large to index (>${Math.floor(MAX_BODY_BYTES / 1_000_000)}MB).` }
    }
    const html = Buffer.from(buf).toString('utf8')
    const text = extractReadableText(html)
    if (!text || text.length < 20) {
      return { status: 'error', message: 'Could not extract any readable text from this page.' }
    }
    const title = extractTitle(html) || source.label || url

    const { chunkCount } = await upsertDocument(client, {
      userId,
      sourceId: source.id,
      externalId: url,
      title,
      url,
      content: text,
    })

    return {
      status: 'synced',
      documentsWritten: 1,
      chunksWritten: chunkCount,
      message: `Indexed ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} from ${parsed.hostname}.`,
    }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === 'AbortError'
    return {
      status: 'error',
      message: isAbort
        ? `Timed out fetching ${parsed.hostname} after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s.`
        : e instanceof Error
          ? e.message
          : 'Fetch failed',
    }
  } finally {
    clearTimeout(timer)
  }
}
