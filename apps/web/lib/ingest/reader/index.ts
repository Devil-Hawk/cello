// One reader for any careers link. Given a careers home, a search page, a board
// on any applicant system or a single posting, it returns that employer's open
// roles and records which way worked. In order, stopping at the first that
// yields roles:
//
//   board        an applicant system named by the link itself, or reached through
//                the company's own site (discover.ts); the caller verifies it
//   site_search  the site's own search answering a plain request with JSON (sites.ts)
//   sitemap      what the site declares for search engines (sitemap.ts)
//   listing      server-rendered role lists, each role confirmed on its page (listing.ts)
//   rendered     the page as a browser builds it, then the model step: scheduled
//   model        only, where a browser and a free model exist
//
// Only when every tier fails does it say "could not read", with the reason: a bot
// check, a login, robots.txt, no roles found (or "reading", when only the
// rendered tier is left for the next scheduled pass). Whether a role is the
// employer's own, open, unique and real is decided where roles are stored
// (legit.ts, called by syncJobs), not here; a single pasted posting from a
// staffing agency or a reposting site is the one case answered here, in words.
//
// Pure over a SiteFetcher and injected tiers, so every path is testable without
// a network, a database or a model.

import type { AtsJob, AtsProviderId } from '../../ats/types'
import { detectFromUrl } from '../../ats/detect'
import { findBoardLinks } from '../../ats/careers-page'
import type { FetchPage } from '../fetch-page'
import type { ModelCall } from '../model'
import { readJobPostings } from '../jsonld'
import { readCareersPage } from '../page-reader'
import { eightfoldPlace } from '../../ats/eightfold'
import { boardsInHtml, classifyLink, discoverBoards, eightfoldBoards, type DiscoveredBoard, type DiscoveredVia, type PageRead } from './discover'
import { jobFromDetail, readDetail } from './detail'
import { confirmRoles, mislabelledSource, onOwnSite, repostHostOf, repostMessage } from './legit'
import { readListing, roleLinks } from './listing'
import { looksLikeChallenge, ReaderError, type ReaderReason, type SiteFetcher } from './site-fetch'
import { readSitemapRoles } from './sitemap'
import { siteFor } from './sites'
import { matchesTargets, searchTerms, type ReaderTargets } from './targets'

export type Tier = 'board' | 'site_search' | 'sitemap' | 'listing' | 'rendered' | 'model'

export interface SiteInput {
  company: { name: string; domain: string | null; careerUrl: string }
  targets: ReaderTargets
  /** Addresses an earlier pass already read or rejected (metadata.reader.checked): not fetched again. */
  checked?: ReadonlySet<string>
  /** Addresses of roles already stored, so a later pass fetches only what is new. */
  storedIds?: ReadonlySet<string>
}

/** A board the company's own site points at, read and verified by the caller. */
export interface BoardRead {
  provider: AtsProviderId
  token: string
  via: DiscoveredVia | 'url'
  jobs: AtsJob[]
  verifiedBy?: string
}

export interface SiteDeps {
  fetcher: SiteFetcher
  /** Verify a candidate board as the company's and read its roles with the person's search words; null when it does not verify or lists nothing. */
  readBoard?: (candidate: { provider: AtsProviderId; token: string; via: DiscoveredVia | 'url' }, query: string[]) => Promise<BoardRead | null>
  /** The rendered page (a browser): scheduled passes only. */
  fetchPage?: FetchPage
  model?: ModelCall | null
  /** A browser pass will run later (the scheduled check): a site with nothing to read yet is "being read", not "no roles". */
  renderedLater?: boolean
}

export interface TierTry {
  tier: Tier
  outcome: 'roles' | 'none' | ReaderReason | 'skipped'
  /** Why a step crashed, as the fetcher's error class (never an address or page text). */
  detail?: string
}

export interface SiteRead {
  tier: Tier | null
  jobs: AtsJob[]
  /** The list is the whole list, so a stored role missing from it may count as gone. */
  complete: boolean
  /** Every role the source listed (normalised addresses) when that is more than `jobs`, for sightings. */
  listedIds?: string[]
  /** How many roles the site's own list named, when the tier saw a list (a sitemap, a listing): the person is told when Cello has read only part of it. */
  listed?: number
  /** The list carries no titles (only ids), so most roles are known only once their pages are read. */
  untitled?: boolean
  board?: BoardRead
  /** Why nothing was read, or null. */
  reason: ReaderReason | null
  /** In words, for a pasted link that is not the employer's own. */
  message?: string
  single?: boolean
  tried: TierTry[]
  /** Addresses read or rejected this time, to add to metadata.reader.checked. */
  checked: string[]
  requests: number
}

/**
 * Read any careers link. Never throws.
 */
export async function readSite(input: SiteInput, deps: SiteDeps): Promise<SiteRead> {
  const { fetcher: f } = deps
  const { company, targets } = input
  const tried: TierTry[] = []
  const out: SiteRead = { tier: null, jobs: [], complete: false, reason: null, tried, checked: [], requests: 0 }
  const finish = (): SiteRead => ({ ...out, requests: f.spent().requests })
  const query = searchTerms(targets)
  let firstError: ReaderError | null = null
  // Addresses already read or rejected, and roles already stored: a later pass fetches only what is new.
  const skip = { has: (id: string) => input.checked?.has(id) === true || input.storedIds?.has(id) === true } as ReadonlySet<string>
  const ownSite = (url: string) => onOwnSite(url, { company })
  // What the tiers found out about why nothing was read, for the one place that says so (conclude).
  let pages: PageRead[] = []
  let listedNoRoles = false
  let renderFailed = false
  let modelSkipped: 'model_unavailable' | 'model_limit' | undefined
  let budgetHit = false
  const note = (error: unknown): void => {
    if (error instanceof ReaderError && error.reason === 'budget') budgetHit = true
    else if (error instanceof ReaderError) firstError ??= error
  }
  // Nothing was read. Say why, and never call a read that ran out of requests or time "no roles": it did not finish.
  const conclude = (): SiteRead => {
    const err = firstError as ReaderError | null
    const stopped = budgetHit || f.spent().exhausted === true
    if (err && ['bot_check', 'login_required', 'robots'].includes(err.reason)) out.reason = err.reason
    else if (renderFailed) out.reason = 'render_failed'
    else if (err) out.reason = err.reason
    // The page was reached and only the model step did not run: never "no roles" for a site that was not read.
    else if (modelSkipped) out.reason = modelSkipped
    // The budget ran out first: the scheduled pass has more room (a browser pass is coming), else the next check starts again.
    else if (stopped) out.reason = f.mode === 'inline' && deps.renderedLater ? 'reading' : 'budget'
    else if (f.mode === 'inline' && deps.renderedLater && (pages.length > 0 || listedNoRoles)) out.reason = 'reading'
    else out.reason = listedNoRoles ? 'role_pages' : 'no_roles'
    return finish()
  }

  const tryBoard = async (c: DiscoveredBoard | { provider: AtsProviderId; token: string; via: 'url' }): Promise<boolean> => {
    if (!deps.readBoard) return false
    try {
      const board = await deps.readBoard(c, query)
      if (!board || board.jobs.length === 0) return false
      Object.assign(out, { tier: 'board' as Tier, jobs: board.jobs, board, complete: false })
      tried.push({ tier: 'board', outcome: 'roles' })
      return true
    } catch (error) {
      note(error)
      return false
    }
  }

  // A link on a reposting site is never read: its roles are not the employer's own, and the person is told so.
  const repost = repostHostOf(company.careerUrl)
  if (repost && !onOwnSite(company.careerUrl, { company })) {
    out.message = repostMessage(repost, company.name, classifyLink(company.careerUrl) === 'posting' ? 'posting' : 'link')
    out.reason = 'no_roles'
    return finish()
  }

  // The link itself is an applicant system's board (or one of its postings).
  const kind = classifyLink(company.careerUrl)
  const direct = detectFromUrl({ careerUrl: company.careerUrl, domain: null })
  if (direct && (await tryBoard({ ...direct, via: 'url' }))) return finish()
  if (direct) tried.push({ tier: 'board', outcome: 'none' })

  // A single posting is one role, unless its page links the board it belongs to.
  if (kind === 'posting' && !direct) {
    try {
      const res = await f.get(company.careerUrl)
      if (res.ok) {
        const detail = readDetail(res.text, res.finalUrl)
        const upgrade = findBoardLinks(res.text, (u) => detectFromUrl({ careerUrl: u, domain: null }))[0]
        if (upgrade && (await tryBoard({ ...upgrade, via: 'posting' }))) return finish()
        const job = jobFromDetail(res.finalUrl, detail, undefined, { requirePosting: true })
        if (job) {
          const label = mislabelledSource(job, company.name)
          if (label) {
            out.message = label
            out.reason = 'no_roles'
            tried.push({ tier: 'listing', outcome: 'none' })
            return finish()
          }
          Object.assign(out, { tier: 'listing' as Tier, jobs: [job], single: true, complete: false })
          out.checked.push(job.externalId)
          tried.push({ tier: 'listing', outcome: 'roles' })
          return finish()
        }
      }
    } catch (error) {
      note(error)
    }
  }

  // The site's own search.
  const recipe = siteFor(company.careerUrl)
  if (recipe) {
    try {
      const jobs = await recipe.read(f, targets)
      if (jobs.length > 0) {
        Object.assign(out, { tier: 'site_search' as Tier, jobs, complete: false })
        tried.push({ tier: 'site_search', outcome: 'roles' })
        return finish()
      }
      tried.push({ tier: 'site_search', outcome: 'none' })
    } catch (error) {
      note(error)
      tried.push({ tier: 'site_search', outcome: error instanceof ReaderError ? error.reason : 'none' })
    }
  }

  // Through the company's own site to the applicant system behind it.
  if (!recipe && !direct) {
    const found = await discoverBoards({ domain: company.domain, careerUrl: company.careerUrl }, f)
    pages = found.pages
    if (found.failure) note(found.failure)
    for (const candidate of found.boards) if (await tryBoard(candidate)) return finish()
    tried.push({ tier: 'board', outcome: found.failure ? found.failure.reason : 'none' })
  }

  // What the site declares for search engines. A tier claims success only with a role confirmed on its own page.
  try {
    const origin = new URL(company.careerUrl).origin
    const read = await readSitemapRoles(origin, f, { targets, skip, stored: input.storedIds, ownSite })
    if (read.board && (await tryBoard({ ...read.board, via: 'posting' }))) return finish()
    const jobs = confirmRoles(read.jobs, company.name)
    // Roles read now that are role pages, plus listed roles already stored: zero means none could be read.
    if (jobs.length + (read.confirmed - read.jobs.length) > 0) {
      out.checked.push(...read.checked)
      Object.assign(out, { tier: 'sitemap' as Tier, jobs, complete: read.complete, listedIds: read.listedIds, listed: read.listed, untitled: read.untitled })
      tried.push({ tier: 'sitemap', outcome: 'roles' })
      return finish()
    }
    // Roles listed, none readable: the pages are not marked as checked, so a later pass (or a browser) tries them again.
    if (read.listed > 0) listedNoRoles = true
    tried.push({ tier: 'sitemap', outcome: read.listed > 0 ? 'role_pages' : 'none' })
  } catch (error) {
    note(error)
    tried.push({ tier: 'sitemap', outcome: error instanceof ReaderError ? error.reason : 'none' })
  }

  // Server-rendered role lists.
  if (!firstError || (firstError as ReaderError).reason !== 'bot_check') {
    try {
      const read = await readListing(company.careerUrl, pages, f, { targets, skip, stored: input.storedIds, ownSite })
      if (read.board && (await tryBoard({ ...read.board, via: 'posting' }))) return finish()
      const jobs = confirmRoles(read.jobs, company.name)
      if (jobs.length + (read.confirmed - read.jobs.length) > 0) {
        out.checked.push(...read.checked)
        Object.assign(out, { tier: 'listing' as Tier, jobs, complete: false, listedIds: read.listedIds })
        tried.push({ tier: 'listing', outcome: 'roles' })
        return finish()
      }
      if (read.listed > 0) listedNoRoles = true
      // Postings the pages declare in their own markup (schema.org JobPosting): the employer's statement, no reading needed.
      const declared = new Map<string, AtsJob>()
      for (const p of pages) for (const j of readJobPostings(p.html, p.url)) if (ownSite(j.url)) declared.set(j.externalId, j)
      if (declared.size > 0) {
        Object.assign(out, { tier: 'listing' as Tier, jobs: [...declared.values()], complete: declared.size > 1 })
        tried.push({ tier: 'listing', outcome: 'roles' })
        return finish()
      }
      tried.push({ tier: 'listing', outcome: read.listed > 0 ? 'role_pages' : 'none' })
    } catch (error) {
      note(error)
      tried.push({ tier: 'listing', outcome: error instanceof ReaderError ? error.reason : 'none' })
    }
  }

  // The page as a browser builds it, then the model: scheduled passes only.
  const blocked = firstError && ['bot_check', 'login_required', 'robots'].includes((firstError as ReaderError).reason)
  if (!blocked) {
    if (f.mode === 'scheduled' && deps.fetchPage) {
      const rendered = await readRendered(input, deps, f)
      tried.push(...rendered.tried)
      if (rendered.tried.some((t) => t.outcome === 'role_pages')) listedNoRoles = true
      if (rendered.failure) {
        // The browser step crashed: that says nothing about the site, and must never read as "no roles".
        if (rendered.failure instanceof ReaderError) note(rendered.failure)
        else renderFailed = true
      }
      modelSkipped = rendered.modelSkipped
      if (rendered.result) {
        Object.assign(out, rendered.result)
        out.checked.push(...rendered.checked)
        return finish()
      }
    } else if (f.mode === 'inline' && deps.fetchPage !== undefined) {
      tried.push({ tier: 'rendered', outcome: 'skipped' })
    }
  }

  // Nothing yet.
  return conclude()
}

async function eightfoldPlaceOf(html: string, url: string, domain: string | null, f: SiteFetcher): Promise<string | undefined> {
  const id = /\/careers\/job\/(\d{5,})/.exec(url)?.[1]
  const token = id ? eightfoldBoards(html, url, domain ?? new URL(url).hostname)[0]?.token : undefined
  return id && token ? eightfoldPlace(f, token, id) : undefined
}

interface RenderedRead {
  result?: Partial<SiteRead>
  tried: TierTry[]
  checked: string[]
  /** The browser step could not run (or the site refused it): a ReaderError for the site's own answers, else the fetcher's error. */
  failure?: ReaderError | Error
  /** The rendered page held nothing to read without a model, and none was free: this says nothing about the site. */
  modelSkipped?: 'model_unavailable' | 'model_limit'
}

/** Never throws: a crash comes back as `failure`. */
async function readRendered(input: SiteInput, deps: SiteDeps, f: SiteFetcher): Promise<RenderedRead> {
  const { company, targets } = input
  const tried: TierTry[] = []
  let page
  try {
    page = await deps.fetchPage!(company.careerUrl, { render: true })
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('fetcher_failed')
    // The fetcher's error class (fetcher_failed, fetcher_<Class>, http_<n>), never an address.
    tried.push({ tier: 'rendered', outcome: failure instanceof ReaderError ? failure.reason : 'render_failed', detail: failure.message.slice(0, 60) })
    return { tried, checked: [], failure }
  }
  // A browser that was handed a bot check read nothing: say so, and never go on to "no roles".
  if (looksLikeChallenge(page.html)) {
    tried.push({ tier: 'rendered', outcome: 'bot_check' })
    return { tried, checked: [], failure: new ReaderError('bot_check') }
  }
  try {
    const rendered: PageRead[] = [{ url: page.finalUrl, html: page.html }]

    // Boards that only appear once the page has built itself (DigitalOcean's Greenhouse job links).
    for (const b of boardsInHtml(page.html, page.finalUrl, company.domain)) {
      if (deps.readBoard) {
        const board = await deps.readBoard(b, searchTerms(targets)).catch(() => null)
        if (board && board.jobs.length > 0) {
          tried.push({ tier: 'rendered', outcome: 'roles' })
          return { result: { tier: 'board', jobs: board.jobs, board, complete: false }, tried, checked: [] }
        }
      }
    }
    if (roleLinks(page.html, page.finalUrl).length > 0) {
      const read = await readListing(company.careerUrl, rendered, f, {
        targets,
        skip: input.checked,
        stored: input.storedIds,
        ownSite: (url) => onOwnSite(url, { company }),
      })
      const jobs = confirmRoles(read.jobs, company.name)
      if (jobs.length + (read.confirmed - read.jobs.length) > 0) {
        tried.push({ tier: 'rendered', outcome: 'roles' })
        return { result: { tier: 'rendered', jobs, complete: false, listedIds: read.listedIds }, tried, checked: read.checked }
      }
      // Role links the rendered page lists, whose own pages hold nothing readable: not "no roles", and not marked as checked.
      tried.push({ tier: 'rendered', outcome: 'role_pages' })
    }

    // JobPosting data on the rendered page, else a free model over a numbered snapshot, every role checked against the page.
    const read = await readCareersPage(
      { name: company.name, career_url: company.careerUrl },
      { fetchPage: async () => page, model: deps.model ?? null }
    )
    // A role from a third-party job host reaches storage only through a verified board (above): the model and the page's own
    // markup can name a link to anyone's board, so only roles on the employer's own site are kept here.
    const own = read.jobs.filter((j) => onOwnSite(j.url, { company }))
    const jobs = own.filter((j) => matchesTargets(j.title, targets))
    if (own.length > 0) {
      tried.push({ tier: read.modelCalls > 0 ? 'model' : 'rendered', outcome: 'roles' })
      return { result: { tier: read.modelCalls > 0 ? 'model' : 'rendered', jobs, complete: read.complete && own.length === read.jobs.length }, tried, checked: [] }
    }
    const modelSkipped = read.reason === 'model_unavailable' || read.reason === 'model_limit' ? read.reason : undefined
    tried.push({ tier: 'model', outcome: modelSkipped ? 'skipped' : 'none' })
    return { tried, checked: [], modelSkipped }
  } catch (error) {
    // Anything the rendered page's reading throws is the step failing, not the site having no roles.
    if (error instanceof ReaderError && error.reason !== 'budget') return { tried, checked: [], failure: error }
    const failure = error instanceof Error ? error : new Error('render_failed')
    tried.push({ tier: 'rendered', outcome: 'render_failed', detail: 'read_failed' })
    return { tried, checked: [], failure }
  }
}
