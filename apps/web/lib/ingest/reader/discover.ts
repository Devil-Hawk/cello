// Find the applicant system behind a company's careers site, through the
// company's own site and nowhere else. Cello never guesses a board by name here:
// a board is a candidate only when the company's own pages point at it, by a
// redirect, a link, an embed, a Greenhouse job-id link or an Eightfold config
// naming the company's own domain. Every candidate is then verified by
// lib/ats/verify.ts before anything is stored (see run.ts).

import * as cheerio from 'cheerio'
import { eightfoldToken } from '../../ats/eightfold'
import { detectFromUrl } from '../../ats/detect'
import { findBoardLinks } from '../../ats/careers-page'
import type { BoardRef } from '../../ats/verify'
import { onCompanyDomain } from '../../ats/verify'
import { ReaderError, type SiteFetcher } from './site-fetch'

export type DiscoveredVia = 'redirect' | 'link' | 'gh_jid' | 'eightfold' | 'posting'

export interface DiscoveredBoard extends BoardRef {
  via: DiscoveredVia
}

export interface PageRead {
  url: string
  html: string
}

export interface Discovery {
  boards: DiscoveredBoard[]
  /** The pages fetched on the way, so later tiers do not ask for them again. */
  pages: PageRead[]
  /** Why the first page could not be read, if it could not. */
  failure?: ReaderError
}

const JOB_WORDS = /job|career|opening|position|vacanc|role|work-with|join/i
const MAX_SIDE_PAGES = 2

const detect = (url: string) => detectFromUrl({ careerUrl: url, domain: null })

/** What kind of address a person pasted. */
export function classifyLink(url: string): 'posting' | 'board' | 'search' | 'careers' {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'careers'
  }
  if (detect(url)) return 'board'
  const path = u.pathname
  const idSegment = /(^|\/)(\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|R-?\d{4,}|[A-Z]{1,4}\d{4,})([-/]|$)/i.test(path)
  if (idSegment && /(job|position|role|opening|detail|requisition|posting|career)/i.test(path)) return 'posting'
  if (u.search && /(q|query|search|keyword|keywords|search_term|base_query)=/i.test(u.search)) return 'search'
  if (/(search|results|listing|list|openings)/i.test(path)) return 'search'
  return 'careers'
}

/** Eightfold's page config, HTML-escaped or not: `"domain": "netflix.com"`. */
const EIGHTFOLD_DOMAIN = /domain(?:&#34;|&quot;|")\s*:\s*(?:&#34;|&quot;|")([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:&#34;|&quot;|")/gi

export function eightfoldBoards(html: string, pageUrl: string, companyDomain: string | null): DiscoveredBoard[] {
  if (!/eightfold/i.test(html) || !companyDomain) return []
  const host = new URL(pageUrl).hostname.toLowerCase()
  const root = companyDomain.toLowerCase().replace(/^www\./, '')
  const domains = [...html.matchAll(EIGHTFOLD_DOMAIN)].map((m) => m[1].toLowerCase())
  // The config must name the company's own domain: a vendor page for a customer is not this company's.
  const own = domains.find((d) => d === root) ?? domains.find((d) => d.endsWith(`.${root}`))
  const token = own ? eightfoldToken(host, own) : null
  return token ? [{ provider: 'eightfold', token, via: 'eightfold' }] : []
}

function sameSiteLinks(html: string, pageUrl: string, companyDomain: string | null): string[] {
  const $ = cheerio.load(html)
  const here = new URL(pageUrl)
  const out: string[] = []
  $('a[href]').each((_, el) => {
    if (out.length >= 40) return
    const label = $(el).text().replace(/\s+/g, ' ').trim()
    let to: URL
    try {
      to = new URL($(el).attr('href') ?? '', pageUrl)
    } catch {
      return
    }
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return
    const same = to.hostname === here.hostname || onCompanyDomain(to.toString(), companyDomain)
    if (!same) return
    to.hash = ''
    const url = to.toString()
    if (url === pageUrl || out.includes(url)) return
    if (JOB_WORDS.test(to.pathname) || JOB_WORDS.test(label)) out.push(url)
  })
  return out
}

export function ghJid(html: string): string | null {
  return /[?&]gh_jid=(\d{4,})/.exec(html.replace(/&amp;/g, '&'))?.[1] ?? null
}

export async function tokenBehindJid(jid: string, f: SiteFetcher): Promise<string | null> {
  const to = await f.redirectOf(`https://boards.greenhouse.io/embed/job_app?token=${jid}`)
  const token = to ? new URL(to).searchParams.get('for') : null
  return token && /^[A-Za-z0-9._-]+$/.test(token) ? token : null
}

/** The boards one page links to or embeds: its links and an Eightfold config naming the company's domain. */
export function boardsInHtml(html: string, pageUrl: string, companyDomain: string | null): DiscoveredBoard[] {
  return [...findBoardLinks(html, detect).map((b): DiscoveredBoard => ({ ...b, via: 'link' })), ...eightfoldBoards(html, pageUrl, companyDomain)]
}

/**
 * Read the company's careers URL (and at most two job-looking pages on its own
 * site) for the applicant system behind it. Never throws; a page that cannot be
 * read is reported in `failure` and discovery returns what it has.
 */
export async function discoverBoards(company: { domain: string | null; careerUrl: string }, f: SiteFetcher): Promise<Discovery> {
  const found = new Map<string, DiscoveredBoard>()
  const pages: PageRead[] = []
  const add = (b: DiscoveredBoard) => {
    const key = `${b.provider}:${b.token.toLowerCase()}`
    if (!found.has(key)) found.set(key, b)
  }
  const result = (failure?: ReaderError): Discovery => ({ boards: [...found.values()], pages, failure })

  // 1. A redirect off the careers URL to an applicant system is the company saying where its board is.
  try {
    const to = await f.redirectOf(company.careerUrl)
    const hit = to ? detect(to) : null
    if (hit) {
      add({ ...hit, via: 'redirect' })
      return result()
    }
  } catch (error) {
    if (error instanceof ReaderError && error.reason !== 'budget') return result(error)
  }

  // 2. The careers page itself, then a couple of its job-looking neighbours.
  const queue = [company.careerUrl]
  const seen = new Set<string>()
  let jid: string | null = null
  for (let i = 0; i < queue.length && pages.length < 1 + MAX_SIDE_PAGES; i++) {
    const url = queue[i]
    if (seen.has(url)) continue
    seen.add(url)
    let html: string
    let finalUrl: string
    try {
      const res = await f.get(url)
      if (!res.ok) {
        if (i === 0) return result()
        continue
      }
      html = res.text
      finalUrl = res.finalUrl
    } catch (error) {
      if (error instanceof ReaderError && (error.reason === 'budget' || i > 0)) return result(i > 0 ? undefined : error)
      return result(error instanceof ReaderError ? error : new ReaderError('unreachable'))
    }
    pages.push({ url: finalUrl, html })

    // A cross-host landing on an applicant system (the redirect was followed by hand).
    const landed = detect(finalUrl)
    if (landed && finalUrl !== url) add({ ...landed, via: 'redirect' })
    for (const b of findBoardLinks(html, detect)) add({ ...b, via: 'link' })
    for (const b of eightfoldBoards(html, finalUrl, company.domain)) add(b)
    jid ??= ghJid(html)
    if (i === 0) for (const next of sameSiteLinks(html, finalUrl, company.domain)) if (queue.length < 1 + MAX_SIDE_PAGES * 3) queue.push(next)
    if (found.size > 0) break
  }

  // 3. A Greenhouse job-id link on the company's own page names the board behind it.
  if (found.size === 0 && jid) {
    try {
      const token = await tokenBehindJid(jid, f)
      if (token) add({ provider: 'greenhouse', token, via: 'gh_jid' })
    } catch {
      /* no evidence */
    }
  }
  return result()
}
