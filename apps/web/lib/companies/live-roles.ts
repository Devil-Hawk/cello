// The live read of one employer's open roles (part 6): everything the employer lists today, the
// person's own roles first, every other row with the reason it is not theirs, and a counted line whose
// parts add up to what was read. Nothing about the roles is stored: the only write is the employer's
// "of 636 open" number. The employer's answer is kept for ten minutes so paging does not read it again.
//
// A reason is the stage of the targets code that said no (lib/jobs/target-relevance.ts): place, age, an
// excluded company or word, level, and "Not one of your titles". While role_types_live is on the last one is
// two: "Other role type: Product Manager" and "Role type unknown". Each row carries its tier 1 type.

import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { providers, readCachedAts } from '../ats/index'
import { classifyJob } from '../jobs/classify'
import { hasPersonTargets, judgeForPerson, prepareTargets, type OutsideReason } from '../jobs/target-relevance'
import { readSite, type Tier } from '../ingest/reader'
import { getRoleType, typeTitle } from '../jobs/role-types'
import { makeSiteFetcher } from '../ingest/reader/site-fetch'
import { searchTerms, type ReaderTargets } from '../ingest/reader/targets'

type Db = SupabaseClient<any, any, any>

export const LIVE_PAGE_SIZE = 25
const REVALIDATE_SECONDS = 600
const REASONS: readonly OutsideReason[] = ['place', 'age', 'excluded', 'level', 'title', 'type', 'untyped']

/** What each reason says on a row. */
export const REASON_COPY: Record<OutsideReason, string> = {
  place: 'Outside the places you chose',
  age: 'Posted too long ago',
  excluded: 'An excluded company or word',
  level: 'Not your level',
  title: 'Not one of your titles',
  type: 'Other role type',
  untyped: 'Role type unknown',
}

/** What a row says about why it is not the person's: a type reason names the type. */
export function reasonText(row: Pick<LiveRow, 'reason' | 'role_type'>): string | null {
  if (!row.reason) return null
  if (row.reason === 'type' && row.role_type) return `Other role type: ${getRoleType(row.role_type)?.label ?? row.role_type}`
  return REASON_COPY[row.reason]
}

export interface LiveCompany {
  /** The person's own company row. */
  id: string
  name: string
  domain: string | null
  career_url: string | null
  metadata?: unknown
  employer_id?: string | null
}

export interface LiveRow {
  title: string
  /** The employer's own key for the posting: what the preview address carries instead of a link. */
  key: string
  url: string
  location: string | null
  postedAt: string | null
  /** The role's type by tier 1 (lib/jobs/role-types), null when no rule placed the title. */
  role_type: string | null
  /** The level the title reads as. */
  level: string
  /** Null for a role that is inside the person's targets. */
  reason: OutsideReason | null
  /** The stored role the person holds, when they hold it. */
  jobId: string | null
}

/** What narrows the list before it is paged: words of the title, a role type, a place, or one posting's key. */
export interface LiveMatch {
  words?: string
  type?: string
  place?: string
  key?: string
}

export interface LiveRoles {
  /** This page: the person's roles first, then the others in the employer's order. */
  rows: LiveRow[]
  /** Rows after the match (every row without one): what the pages are cut from. kept, counts and total stay the whole read's. */
  matched: number
  /** Roles inside the person's targets; kept + the counts = total. */
  kept: number
  counts: Record<OutsideReason, number>
  /** Every role the employer listed. */
  total: number
  page: number
  pages: number
  tier: Tier | null
  /** The read saw part of the employer's roles (its search, a few pages), not all of them. */
  window: boolean
  /** Why nothing could be read, or null. */
  failure: string | null
}

interface Listed {
  externalId: string
  title: string
  url: string
  location: string | null
  postedAt: string | null
  job_function: string
  seniority: string
  country: string | null
  language: string
  is_remote: boolean
  title_norm: string
  role_type: string | null
}

interface Read {
  tier: Tier | null
  listed: Listed[]
  complete: boolean
  failure: string | null
}

/** Slim, so the ten-minute copy stays small: the classified listing, never the descriptions. */
function slim(jobs: { title: string; url: string; externalId: string; location?: string; postedAt?: string; description?: string }[], companyName: string): Listed[] {
  const seen = new Set<string>()
  const out: Listed[] = []
  for (const j of jobs) {
    const title = typeof j.title === 'string' ? j.title.trim() : ''
    if (!title || typeof j.url !== 'string' || !/^https?:\/\//i.test(j.url)) continue
    const key = j.externalId || j.url
    if (seen.has(key)) continue
    seen.add(key)
    const c = classifyJob({ title, description: j.description, location: j.location, companyName })
    const t = typeTitle(title)
    out.push({
      externalId: key,
      title,
      url: j.url,
      location: j.location ?? null,
      postedAt: j.postedAt ?? null,
      job_function: c.jobFunction,
      seniority: c.seniority,
      country: c.country,
      language: c.language,
      is_remote: c.isRemote,
      title_norm: t.title_norm,
      role_type: t.role_type,
    })
  }
  return out
}

async function read(company: LiveCompany, targets: ReaderTargets): Promise<Read> {
  const query = searchTerms(targets)
  const board = readCachedAts(company.metadata)
  if (board) {
    const provider = providers[board.provider]
    // hasDescription true: a listing is all this read needs, so no second request per posting.
    const jobs = await provider.fetch(board.token, { hasDescription: () => true, ...(query.length ? { query } : {}) })
    const windowed = provider.searchesByQuery === true && query.length > 0
    return { tier: 'board', listed: slim(jobs, company.name), complete: !windowed && !(provider.maxJobs && jobs.length >= provider.maxJobs), failure: null }
  }
  // ponytail: a board found only by discovery is not verified here; a check stores its pointer first, then this reads it as a board.
  const careerUrl = company.career_url?.trim()
  if (!careerUrl) return { tier: null, listed: [], complete: false, failure: 'no_careers_url' }
  const site = await readSite(
    { company: { name: company.name, domain: company.domain, careerUrl }, targets },
    { fetcher: makeSiteFetcher({ mode: 'inline' }), renderedLater: false }
  )
  return { tier: site.tier, listed: slim(site.jobs, company.name), complete: site.complete, failure: site.tier ? null : (site.reason ?? 'no_roles') }
}

/** The words of a search as the stored title key spells them, so "forward deployed" finds "Forward-Deployed Engineer". */
function wordsOf(words: string): string[] {
  const norm = typeTitle(words).title_norm
  return (norm || words.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Does one listed role pass the match? Every word of the search is in its title; type, place and key are exact or contained. */
function matchesOne(l: Listed, m: LiveMatch | undefined): boolean {
  if (!m) return true
  if (m.key !== undefined && l.externalId !== m.key) return false
  if (m.type && l.role_type !== m.type) return false
  if (m.place && !(l.location ?? '').toLowerCase().includes(m.place.toLowerCase())) return false
  if (m.words) {
    const title = l.title.toLowerCase()
    if (!wordsOf(m.words).every((w) => l.title_norm.includes(w) || title.includes(w))) return false
  }
  return true
}

/** Every role the employer lists, judged for this person, paged. Writes only the employer's open count. */
export async function liveRoles(input: { db: Db; userId: string; company: LiveCompany; targets: ReaderTargets; page?: number; match?: LiveMatch }): Promise<LiveRoles> {
  const { db, userId, company, targets } = input
  const query = searchTerms(targets).join('|')
  const board = readCachedAts(company.metadata)
  const cached = unstable_cache(() => read(company, targets), ['live-roles', board ? `${board.provider}:${board.token}` : `site:${company.id}`, query], { revalidate: REVALIDATE_SECONDS })

  let got: Read
  try {
    got = await cached()
  } catch {
    got = { tier: null, listed: [], complete: false, failure: 'unreachable' }
  }

  // The person's own roles at this employer, by the employer's id for them.
  // ponytail: 5,000 held roles at one employer is far beyond the 1,500 a person can hold per company.
  // They are the person's by their own company row, or by the employer's id when the person does not follow it.
  const mineQuery = db.from('person_jobs').select('id, external_id').eq('viewer_id', userId)
  const { data: held } = await (company.employer_id ? mineQuery.or(`viewer_company_id.eq.${company.id},employer_id.eq.${company.employer_id}`) : mineQuery.eq('viewer_company_id', company.id)).limit(5000)
  const heldByExternal = new Map(((held ?? []) as { id: string; external_id: string | null }[]).filter((h) => h.external_id).map((h) => [h.external_id as string, h.id]))

  const person = { targeting: targets.targeting, titles: targets.titles, typeStep: targets.typeStep }
  const stated = hasPersonTargets(person)
  const prepared = prepareTargets(person.titles)
  type Entry = { row: LiveRow; l: Listed }
  const mine: Entry[] = []
  const rest: Entry[] = []
  const others: Entry[] = []
  const counts = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<OutsideReason, number>
  for (const l of got.listed) {
    const verdict = stated
      ? judgeForPerson({ title: l.title, job_function: l.job_function, seniority: l.seniority, country: l.country, language: l.language, is_remote: l.is_remote, postedAt: l.postedAt, title_norm: l.title_norm, role_type: l.role_type }, person, company.name, prepared)
      : ({ keep: true, hidden: false } as const)
    const row: LiveRow = { title: l.title, key: l.externalId, url: l.url, location: l.location, postedAt: l.postedAt, role_type: l.role_type, level: l.seniority, reason: verdict.keep ? null : verdict.reason, jobId: heldByExternal.get(l.externalId) ?? null }
    if (verdict.keep) (row.jobId ? mine : rest).push({ row, l })
    else {
      counts[verdict.reason]++
      others.push({ row, l })
    }
  }
  const all = [...mine, ...rest, ...others].filter((e) => matchesOne(e.l, input.match)).map((e) => e.row)
  const pages = Math.max(1, Math.ceil(all.length / LIVE_PAGE_SIZE))
  const page = Math.min(Math.max(0, Math.floor(input.page ?? 0)), pages - 1)

  // The employer's "of N open" is the last whole read; a window is not a count.
  if (company.employer_id && got.tier === 'board' && got.complete) {
    await db.rpc('set_employer_open_count', { p_employer: company.employer_id, p_count: got.listed.length }).then(() => undefined, () => undefined)
  }

  return {
    rows: all.slice(page * LIVE_PAGE_SIZE, (page + 1) * LIVE_PAGE_SIZE),
    matched: all.length,
    kept: mine.length + rest.length,
    counts,
    total: got.listed.length,
    page,
    pages,
    tier: got.tier,
    window: got.tier !== null && !got.complete,
    failure: got.failure,
  }
}
