// companies.find: look for an employer by its name, the way a person would, cheapest and most trustworthy first.
//
// Five rungs run in order, each a function that returns candidates; the first rung that finds any ends the search (a
// sixth, the paste-a-link line, is what is said when none does). Every candidate is proven before it is shown: a board the
// provider ties to the employer, a board the employer's site links, or roles the site lists itself. A name that merely
// looks right is never a candidate. The whole search has a time budget, and ends with what it has when that runs out.
//
// A search writes nothing about an employer. The one thing it can queue is a web search for the pull worker, when no
// search key is set. Choosing a candidate is the add (add-link.ts), which proves it again.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile } from '../access/guardrails'
import { candidateTokens } from '../ats/detect'
import type { AtsProviderId } from '../ats/types'
import { IDENTIFY } from '../ats/verify'
import { normalizeCompanyName } from '../entities/companies'
import { NO_TARGETS } from '../ingest/reader/targets'
import { getTavilyKey } from '../search/keys'
import { addCompany, employerDomain, followedRow, realAddDeps, type AddBy, type AddDeps } from './add-link'
import type { DirectoryRow } from './directory'
import { isKnownEmployer, knownBoard, lookupKnownCompanyByName } from './known-companies'
import { queueRenderJob } from './render-jobs'
import { checkBoard, realDeps, type VerifyDeps } from './verify-directory'
import { searchCareersDomains } from './web-search'
import { lookupWikidata, registrable, toProfile, type WikidataEntity } from './wikidata'

type Db = SupabaseClient<any, any, any>

export type Rung = 'directory' | 'boards' | 'lookup' | 'site' | 'web'

/** An employer a search found and proved, for the person to choose. Nothing about it is stored until they do. */
export interface Candidate {
  name: string
  domain: string | null
  provider?: AtsProviderId
  token?: string
  /** The address the employer's own roles were read at, for an employer with no applicant system. */
  careersUrl?: string
  foundBy: 'directory' | 'board' | 'wikidata' | 'site' | 'web'
  /** In words, why this is the employer's: "its site links the board". */
  provenBy: string
  /** Open roles, null before a read. */
  jobs: number | null
  city?: string | null
  profile?: ReturnType<typeof toProfile>
  employerId?: string
  candidateId?: string
  following?: boolean
}

export type FindResult = { candidates: Candidate[] } | { none: true; line: string; queued?: boolean }

export interface FindDeps {
  verify: VerifyDeps
  /** The reader's plain tiers over an address (roles listed on a site). */
  read: AddDeps['read']
  wikidata: (name: string) => Promise<WikidataEntity[]>
  /** The employer domains a web search names for the name; null when there is no search key to ask with. */
  web: (name: string) => Promise<string[] | null>
  /** Hand the search to the pull worker; its job id, or null when it was not queued. */
  queue: (name: string) => Promise<string | null>
  timeoutMs?: number
}

export const SEARCH_BUDGET_MS = 30_000
const MAX_CANDIDATES = 3

export function realFindDeps(db: Db, userId: string | null): FindDeps {
  return {
    verify: realDeps,
    read: realAddDeps.read,
    wikidata: (name) => lookupWikidata(name),
    web: async (name) => searchCareersDomains(name, process.env.TAVILY_API_KEY?.trim() || (userId ? await getTavilyKey(db, userId).catch(() => undefined) : undefined)),
    queue: async (name) => {
      if (!userId) return null
      // A demo account may search, but it queues nothing.
      const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
      return isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null) ? null : queueRenderJob(db, { kind: 'web_search', query: name, requestedBy: userId })
    },
  }
}

// --- proof -------------------------------------------------------------------------

const squash = (s: string) => normalizeCompanyName(s).replace(/ /g, '')

/** Why an employer is the one: the evidence the verifier accepted, in words. */
function provenBy(verifiedBy: string, domain: string | null): string {
  switch (verifiedBy) {
    case 'careers_page_link':
      return 'its site links the board'
    case 'board_links_home':
      return domain ? `the board declares ${domain} as home` : 'its postings point to the employer'
    case 'known_board':
      return 'a board Cello checked by hand'
    case 'careers_url_host':
      return 'roles listed on the site'
    default:
      return "the provider's record names the employer"
  }
}

/**
 * Is there an employer at this domain, and can Cello show it? The boards its site links, each through the verifier; else
 * the roles its own site lists. Null when neither holds, so a parked or unrelated domain never appears.
 */
async function proveDomain(name: string, domain: string, foundBy: Candidate['foundBy'], deps: FindDeps): Promise<Candidate | null> {
  const careersUrl = `https://${domain}/careers`
  const boards = await deps.verify.pageBoards({ careerUrl: careersUrl, domain }).catch(() => [])
  for (const b of boards.slice(0, 3)) {
    const check = await checkBoard({ name, domain, careerUrl: careersUrl, provider: b.provider, token: b.token }, deps.verify)
    if (check.ok) return { name: check.name, domain, provider: b.provider, token: b.token, foundBy, provenBy: provenBy(check.verifiedBy, domain), jobs: check.jobs.length }
  }
  const read = await deps.read({ company: { name, domain, careerUrl: careersUrl }, targets: NO_TARGETS }, async () => null)
  // ponytail: the address is /careers; a site that lists its roles elsewhere is proven through the page it links, not remembered here.
  if (read.tier && read.tier !== 'board' && read.jobs.length > 0) return { name, domain, careersUrl, foundBy, provenBy: provenBy('careers_url_host', domain), jobs: read.complete ? read.jobs.length : null }
  return null
}

const settled = async <T>(work: Promise<T>[]): Promise<NonNullable<T>[]> =>
  (await Promise.allSettled(work)).flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value as NonNullable<T>] : []))

// --- the rungs ---------------------------------------------------------------------

/** Rung 1: a verified employer by exact name or domain, a seed candidate by exact name, a big employer from its curated address. */
async function fromDirectory(db: Db, userId: string, name: string): Promise<Candidate[]> {
  const want = squash(name)
  const { data } = await db.rpc('search_company_directory', { p_query: name, p_limit: 8 })
  const rows = ((data ?? []) as DirectoryRow[]).filter((r) => squash(r.name) === want || (r.domain != null && (r.domain === name.toLowerCase() || squash(r.domain.split('.')[0]) === want)))
  if (rows.length > 0) {
    return Promise.all(
      rows.slice(0, MAX_CANDIDATES).map(async (r): Promise<Candidate> => ({
        name: r.name,
        domain: r.domain,
        provider: (r.ats_provider as AtsProviderId | null) ?? undefined,
        token: r.ats_token ?? undefined,
        foundBy: 'directory',
        provenBy: provenBy(r.verified_by ?? '', r.domain),
        jobs: r.open_count,
        city: r.hq ?? null,
        profile: (r.profile as Candidate['profile']) ?? undefined,
        employerId: r.id,
        following: !!(await followedRow(db, userId, { employerId: r.id, domain: r.domain })),
      }))
    )
  }
  const { data: pending } = await db.from('directory_candidates').select('id, name, domain').eq('state', 'pending').eq('name_norm', normalizeCompanyName(name)).limit(MAX_CANDIDATES)
  const seeds = ((pending ?? []) as { id: string; name: string; domain: string | null }[]).map((c): Candidate => ({ name: c.name, domain: c.domain, foundBy: 'directory', provenBy: 'on the seed list, not checked yet', jobs: null, candidateId: c.id }))
  if (seeds.length > 0) return seeds
  const known = lookupKnownCompanyByName(name)
  if (!known) return []
  const board = knownBoard({ domain: known.domain })
  if (board) return [{ name: known.name, domain: known.domain, ...board, foundBy: 'directory', provenBy: provenBy('known_board', known.domain), jobs: null }]
  if (known.careerUrl) return [{ name: known.name, domain: employerDomain(new URL(known.careerUrl).hostname), careersUrl: known.careerUrl, foundBy: 'directory', provenBy: 'its curated careers address', jobs: null }]
  return []
}

/** Rung 2: the name's slug forms on every applicant system that can be asked safely, each hit through the verifier. */
async function fromBoards(name: string, deps: FindDeps): Promise<Candidate[]> {
  const probes = (Object.keys(IDENTIFY) as AtsProviderId[]).flatMap((provider) => candidateTokens(null, name).map((token) => ({ provider, token })))
  return settled(
    probes.map(async ({ provider, token }): Promise<Candidate | null> => {
      const check = await checkBoard({ name, domain: null, provider, token }, deps.verify)
      return check.ok ? { name: check.name, domain: check.domain, provider, token, foundBy: 'board', provenBy: provenBy(check.verifiedBy, check.domain), jobs: check.jobs.length } : null
    })
  )
}

/** Rung 3: Wikidata's organisations with that label; the website each names goes through the same proof as a pasted link. */
async function fromWikidata(name: string, deps: FindDeps): Promise<Candidate[]> {
  const entities = await deps.wikidata(name)
  return settled(
    entities.map(async (e): Promise<Candidate | null> => {
      const domain = registrable(e.website)
      const proven = domain ? await proveDomain(e.label, domain, 'wikidata', deps) : null
      return proven && { ...proven, provenBy: `Wikidata names ${domain}; ${proven.provenBy}`, city: e.hq, profile: toProfile(e) }
    })
  )
}

const TLDS = ['com', 'ai', 'io', 'co']

/** "Retell AI" -> retellai.com, retellai.ai, retell-ai.io, retell.ai ... : addresses to try, never to show unproven. */
export function guessDomains(name: string): string[] {
  const lower = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean)
  const bases = new Set([words.join(''), words.join('-')])
  const last = words[words.length - 1]
  // "Retell AI" is also retell.ai: the last word can be the suffix.
  const out = words.length > 1 && TLDS.includes(last) ? [`${words.slice(0, -1).join('')}.${last}`] : []
  for (const base of bases) if (base.length >= 2) for (const tld of TLDS) out.push(`${base}.${tld}`)
  return [...new Set(out)]
}

/** Rung 4: the guessed addresses, shown only when a board proves or the site lists roles. */
const fromGuesses = (name: string, deps: FindDeps) => settled(guessDomains(name).map((domain) => proveDomain(name, domain, 'site', deps)))

/** Rung 5: the web's top employer domains through the same proof; without a search key the worker is asked to search. */
async function fromWeb(name: string, deps: FindDeps, asked: { queued: boolean }): Promise<Candidate[]> {
  const domains = await deps.web(name)
  if (domains === null) {
    asked.queued = (await deps.queue(name)) !== null
    return []
  }
  return settled(domains.map((domain) => proveDomain(name, domain, 'web', deps)))
}

// --- the ladder --------------------------------------------------------------------

/** One employer once: by domain, then by board, then by directory row. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter((c) => {
    const keys = [c.domain && `d:${c.domain}`, c.provider && c.token && `b:${c.provider}:${c.token.toLowerCase()}`, c.employerId && `e:${c.employerId}`].filter((k): k is string => !!k)
    if (keys.some((k) => seen.has(k))) return false
    keys.forEach((k) => seen.add(k))
    return true
  })
}

export async function findEmployer(db: Db, userId: string, rawName: string, deps: FindDeps, report: (event: { rung: Rung; line: string }) => void = () => {}): Promise<FindResult> {
  const name = rawName.trim()
  const budget = AbortSignal.timeout(deps.timeoutMs ?? SEARCH_BUDGET_MS)
  const outOfTime = new Promise<'time'>((resolve) => budget.addEventListener('abort', () => resolve('time'), { once: true }))
  const asked = { queued: false }
  // The big employers are offered from their curated address and never slug-matched onto a namesake's board.
  const big = isKnownEmployer({ name })
  const rungs: [Rung, string, boolean, () => Promise<Candidate[]>][] = [
    ['directory', 'Checking the directory', true, () => fromDirectory(db, userId, name)],
    ['boards', 'Checking job boards', !big, () => fromBoards(name, deps)],
    ['lookup', 'Looking it up', true, () => fromWikidata(name, deps)],
    ['site', 'Trying its website', true, () => fromGuesses(name, deps)],
    ['web', 'Searching the web', true, () => fromWeb(name, deps, asked)],
  ]
  let found: Candidate[] = []
  for (const [rung, line, runs, run] of rungs) {
    if (!runs) continue
    if (budget.aborted) break
    report({ rung, line })
    // A rung that fails or runs the budget out finds nothing; the next one still gets its turn if there is time.
    const hits = await Promise.race([run().catch((): Candidate[] => []), outOfTime])
    if (hits === 'time') break
    found = dedupe(hits).slice(0, MAX_CANDIDATES)
    if (found.length > 0) break
  }
  if (found.length > 0) return { candidates: found }
  return asked.queued
    ? { none: true, queued: true, line: `Cello is still searching the web for ${name}; it will appear on Companies when found.` }
    : { none: true, line: `Cello could not find ${name}. Paste its careers link.` }
}

// --- choosing ----------------------------------------------------------------------

/** What the add runs for a chosen candidate: its row, its seed row, its proven board or its proven site. */
export function addByOf(c: Candidate): AddBy | null {
  if (c.employerId) return { employerId: c.employerId }
  if (c.candidateId) return { candidateId: c.candidateId }
  const qid = c.profile?.qid
  if (c.provider && c.token) return { board: { provider: c.provider, token: c.token, name: c.name, domain: c.domain, qid } }
  return c.domain && c.careersUrl ? { site: { domain: c.domain, careersUrl: c.careersUrl, name: c.name, qid } } : null
}

/**
 * The worker's answer to a queued web search: the domains it read from a results page go through the same proof, and the
 * first employer proven is added for the person who asked (the add proves it again and follows it).
 */
export async function findFromJob(db: Db, jobId: string, deps: FindDeps = realFindDeps(db, null), add: AddDeps = realAddDeps): Promise<{ added: boolean }> {
  const { data } = await db.from('render_jobs').select('kind, query, state, result, requested_by').eq('id', jobId).maybeSingle()
  const job = data as { kind: string; query: string | null; state: string; result: { domains?: { domain: string }[] } | null; requested_by: string | null } | null
  if (!job || job.kind !== 'web_search' || job.state !== 'done' || !job.query || !job.requested_by) return { added: false }
  for (const { domain } of job.result?.domains ?? []) {
    const proven = await proveDomain(job.query, domain, 'web', deps).catch(() => null)
    const by = proven && addByOf(proven)
    if (by && (await addCompany(db, job.requested_by, by, add)).ok) return { added: true }
  }
  return { added: false }
}

/** What a finished browser job means for the person who asked: a proven search or page puts the employer on their Companies. */
export async function followForJob(db: Db, job: { id: string; kind: string; requested_by?: string | null }, employerId: string | null): Promise<void> {
  if (job.kind === 'web_search') await findFromJob(db, job.id)
  else if (employerId && job.requested_by) await addCompany(db, job.requested_by, { employerId }, realAddDeps)
}
