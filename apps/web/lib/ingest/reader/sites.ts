// Sites whose own search answers a plain request with JSON, asked for what the
// person is looking for. One entry per site, keyed by the careers host, with the
// fixed hosts it may call. A recipe that stops working is not a failure of the
// reader: the next tiers (sitemaps, listings) take over and the tier recorded
// changes.
//
// What is NOT here, on purpose: Walmart (its search API is under /api, which its
// robots.txt disallows) and Uber (its API is disallowed too, and its job pages
// answer a Cloudflare challenge). They are read by the tiers below this one, or
// reported as not readable.

import type { AtsJob } from '../../ats/types'
import { htmlToPlainText } from '../../ats/html'
import { MAX_DESCRIPTION_CHARS } from './legit'
import { searchTerms, type ReaderTargets } from './targets'
import type { SiteFetcher } from './site-fetch'

export interface SiteRecipe {
  id: string
  /** Careers hosts this recipe handles (www. ignored). */
  hosts: string[]
  read(f: SiteFetcher, targets: ReaderTargets): Promise<AtsJob[]>
}

const norm = (host: string) => host.toLowerCase().replace(/^www\./, '')

// --- Amazon -----------------------------------------------------------------

interface AmazonJob {
  title?: string
  job_path?: string
  id_icims?: string
  company_name?: string
  normalized_location?: string
  location?: string
  posted_date?: string
  description?: string
  basic_qualifications?: string
  preferred_qualifications?: string
}

const AMAZON_HOSTS: ReadonlySet<string> = new Set(['www.amazon.jobs'])
const AMAZON_PAGE = 100

export function amazonJobs(json: { jobs?: AmazonJob[] }): AtsJob[] {
  const out: AtsJob[] = []
  for (const j of json.jobs ?? []) {
    const title = (j.title ?? '').trim()
    if (!title || !j.job_path) continue
    const url = new URL(j.job_path, 'https://www.amazon.jobs').toString()
    const posted = j.posted_date ? Date.parse(`${j.posted_date.replace(/\s+/g, ' ')} UTC`) : NaN
    const body = [j.description, j.basic_qualifications && `Basic qualifications\n${j.basic_qualifications}`, j.preferred_qualifications && `Preferred qualifications\n${j.preferred_qualifications}`]
      .filter(Boolean)
      .join('\n\n')
    const description = htmlToPlainText(body, MAX_DESCRIPTION_CHARS)
    out.push({
      title,
      url,
      externalId: url,
      location: j.normalized_location || j.location || undefined,
      ...(Number.isNaN(posted) ? {} : { postedAt: new Date(posted).toISOString() }),
      ...(j.company_name ? { employer: j.company_name } : {}),
      ...(j.id_icims ? { requisitionId: String(j.id_icims) } : {}),
      ...(description ? { description } : {}),
    })
  }
  return out
}

const amazon: SiteRecipe = {
  id: 'amazon',
  hosts: ['amazon.jobs'],
  async read(f, targets) {
    const terms = searchTerms(targets)
    const jobs = new Map<string, AtsJob>()
    for (const term of terms.length ? terms : ['']) {
      const url = `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(term)}&loc_query=&result_limit=${AMAZON_PAGE}&offset=0&sort=recent`
      const json = await f.json<{ jobs?: AmazonJob[] }>(url, { allowedHosts: AMAZON_HOSTS })
      for (const job of amazonJobs(json)) jobs.set(job.externalId, job)
    }
    return [...jobs.values()]
  },
}

// --- TikTok -----------------------------------------------------------------

interface TikTokPlace {
  en_name?: string | null
  parent?: TikTokPlace | null
}

interface TikTokJob {
  id?: string
  title?: string
  description?: string
  requirement?: string
  city_info?: TikTokPlace | null
}

const TIKTOK_HOSTS: ReadonlySet<string> = new Set(['api.lifeattiktok.com'])
const TIKTOK_PAGE = 50

function placeOf(p: TikTokPlace | null | undefined): string | undefined {
  const names: string[] = []
  for (let cur = p, i = 0; cur && i < 4; cur = cur.parent, i++) if (cur.en_name) names.push(cur.en_name)
  return names.length ? names.join(', ') : undefined
}

export function tiktokJobs(json: { data?: { job_post_list?: TikTokJob[] } }): AtsJob[] {
  const out: AtsJob[] = []
  for (const j of json.data?.job_post_list ?? []) {
    const title = (j.title ?? '').trim()
    if (!title || !j.id) continue
    const url = `https://lifeattiktok.com/search/${j.id}`
    const body = [j.description, j.requirement && `Requirements\n${j.requirement}`].filter(Boolean).join('\n\n')
    const description = htmlToPlainText(body, MAX_DESCRIPTION_CHARS)
    out.push({ title, url, externalId: url, location: placeOf(j.city_info), requisitionId: j.id, ...(description ? { description } : {}) })
  }
  return out
}

const tiktok: SiteRecipe = {
  id: 'tiktok',
  hosts: ['lifeattiktok.com'],
  async read(f, targets) {
    const terms = searchTerms(targets)
    const jobs = new Map<string, AtsJob>()
    for (const term of terms.length ? terms : ['']) {
      const json = await f.json<{ data?: { job_post_list?: TikTokJob[] } }>('https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts', {
        allowedHosts: TIKTOK_HOSTS,
        method: 'POST',
        body: JSON.stringify({ keyword: term, limit: TIKTOK_PAGE, offset: 0, recruitment_id_list: [], job_category_id_list: [], subject_id_list: [], location_code_list: [] }),
        // The site's own static request headers; no cookie, no token.
        headers: { 'content-type': 'application/json', 'website-path': 'tiktok', 'portal-channel': 'tiktok', 'portal-platform': 'pc' },
      })
      for (const job of tiktokJobs(json)) jobs.set(job.externalId, job)
    }
    return [...jobs.values()]
  },
}

// --- Bending Spoons ---------------------------------------------------------

interface BsJob {
  id?: string
  jobTitle?: string
  isEvent?: boolean
  status?: string
  highLevelDescription?: string
  responsibilities?: { title?: string; description?: string }[]
  requirements?: { title?: string; description?: string }[]
  officeLocations?: { title?: string }[]
}

/** The roles a Next.js page carries in its own data (`__NEXT_DATA__`), the way jobs.bendingspoons.com does: none of them is a link in the HTML. */
export function bendingSpoonsJobs(html: string): AtsJob[] {
  const raw = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!raw) return []
  let list: BsJob[] = []
  try {
    list = (JSON.parse(raw) as { props?: { pageProps?: { list?: BsJob[] } } }).props?.pageProps?.list ?? []
  } catch {
    return []
  }
  const out: AtsJob[] = []
  for (const j of Array.isArray(list) ? list : []) {
    const title = (j.jobTitle ?? '').trim()
    // An event is not a role; a role that is not active is not open.
    if (!title || !j.id || j.isEvent || (j.status && j.status !== 'active')) continue
    const url = `https://jobs.bendingspoons.com/positions/${j.id}`
    const lines = (items?: { title?: string; description?: string }[]) => (items ?? []).map((x) => `${x.title ?? ''}: ${x.description ?? ''}`.trim()).filter(Boolean).join('\n')
    const body = [j.highLevelDescription, j.responsibilities?.length ? `Responsibilities\n${lines(j.responsibilities)}` : '', j.requirements?.length ? `Requirements\n${lines(j.requirements)}` : '']
      .filter(Boolean)
      .join('\n\n')
    const description = htmlToPlainText(body, MAX_DESCRIPTION_CHARS)
    const location = (j.officeLocations ?? []).map((l) => l.title).filter(Boolean).join(' · ')
    out.push({ title, url, externalId: url, ...(location ? { location } : {}), ...(description ? { description } : {}) })
  }
  return out
}

const bendingSpoons: SiteRecipe = {
  id: 'bendingspoons',
  hosts: ['jobs.bendingspoons.com'],
  async read(f) {
    const res = await f.get('https://jobs.bendingspoons.com/')
    return res.ok ? bendingSpoonsJobs(res.text) : []
  },
}

export const RECIPES: readonly SiteRecipe[] = [amazon, tiktok, bendingSpoons]

/** The recipe for a careers address, or null. */
export function siteFor(url: string): SiteRecipe | null {
  let host: string
  try {
    host = norm(new URL(url).hostname)
  } catch {
    return null
  }
  return RECIPES.find((r) => r.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null
}
