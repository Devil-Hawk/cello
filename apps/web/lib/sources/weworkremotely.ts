// We Work Remotely public RSS feed — https://weworkremotely.com/remote-jobs.rss
// Public, keyless, XML. Verified live 2026-07-28: 100 <item> entries across
// 57+ distinct employers. Parsed with `rss-parser` (a mature, widely-used RSS/
// Atom parser) rather than a hand-rolled regex tag extractor — this is the
// one adapter in lib/sources that needs raw text instead of JSON, so it still
// carries its own tiny SSRF-safe text fetch (host allowlist + no-redirect +
// timeout, same properties as lib/ats/http.ts's fetchJson, just returning
// text instead of calling res.json()) to retrieve the feed body before
// handing it to rss-parser — a general XML/RSS parser has no opinion on which
// hosts are safe to fetch from, so that check still has to live here.
//
// Titles are usually "Company: Role"; the URL stays on weworkremotely.com
// (no outbound employer link in the feed), so companyDomain is left null —
// same aggregator-honesty reasoning as remotive.ts.

import Parser from 'rss-parser'
import { assertAllowedHost } from '../ats/http'
import type { JobLead, SourceAdapter, SourceQuery } from './types'
import { rankAndLimit, sanitizeLeads, stripHtml, truncate } from './util'

const HOSTS = new Set(['weworkremotely.com'])
const FEED_URL = 'https://weworkremotely.com/remote-jobs.rss'
const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'
const TIMEOUT_MS = 15_000

async function fetchText(url: string, allowedHosts: ReadonlySet<string>): Promise<string> {
  assertAllowedHost(url, allowedHosts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'error', // no server-side redirects → final host stays weworkremotely.com
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** WWR's feed adds a non-standard `<region>` element rss-parser doesn't know by default. */
interface WwrItem {
  region?: string
}

const rssParser = new Parser<Record<string, never>, WwrItem>({
  customFields: { item: ['region'] },
})

function cleanUrl(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value.trim())
    const host = parsed.hostname.toLowerCase()
    const trusted = host === 'weworkremotely.com' || host.endsWith('.weworkremotely.com')
    return parsed.protocol === 'https:' && trusted ? parsed.href : null
  } catch {
    return null
  }
}

function splitTitle(rawTitle: string, defaultCompany: string): { company: string; title: string } {
  const text = rawTitle.trim()
  const colon = text.indexOf(':')
  if (colon > 0) {
    const company = text.slice(0, colon).trim()
    const title = text.slice(colon + 1).trim()
    if (company && title) return { company, title }
  }
  return { company: defaultCompany, title: text }
}

/** Parse the WWR RSS feed body. Exported for adjacent testing. */
export async function parseWwrFeed(xml: string): Promise<JobLead[]> {
  if (typeof xml !== 'string') return []

  let feed: Parser.Output<WwrItem>
  try {
    feed = await rssParser.parseString(xml)
  } catch {
    // Malformed/unparseable XML degrades to no leads, same as the old
    // regex-based version (which would simply find zero <item> matches)
    // rather than throwing and failing the whole source fan-out.
    return []
  }

  const leads: JobLead[] = []
  for (const item of feed.items ?? []) {
    const url = cleanUrl(item.link)
    if (!url) continue
    const rawTitle = (item.title ?? '').trim()
    if (!rawTitle) continue

    const { company, title } = splitTitle(rawTitle, 'We Work Remotely')
    const region = (item.region ?? '').trim()
    const category = item.categories?.[0]?.trim() ?? ''
    const location = region || category || null
    const pubDate = item.pubDate ?? ''
    const postedAt = pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null

    leads.push({
      company,
      title,
      url,
      location,
      salary: null,
      description: truncate(stripHtml(item.content ?? '')),
      source: 'weworkremotely',
      externalId: url,
      companyDomain: null, // feed link stays on weworkremotely.com — no outbound employer URL
      postedAt,
      tags: [category, region].filter((t): t is string => !!t),
    })
  }
  return leads
}

export const weworkremotely: SourceAdapter = {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    let xml: string
    try {
      xml = await fetchText(FEED_URL, HOSTS)
    } catch {
      return []
    }
    const leads = await parseWwrFeed(xml)
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
