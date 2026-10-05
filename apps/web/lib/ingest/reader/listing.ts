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
  /** The place, when the card's link says only that ("Seattle"). */
  location?: string
}

const ID_SEGMENT = /^(?:\d{5,}(?:-[\w-]*)?|[0-9a-f]{8,}(?:-[\w-]*)?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
const CARD_DATE = new RegExp(`((?:${MONTHS})[a-z]*\\.? \\d{1,2}, \\d{4}|\\d{4}-\\d{2}-\\d{2})`)
const MIN_GROUP = 3

/** Query parameters that carry a role's id when its path does not (Greenhouse job-id links on a company's own site: ?gh_jid=123). */
const ID_PARAM = /^(?:gh_jid|jid|job_?id|job_?req_?id|req_?id|requisition_?id|posting_?id|id)$/i

/** The id a link carries in its query, as "name=value", or null. */
export function queryIdOf(url: URL): string | null {
  for (const [k, v] of url.searchParams) if (ID_PARAM.test(k) && /^[\w-]{4,}$/.test(v) && /\d/.test(v)) return `${k.toLowerCase()}=${v}`
  return null
}

/** "/en-us/details/200684990-3956/front-end-engineer" -> "/en-us/details/:id"; "/careers/position/apply?gh_jid=7" -> "/careers/position/apply?gh_jid=:id"; no id, no template. */
export function templateOf(pathname: string, search = ''): string | null {
  const parts = pathname.split('/').filter(Boolean)
  const at = parts.findIndex((p) => ID_SEGMENT.test(p))
  if (at >= 0) return '/' + [...parts.slice(0, at), ':id'].join('/')
  const q = queryIdOf(new URL(`https://x.test${pathname}${search}`))
  return q ? `${pathname}?${q.split('=')[0]}=:id` : null
}

function dateOf(text: string): string | undefined {
  const m = CARD_DATE.exec(text)
  if (!m) return undefined
  const t = Date.parse(/^\d{4}-/.test(m[1]) ? `${m[1]}T00:00:00Z` : `${m[1].replace('.', '')} UTC`)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** "Sunnyvale, CA, USA; Atlanta, GA, USA; +5 more" -> "Sunnyvale, CA, USA · Atlanta, GA, USA". */
function placesOf(text: string): string | undefined {
  const place = text
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t && !/^\+\d+ more$/i.test(t))
    .slice(0, 3)
    .join(' · ')
  return place.length >= 2 && place.length <= 120 ? place : undefined
}

/** Material icon names a card puts before its place. */
const PLACE_ICON = /^(?:place|location_on|location_city|pin_drop)$/

/**
 * The place a card shows: under a heading inside the link (<a><h3>Title</h3><p>Mountain View, CA, USA; +4 more</p></a>),
 * or beside a place icon elsewhere in the card (Google's results: <i>place</i><span>Boulder, CO, USA</span>).
 */
function cardPlace(a: cheerio.Cheerio<any>): string | undefined {
  if (a.find('h1,h2,h3,h4,h5').length > 0) {
    const inLink = placesOf(clean(a.find('p').first().text()))
    if (inLink) return inLink
  }
  const icon = a
    .closest('li,article')
    .find('i')
    .filter((_, el) => PLACE_ICON.test(clean(((el as any).children ?? []).map((c: any) => c.data ?? '').join(''))))
    .first()
  return icon.length ? placesOf(clean(icon.next().text())) : undefined
}

/** The texts a link and its card offer as the role's title, best guess first. */
function titlesOf(a: cheerio.Cheerio<any>, idInUrl: string): string[] {
  const strip = (t: string) => t.replace(new RegExp(`\\s+${idInUrl.replace(/[^\w-]/g, '')}\\s*$`), '').replace(/\s+\d{6,}$/, '').trim()
  return [
    // A card link often wraps the title and the place together; the heading inside it is the title.
    clean(a.find('h1,h2,h3,h4,h5').first().text()),
    clean(a.text()),
    clean(a.attr('aria-label')).replace(/^(?:learn more about|see full role description:?)\s*/i, ''),
    clean(a.closest('li,article,tr,div').find('h1,h2,h3,h4').first().text()),
    // A card whose title is a plain span or line of its own beside a link that says only the place ("Seattle").
    clean(
      a
        .closest('li,article,tr')
        .find('span,div,p,strong,b')
        .filter((_, el) => el.children.every((c) => c.type === 'text'))
        .first()
        .text()
    ),
  ]
    .map(strip)
    .filter((t) => t.length >= 3)
}

/** A title is a phrase; a single word is more likely a place ("Seattle") or a button. */
const bestTitle = (titles: string[]): string => titles.find((t) => t.split(/\s+/).length >= 2) ?? titles[0] ?? ''

/** The date in the card around a link: the nearest ancestor that holds a date and no other role's link. */
function cardDate(a: cheerio.Cheerio<any>, template: string): string | undefined {
  let el = a.parent()
  for (let depth = 0; depth < 6 && el.length; depth++, el = el.parent()) {
    const others = new Set<string>()
    el.find('a[href]').each((_, x) => {
      const href = (x as any).attribs?.href ?? ''
      if (templateOf(href.split(/[?#]/)[0], href.includes('?') ? '?' + href.split('?')[1].split('#')[0] : '') === template) others.add(href.split('#')[0])
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
  // One entry per role; the same role is linked more than once on many cards (its place, its title, a "learn more" button).
  const entries = new Map<string, { url: string; titles: string[]; template: string; g: string; a: cheerio.Cheerio<any>; linkText: string; place?: string }>()
  $('a[href]').each((_, el) => {
    const a = $(el)
    let to: URL
    try {
      to = new URL(a.attr('href') ?? '', base)
    } catch {
      return
    }
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return
    const template = templateOf(to.pathname, to.search)
    if (!template) return
    to.hash = ''
    const key = `${to.hostname}${to.pathname}${templateOf(to.pathname) ? '' : (queryIdOf(to) ?? '')}`
    const idInUrl = to.pathname.split('/').find((p) => ID_SEGMENT.test(p)) ?? queryIdOf(to)?.split('=')[1] ?? ''
    const titles = titlesOf(a, idInUrl)
    const have = entries.get(key)
    if (have) {
      have.titles.push(...titles)
      return
    }
    entries.set(key, { url: normalizeJobUrl(to.toString()), titles, template, g: `${to.hostname}${template}`, a, linkText: clean(a.text()), place: cardPlace(a) })
  })
  const groups = new Map<string, RoleLink[]>()
  for (const e of entries.values()) {
    const title = bestTitle(e.titles)
    if (title.length < 3) continue
    const postedAt = cardDate(e.a, e.template)
    const location = e.place ?? (e.linkText && e.linkText !== title && e.linkText.length <= 60 && !title.includes(e.linkText) ? e.linkText : undefined)
    groups.set(e.g, [...(groups.get(e.g) ?? []), { url: e.url, title, ...(postedAt ? { postedAt } : {}), ...(location ? { location } : {}) }])
  }
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
  opts: { targets: ReaderTargets; skip?: ReadonlySet<string>; max?: number; ownSite?: (url: string) => boolean }
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

  // Only the employer's own pages are fetched: a list may link anywhere.
  const links = [...all.values()].filter((l) => !opts.ownSite || opts.ownSite(l.url))
  const wanted = links.filter((l) => matchesTargets(l.title, opts.targets) && !opts.skip?.has(l.url)).slice(0, opts.max ?? DETAIL_PER_READ[f.mode])

  const jobs: AtsJob[] = []
  const checked: string[] = []
  let rejected = 0
  let board: BoardRef | undefined
  let stopped: ReaderError | null = null
  await mapWithConcurrency(wanted, 2, async (l) => {
    // A page that names the applicant system behind the site ends the read: the board is the better source.
    if (stopped || board) return
    try {
      const res = await f.get(l.url)
      if (!res.ok) return
      const detail = readDetail(res.text, res.finalUrl)
      const job = jobFromDetail(res.finalUrl, detail, { title: l.title, postedAt: l.postedAt, location: l.location })
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
