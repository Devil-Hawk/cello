// What a site declares for search engines: the Sitemap lines of its robots.txt,
// the job URLs those list (with lastmod when they carry it), and each job
// page's own JobPosting data. Meta is read this way: 1,075 job URLs, and every
// page says who posted it and when.
//
// Bounded and polite: at most three child sitemaps, only job-looking URLs,
// matched against the person's targets by their slug words BEFORE any page is
// fetched, newest lastmod first (a sitemap with one lastmod for everything is
// ordered by the largest numeric id, which is the newest posting on every site
// seen), and only a few pages per refresh. Pages already read are remembered
// (`checked`), so the next pass reads only what is new.

import type { AtsJob } from '../../ats/types'
import { mapWithConcurrency } from '../../ats/concurrency'
import { normalizeJobUrl } from '../snapshot'
import { findBoardLinks } from '../../ats/careers-page'
import { detectFromUrl } from '../../ats/detect'
import type { BoardRef } from '../../ats/verify'
import { jobFromDetail, readDetail } from './detail'
import { classifyLink } from './discover'
import { ReaderError, type SiteFetcher } from './site-fetch'
import { matchesTargets, wordsOf, type ReaderTargets } from './targets'

export interface SitemapEntry {
  url: string
  lastmod?: string
}

const MAX_SITEMAPS = 3
const MAX_ENTRIES = 60_000
const SITEMAP_WORDS = /job|career|position|opening|vacanc/i
/** Pages fetched per refresh: the budget decides how fast a big site is covered. */
export const DETAIL_PER_READ = { inline: 10, scheduled: 60 } as const

function locs(xml: string, tag: 'url' | 'sitemap'): SitemapEntry[] {
  const out: SitemapEntry[] = []
  for (const m of xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))) {
    const url = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1])?.[1]?.replace(/&amp;/g, '&')
    if (!url) continue
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1])?.[1]
    out.push({ url, ...(lastmod ? { lastmod } : {}) })
    if (out.length >= MAX_ENTRIES) break
  }
  return out
}

/** Does this URL look like one role's page (and not a department, a search or a policy page)? */
export function isPostingUrl(url: string): boolean {
  return classifyLink(url) === 'posting'
}

const numericId = (url: string): number => {
  const m = [...new URL(url).pathname.matchAll(/\d{4,}/g)].pop()
  return m ? Number(m[0]) : 0
}

/** The words in a URL's last path segment ("4721503005-art-director" -> "art director"); empty when it is only an id. */
const slugWords = (url: string): string => {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  return wordsOf(decodeURIComponent(last).replace(/\d+/g, ' ')).join(' ')
}

/**
 * Newest first: by lastmod; when lastmod is absent or the same everywhere, by
 * the largest numeric id. Entries whose slug names the person's targets come
 * before the rest, and with targets set an entry whose slug names a different
 * role is dropped (an entry with no slug words cannot be judged and stays).
 */
export function orderEntries(entries: SitemapEntry[], targets: ReaderTargets): SitemapEntry[] {
  const mods = new Set(entries.map((e) => e.lastmod ?? ''))
  const uniform = mods.size <= 1
  const time = (e: SitemapEntry) => (e.lastmod ? Date.parse(e.lastmod) || 0 : 0)
  const rank = (e: SitemapEntry) => {
    const words = slugWords(e.url)
    if (!words) return 1
    return matchesTargets(words, targets) ? 0 : 2
  }
  return entries
    .filter((e) => rank(e) < 2 || matchesTargets('', targets))
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || (uniform ? numericId(b.e.url) - numericId(a.e.url) : time(b.e) - time(a.e)) || a.i - b.i)
    .map((x) => x.e)
}

/** All of a site's job URLs from the sitemaps its robots.txt names. */
export async function readSitemapEntries(origin: string, f: SiteFetcher): Promise<{ entries: SitemapEntry[]; complete: boolean }> {
  const named = (await f.sitemapsOf(origin)).filter((u) => !/\.gz($|\?)/i.test(u))
  // ponytail: .gz sitemaps are skipped (no gunzip here); the plain job sitemap is listed beside them on every site seen.
  const jobby = named.filter((u) => SITEMAP_WORDS.test(u))
  // On a careers host (careers.walmart.com) every sitemap is about jobs; on a company's main site only the job ones are.
  const careersHost = /career|(^|\.)jobs?\./i.test(new URL(origin).hostname)
  const queue = (careersHost && !jobby.length ? named : jobby).slice(0, MAX_SITEMAPS)
  const entries: SitemapEntry[] = []
  let complete = queue.length > 0
  for (let i = 0; i < queue.length && i < MAX_SITEMAPS + 3; i++) {
    let text: string
    try {
      const res = await f.get(queue[i], { accept: 'application/xml,text/xml,*/*' })
      if (!res.ok) {
        complete = false
        continue
      }
      text = res.text
    } catch (error) {
      if (error instanceof ReaderError && error.reason === 'budget') {
        complete = false
        break
      }
      throw error
    }
    const children = locs(text, 'sitemap')
    if (children.length) {
      // An index: follow only the children that look like job sitemaps, never past the limit.
      for (const c of children) if (SITEMAP_WORDS.test(c.url) && !/\.gz($|\?)/i.test(c.url) && queue.length < MAX_SITEMAPS + 3 && !queue.includes(c.url)) queue.push(c.url)
      continue
    }
    for (const e of locs(text, 'url')) if (isPostingUrl(e.url)) entries.push(e)
  }
  return { entries, complete: complete && entries.length > 0 }
}

export interface SitemapRead {
  jobs: AtsJob[]
  /** Every role the sitemap lists (normalised addresses), so a stored role missing from it can be counted as gone. */
  listedIds: string[]
  complete: boolean
  /** Addresses read or rejected this time, to remember so the next pass skips them. */
  checked: string[]
  /** Posting URLs the sitemap named. */
  listed: number
  /** An applicant system a role page links to: the caller may upgrade the read to it. */
  board?: BoardRef
}

export async function readSitemapRoles(
  origin: string,
  f: SiteFetcher,
  opts: { targets: ReaderTargets; skip: ReadonlySet<string>; max?: number; ownSite?: (url: string) => boolean }
): Promise<SitemapRead> {
  const all = await readSitemapEntries(origin, f)
  // Only the employer's own pages are fetched: a sitemap may name addresses anywhere.
  const entries = opts.ownSite ? all.entries.filter((e) => opts.ownSite!(e.url)) : all.entries
  const complete = all.complete
  const listedIds = entries.map((e) => normalizeJobUrl(e.url))
  const todo = orderEntries(entries, opts.targets)
    .filter((e) => !opts.skip.has(normalizeJobUrl(e.url)))
    .slice(0, opts.max ?? DETAIL_PER_READ[f.mode])

  const checked: string[] = []
  const jobs: AtsJob[] = []
  let board: BoardRef | undefined
  let stopped: ReaderError | null = null
  await mapWithConcurrency(todo, 2, async (e) => {
    if (stopped) return
    const id = normalizeJobUrl(e.url)
    try {
      const res = await f.get(e.url)
      if (res.status === 404 || res.status === 410) {
        checked.push(id)
        return
      }
      if (!res.ok) return
      const job = jobFromDetail(res.finalUrl, readDetail(res.text, res.finalUrl), { postedAt: e.lastmod && !uniformStamp(entries) ? e.lastmod : undefined })
      checked.push(id)
      // A page that names no role is remembered as read and not kept. A role outside the person's targets is kept
      // (it cost a request already, and "All roles" shows it); the cap stores the ones inside the targets first.
      if (job) jobs.push(job)
      board ??= findBoardLinks(res.text, (u) => detectFromUrl({ careerUrl: u, domain: null }))[0]
    } catch (error) {
      if (error instanceof ReaderError) stopped = error
    }
  })
  // A bot check or a robots rule on a role page ends the read; a spent budget just ends it early.
  if (stopped && (stopped as ReaderError).reason !== 'budget' && jobs.length === 0) throw stopped
  return { jobs, listedIds, complete, checked, listed: entries.length, board }
}

/** True when the sitemap stamps every URL with one time: that is the fetch time, not a posting date. */
function uniformStamp(entries: SitemapEntry[]): boolean {
  return new Set(entries.map((e) => e.lastmod ?? '')).size <= 1
}
