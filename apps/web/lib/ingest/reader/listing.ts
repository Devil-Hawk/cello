// Server-rendered listing and search pages: role links and titles from the HTML,
// details from each role's own page.
//
// A list of roles is a group of three or more links that share a path shape
// with an id in it (/details/<id>/<slug>, /jobs/results/<id>-<slug>,
// /job-listings/<id>-<slug>). A navigation menu is not one: its links have no
// ids. Titles outside the person's targets are dropped before any page is
// fetched, and every title that stays has to appear on its own page (its
// JobPosting, og:title, heading or <title>), so a link that goes somewhere
// generic can never become a role.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../../ats/types'
import { findBoardLinks } from '../../ats/careers-page'
import { detectFromUrl } from '../../ats/detect'
import type { BoardRef } from '../../ats/verify'
import { mapWithConcurrency } from '../../ats/concurrency'
import { normalizeJobUrl } from '../snapshot'
import { jobFromDetail, readDetail } from './detail'
import { ReaderError, type SiteFetcher } from './site-fetch'
import { matchesTargets, searchTerms, type ReaderTargets } from './targets'

export interface RoleLink {
  url: string
  title: string
  postedAt?: string
}

const ID_SEGMENT = /^(?:\d{5,}(?:-[\w-]*)?|[0-9a-f]{8,}(?:-[\w-]*)?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
const CARD_DATE = new RegExp(`((?:${MONTHS})[a-z]*\\.? \\d{1,2}, \\d{4}|\\d{4}-\\d{2}-\\d{2})`)
const MIN_GROUP = 3

/** "/en-us/details/200684990-3956/front-end-engineer" -> "/en-us/details/:id"; a path with no id segment has no template. */
export function templateOf(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean)
  const at = parts.findIndex((p) => ID_SEGMENT.test(p))
  return at < 0 ? null : '/' + [...parts.slice(0, at), ':id'].join('/')
}

function dateOf(text: string): string | undefined {
  const m = CARD_DATE.exec(text)
  if (!m) return undefined
  const t = Date.parse(/^\d{4}-/.test(m[1]) ? `${m[1]}T00:00:00Z` : `${m[1].replace('.', '')} UTC`)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

function titleOf(a: cheerio.Cheerio<any>, idInUrl: string): string {
  // A card link often wraps the title and the place together; the heading inside it is the title.
  let title = clean(a.find('h1,h2,h3,h4,h5').first().text()) || clean(a.text())
  if (!title) {
    title = clean(a.attr('aria-label')).replace(/^(?:learn more about|see full role description:?)\s*/i, '')
  }
  if (!title) {
    title = clean(a.closest('li,article,div').find('h1,h2,h3,h4').first().text())
  }
  // "Front End Engineer 200684990": a trailing requisition id is not part of the title.
  return title.replace(new RegExp(`\\s+${idInUrl.replace(/[^\w-]/g, '')}\\s*$`), '').replace(/\s+\d{6,}$/, '').trim()
}

/** The date in the card around a link: the nearest ancestor that holds a date and no other role's link. */
function cardDate(a: cheerio.Cheerio<any>, template: string): string | undefined {
  let el = a.parent()
  for (let depth = 0; depth < 6 && el.length; depth++, el = el.parent()) {
    const others = new Set<string>()
    el.find('a[href]').each((_, x) => {
      const href = (x as any).attribs?.href ?? ''
      if (templateOf(href.split(/[?#]/)[0]) === template) others.add(href.split(/[?#]/)[0])
    })
    if (others.size > 1) return undefined
    const date = dateOf(clean(el.text()))
    if (date) return date
  }
  return undefined
}

/** The links on a page that are one role each. */
export function roleLinks(html: string, pageUrl: string): RoleLink[] {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return []
  }
  // A page may say what its relative links are relative to (Google's results do).
  let base = pageUrl
  try {
    base = new URL($('base[href]').first().attr('href') ?? '', pageUrl).toString()
  } catch {
    /* keep the page's own address */
  }
  const groups = new Map<string, RoleLink[]>()
  const seen = new Set<string>()
  $('a[href]').each((_, el) => {
    const a = $(el)
    let to: URL
    try {
      to = new URL(a.attr('href') ?? '', base)
    } catch {
      return
    }
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return
    const template = templateOf(to.pathname)
    if (!template) return
    to.hash = ''
    const url = normalizeJobUrl(to.toString())
    // The same role is linked twice on many cards (title and a "learn more" button).
    const key = `${to.hostname}${to.pathname}`
    if (seen.has(key)) {
      return
    }
    const idInUrl = to.pathname.split('/').find((p) => ID_SEGMENT.test(p)) ?? ''
    const title = titleOf(a, idInUrl)
    if (title.length < 3) return
    seen.add(key)
    const postedAt = cardDate(a, template)
    const g = `${to.hostname}${template}`
    groups.set(g, [...(groups.get(g) ?? []), { url, title, ...(postedAt ? { postedAt } : {}) }])
  })
  const lists = [...groups.entries()].filter(([, links]) => links.length >= MIN_GROUP)
  if (lists.length === 0) return []
  // A list of roles lives under a path that says so; a list of press releases or blog posts with ids does not.
  const jobby = lists.filter(([g]) => /job|career|position|opening|role|detail|vacanc|requisition|result/i.test(g))
  if (jobby.length === 0) return []
  return jobby.sort((x, y) => y[1].length - x[1].length)[0][1]
}

// --- search pages -----------------------------------------------------------

interface ListingSite {
  /** Careers hosts it covers. */
  hosts: string[]
  /** The search page for one phrase and page number. */
  url(origin: string, term: string, page: number): string
  maxPages: { inline: number; scheduled: number }
}

const LISTING_SITES: ListingSite[] = [
  {
    // Apple ignores the search text on the server and lists everything newest first, 20 a page.
    hosts: ['jobs.apple.com'],
    url: (o, _term, page) => `${o}/en-us/search?sort=newest&location=united-states-USA${page > 1 ? `&page=${page}` : ''}`,
    maxPages: { inline: 2, scheduled: 5 },
  },
  {
    // Google's robots.txt disallows ?page=, so only the first page of a search is read.
    hosts: ['www.google.com'],
    url: (o, term) => `${o}/about/careers/applications/jobs/results?q=${encodeURIComponent(term)}&location=United%20States`,
    maxPages: { inline: 1, scheduled: 1 },
  },
]

export function listingSiteFor(careerUrl: string): ListingSite | null {
  try {
    const u = new URL(careerUrl)
    if (u.hostname === 'www.google.com' && !u.pathname.startsWith('/about/careers')) return null
    return LISTING_SITES.find((s) => s.hosts.includes(u.hostname)) ?? null
  } catch {
    return null
  }
}

export interface ListingRead {
  jobs: AtsJob[]
  /** Role links the pages listed, before targets and confirmation. */
  listed: number
  /** A board a role page linked to: the read should upgrade to it. */
  board?: BoardRef
  /** Pages whose list could not be confirmed as roles. */
  rejected: number
  /** The role links seen (normalised), for sightings. */
  listedIds: string[]
  checked: string[]
}

const DETAIL_PER_READ = { inline: 10, scheduled: 60 } as const

/**
 * Read the role lists on `pages` (pages already fetched) plus the site's own
 * search pages, then confirm each wanted role on its own page.
 */
export async function readListing(
  careerUrl: string,
  pages: { url: string; html: string }[],
  f: SiteFetcher,
  opts: { targets: ReaderTargets; skip?: ReadonlySet<string>; max?: number }
): Promise<ListingRead> {
  const all = new Map<string, RoleLink>()
  for (const p of pages) for (const l of roleLinks(p.html, p.url)) if (!all.has(l.url)) all.set(l.url, l)

  const site = listingSiteFor(careerUrl)
  if (site) {
    const origin = new URL(careerUrl).origin
    const term = searchTerms(opts.targets)[0] ?? ''
    for (let page = 1; page <= site.maxPages[f.mode]; page++) {
      const url = site.url(origin, term, page)
      if (pages.some((p) => p.url === url)) continue
      try {
        const res = await f.get(url)
        if (!res.ok) break
        const links = roleLinks(res.text, res.finalUrl)
        if (links.length === 0) break
        for (const l of links) if (!all.has(l.url)) all.set(l.url, l)
      } catch (error) {
        if (error instanceof ReaderError && all.size === 0) throw error
        break
      }
    }
  }

  const links = [...all.values()]
  const wanted = links.filter((l) => matchesTargets(l.title, opts.targets) && !opts.skip?.has(l.url)).slice(0, opts.max ?? DETAIL_PER_READ[f.mode])

  const jobs: AtsJob[] = []
  const checked: string[] = []
  let rejected = 0
  let board: BoardRef | undefined
  let stopped: ReaderError | null = null
  await mapWithConcurrency(wanted, 2, async (l) => {
    if (stopped) return
    try {
      const res = await f.get(l.url)
      if (!res.ok) return
      const detail = readDetail(res.text, res.finalUrl)
      const job = jobFromDetail(res.finalUrl, detail, { title: l.title, postedAt: l.postedAt })
      checked.push(l.url)
      if (!job) {
        rejected++
        return
      }
      jobs.push(job)
      board ??= findBoardLinks(res.text, (u) => detectFromUrl({ careerUrl: u, domain: null }))[0]
    } catch (error) {
      if (error instanceof ReaderError) stopped = error
    }
  })
  if (stopped && (stopped as ReaderError).reason !== 'budget' && jobs.length === 0) throw stopped
  return { jobs, listed: links.length, board, rejected, listedIds: links.map((l) => l.url), checked }
}
