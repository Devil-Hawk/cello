// "Suggested for you": companies the person does not watch yet, ranked by real
// hiring evidence. Pure: no database, no network. lib/companies/refresh.ts
// gathers the inputs and stores the result.
//
// RANKING IS TIERS, NOT WEIGHTS. A points blend would hide why one company
// beats another; tiers can be explained in a sentence and tested.
//   T1  roles matching the person's targets are open on the company's OWN live
//       job board (checked today)
//   T2  two or more matching postings on the aggregators Cello reads
//   T3  one matching posting, including HN "Who is hiring"
//   T4  similar to a company the person likes, with no matching role found
// Within a tier: more matching roles, then the newest posting, then more shared
// tags, then name.
//
// THE REASON IS A TEMPLATE over counts and links that code just read. No model
// writes it, so it cannot drift from its evidence, and every row carries a link
// to where the evidence lives (a live board, a posting or a thread).
//
// ponytail: tiers are fixed; reorder by per-tier Add rate once 20+ actions exist

import { parseTitle } from '../matching/title-rank'
import { classifyJob } from '../jobs/classify'
import { compileKeyword } from '../sources/util'
import type { JobLead, SourceId } from '../sources/types'
import type { Targeting } from '../targeting'
import { normalizeCompanyName } from '../entities/companies'
import { identityKey, normalizeDomain } from './identity'
import { faviconForDomain } from './known-companies'
import { locationVerdict, type LocationPrefs } from './location'
import { buildVocabulary, isSimilar, sharedTags, type Vocabulary } from './similarity'
import type { AtsProviderName, BoardHit, SuggestionSignal, SuggestionTier, YcRow } from './types'

export const MAX_SUGGESTIONS = 30
const MAX_REASON = 160

export interface SuggestionInputs {
  /** The person's target job titles (lib/targeting/titles.ts). */
  targets: string[]
  targeting: Targeting
  /** Resume skill keywords, used only when no titles or functions are set. */
  keywords: string[]
  prefs: LocationPrefs
  /** Companies the person already watches (shells excluded), any merge state. */
  watched: { name: string; domain: string | null }[]
  /** Lowercase names to never suggest, matched as substrings. */
  excludedNames: string[]
  /** company_key of suggestions the person dismissed or already added. */
  actedKeys: string[]
  /** Companies the person likes, with their tags already read. */
  liked: { name: string; domain: string | null; tags: string[] }[]
}

// Stems as lib/matching/title-rank.ts produces them ("engineer" -> "engine", "developer" -> "develop").
const ENGINEER_STEM = parseTitle('engineer').words[0].stem
const DEVELOPER_STEM = parseTitle('developer').words[0].stem
const LEADERSHIP_STEMS = new Set(['manager', 'director', 'head', 'vp', 'president', 'chief', 'recruiter'].map((w) => parseTitle(w).words[0].stem))
/** A seniority word weighs 1 in title-rank; every other word weighs more. */
const SENIORITY_WEIGHT = parseTitle('senior').words[0].weight

export interface RoleMatch {
  matched: boolean
  /** What matched, in the person's own terms: the target title, function or skill. */
  label: string
}

export type RoleMatcher = (lead: { title: string; description?: string; tags?: string[] }) => RoleMatch

/**
 * The strongest stated signal decides what a role match means: target titles
 * (every core word of a target must sit together in the posting's title, so
 * "Design Engineer" is not a "Backend Engineer"), else job functions, else resume
 * keywords that hit the TITLE. With none of
 * them there is nothing to match against, and the answer is null (the caller
 * says "tell Cello which roles you want"). It never guesses.
 */
export function roleMatcher(inputs: Pick<SuggestionInputs, 'targets' | 'targeting' | 'keywords'>): RoleMatcher | null {
  if (inputs.targets.length > 0) {
    const parsed = inputs.targets.map(parseTitle).filter((t) => t.coreCount > 0)
    return (lead) => {
      const words = parseTitle(lead.title).words.map((w) => w.stem)
      const positions = new Map(words.map((stem, i) => [stem, i]))
      const job = new Set(words)
      // "developer" and "engineer" name the same job to someone looking for one.
      if (job.has(DEVELOPER_STEM) && !job.has(ENGINEER_STEM)) positions.set(ENGINEER_STEM, positions.get(DEVELOPER_STEM) as number)
      if (job.has(ENGINEER_STEM) && !job.has(DEVELOPER_STEM)) positions.set(DEVELOPER_STEM, positions.get(ENGINEER_STEM) as number)
      for (const k of positions.keys()) job.add(k)
      if ([...LEADERSHIP_STEMS].some((w) => job.has(w))) {
        // A manager or director is a different job from the IC role asked for, unless the target says so.
        const asked = new Set(parsed.flatMap((t) => t.words.map((w) => w.stem)))
        if ([...LEADERSHIP_STEMS].some((w) => job.has(w) && !asked.has(w))) return { matched: false, label: '' }
      }
      for (const target of parsed) {
        const core = target.words.filter((w) => w.weight > SENIORITY_WEIGHT).map((w) => w.stem)
        const at = core.map((stem) => positions.get(stem))
        if (at.some((i) => i === undefined)) continue
        // The words must sit together: at most one other word inside the span, so
        // "Mobile Engineer, Kotlin and Cross-Platform" is not a Platform Engineer.
        const span = Math.max(...(at as number[])) - Math.min(...(at as number[])) + 1
        if (span <= core.length + 1) return { matched: true, label: target.raw }
      }
      return { matched: false, label: '' }
    }
  }
  if (inputs.targeting.functions.length > 0) {
    const wanted = new Set(inputs.targeting.functions)
    return (lead) => {
      const fn = classifyJob({ title: lead.title, description: lead.description ?? '', location: null, companyName: '' }).jobFunction
      return { matched: wanted.has(fn), label: wanted.has(fn) ? fn.replace(/[-_]/g, ' ') : '' }
    }
  }
  if (inputs.keywords.length > 0) {
    const matchers = inputs.keywords.map((k) => ({ k, test: compileKeyword(k.trim().toLowerCase()) }))
    return (lead) => {
      const title = ` ${lead.title.toLowerCase()} `
      const hit = matchers.find((m) => m.test(title))
      return { matched: !!hit, label: hit?.k ?? '' }
    }
  }
  return null
}

const SOURCE_LABELS: Record<SourceId, string> = {
  themuse: 'The Muse',
  arbeitnow: 'Arbeitnow',
  remoteok: 'RemoteOK',
  hackernews: 'HN Who is hiring',
  ycombinator: 'Y Combinator',
  echojobs: 'EchoJobs',
  remotive: 'Remotive',
  weworkremotely: 'We Work Remotely',
  himalayas: 'Himalayas',
  workingnomads: 'Working Nomads',
  jobicy: 'Jobicy',
  web_search: 'Web search',
}

const PROVIDER_LABELS: Record<AtsProviderName, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  recruitee: 'Recruitee',
  personio: 'Personio',
  eightfold: 'Eightfold',
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What a posting's link should be: HN uses the thread comment, not the apply URL. */
function postingUrl(lead: JobLead): string {
  if (lead.source === 'hackernews' && /^https?:\/\//.test(lead.externalId)) return lead.externalId
  return lead.url
}

interface Candidate {
  key: string
  name: string
  domain: string | null
  logoUrl: string | null
  board: { hit: BoardHit; matching: BoardHit['jobs'] } | null
  postings: JobLead[] // matching, location-ok, newest first
  roleLabel: string
  yc: { row: YcRow; liked: string; shared: string[] } | null
}

export interface SuggestionDraft {
  key: string
  name: string
  domain: string | null
  logoUrl: string | null
  tier: SuggestionTier
  rank: number
  reason: string
  sourceUrl: string
  sourceLabel: string
  signals: SuggestionSignal[]
  ats: { provider: AtsProviderName; openRoles: number; matchingRoles: number } | null
}

/** The reason sentence, source link and label for one candidate at its tier. Always under 160 characters. */
export function reasonFor(c: Candidate, tier: SuggestionTier): { reason: string; sourceUrl: string; sourceLabel: string } {
  const label = clip(c.roleLabel, 40)
  if (tier === 1 && c.board) {
    const { hit, matching } = c.board
    const provider = PROVIDER_LABELS[hit.provider]
    const best = clip(matching[0].title, 60)
    const reason =
      matching.length === 1
        ? `Has an open "${best}" role on its ${provider} board (${plural(hit.openRoles, 'role', 'roles')} open).`
        : `${matching.length} open roles match ${label} on its ${provider} board, such as "${best}".`
    return { reason: clip(reason, MAX_REASON), sourceUrl: hit.boardUrl, sourceLabel: `${provider} board` }
  }
  if ((tier === 2 || tier === 3) && c.postings.length > 0) {
    const newest = c.postings[0]
    const hn = newest.source === 'hackernews'
    const sources = [...new Set(c.postings.map((p) => (p.source === 'hackernews' ? 'HN Who is hiring' : SOURCE_LABELS[p.source])))]
    const title = clip(newest.title, 60)
    const reason =
      tier === 2
        ? `${c.postings.length} postings match ${label}, on ${list(sources)}, newest "${title}".`
        : hn
          ? `Hiring in the latest HN Who is hiring thread: "${title}".`
          : `Has an open "${title}" posting on ${SOURCE_LABELS[newest.source]}.`
    return {
      reason: clip(reason, MAX_REASON),
      sourceUrl: postingUrl(newest),
      sourceLabel: hn ? 'HN Who is hiring' : `${SOURCE_LABELS[newest.source]} posting`,
    }
  }
  const y = c.yc as NonNullable<Candidate['yc']>
  const tags = y.shared.slice(0, 2)
  const reason = `Similar to ${clip(y.liked, 40)}, which you like: ${tags.length > 1 ? `shares ${list(tags)}` : `both work on ${tags[0]}`}.`
  return { reason: clip(reason, MAX_REASON), sourceUrl: y.row.profile_url as string, sourceLabel: 'YC profile' }
}

function signalsFor(c: Candidate, tier: SuggestionTier): SuggestionSignal[] {
  const out: SuggestionSignal[] = []
  if (c.board && c.board.matching.length > 0) {
    out.push({
      kind: 'board',
      url: c.board.hit.boardUrl,
      label: `${PROVIDER_LABELS[c.board.hit.provider]} board`,
      title: c.board.matching[0].title,
      location: c.board.matching[0].location,
      postedAt: c.board.matching[0].postedAt,
      count: c.board.matching.length,
    })
  }
  for (const p of c.postings.slice(0, 3)) {
    out.push({
      kind: p.source === 'hackernews' ? 'thread' : 'posting',
      url: postingUrl(p),
      label: p.source === 'hackernews' ? 'HN Who is hiring' : `${SOURCE_LABELS[p.source]} posting`,
      title: p.title,
      location: p.location,
      postedAt: p.postedAt ?? null,
    })
  }
  if (tier === 4 && c.yc) {
    out.push({ kind: 'similar', url: c.yc.row.profile_url as string, label: 'YC profile', location: c.yc.row.locations, liked: c.yc.liked, tags: c.yc.shared.slice(0, 4) })
  }
  return out
}

/** Does a company the person already has, dislikes or acted on rule this one out? */
function makeExcluder(inputs: SuggestionInputs) {
  const domains = new Set(inputs.watched.map((w) => normalizeDomain(w.domain)).filter((d): d is string => !!d))
  const nameKeys = new Set(inputs.watched.map((w) => normalizeCompanyName(w.name)).filter(Boolean))
  const acted = new Set(inputs.actedKeys)
  const excludedNames = inputs.excludedNames.map((n) => n.toLowerCase().trim()).filter(Boolean)
  return (name: string, domain: string | null, key: string): boolean => {
    if (acted.has(key)) return true
    if (domain && domains.has(domain)) return true
    if (nameKeys.has(normalizeCompanyName(name))) return true
    const lower = name.toLowerCase()
    return excludedNames.some((n) => lower.includes(n))
  }
}

const STALE_MS = 60 * 24 * 3600 * 1000

/** A posting older than 60 days is not evidence of hiring now. An unknown date is kept. */
function stale(lead: JobLead, now: Date): boolean {
  const t = lead.postedAt ? Date.parse(lead.postedAt) : NaN
  return !Number.isNaN(t) && now.getTime() - t > STALE_MS
}

function postedMs(lead: JobLead): number {
  const t = lead.postedAt ? Date.parse(lead.postedAt) : NaN
  return Number.isNaN(t) ? 0 : t
}

export interface ProbeTarget {
  key: string
  name: string
  domain: string | null
}

/** Companies the aggregators show hiring that the person has not ruled out, whose own boards are worth checking. */
export function leadCompanies(inputs: SuggestionInputs, leads: JobLead[], directory: YcRow[]): ProbeTarget[] {
  const excluded = makeExcluder(inputs)
  const byNameKey = new Map(directory.map((r) => [r.name_key, r]))
  const out = new Map<string, ProbeTarget>()
  for (const lead of leads) {
    if (lead.source === 'ycombinator') continue
    const name = lead.company?.trim()
    if (!name) continue
    const domain = normalizeDomain(lead.companyDomain) ?? normalizeDomain(byNameKey.get(normalizeCompanyName(name))?.domain)
    const key = identityKey(domain, null, name)
    if (!out.has(key) && !excluded(name, domain, key)) out.set(key, { key, name, domain })
  }
  return [...out.values()]
}

/**
 * Rank candidate companies. Returns null when the person has given no signal to
 * match roles against (no titles, functions or skills): the refresh then says
 * needs_targeting instead of guessing.
 */
export function buildSuggestions(
  inputs: SuggestionInputs,
  leads: JobLead[],
  directory: YcRow[],
  boardHits: Map<string, BoardHit>,
  now: Date = new Date()
): SuggestionDraft[] | null {
  const matcher = roleMatcher(inputs)
  if (!matcher) return null
  const excluded = makeExcluder(inputs)

  const byNameKey = new Map<string, YcRow>()
  for (const r of directory) if (!byNameKey.has(r.name_key)) byNameKey.set(r.name_key, r)

  const candidates = new Map<string, Candidate>()
  const ensure = (name: string, domain: string | null): Candidate => {
    const key = identityKey(domain, null, name)
    let c = candidates.get(key)
    if (!c) {
      c = { key, name, domain, logoUrl: domain ? faviconForDomain(domain) : null, board: null, postings: [], roleLabel: '', yc: null }
      candidates.set(key, c)
    }
    return c
  }

  // 1. Aggregator postings that match the person's roles and sit in scope.
  for (const lead of leads) {
    if (lead.source === 'ycombinator') continue // the directory covers YC
    const name = lead.company?.trim()
    if (!name) continue
    const dir = byNameKey.get(normalizeCompanyName(name))
    const domain = normalizeDomain(lead.companyDomain) ?? normalizeDomain(dir?.domain)
    if (excluded(name, domain, identityKey(domain, null, name))) continue
    // Any company the aggregators show hiring is worth a look at its own board,
    // even when this posting is not the role asked for.
    const c = ensure(name, domain)
    if (stale(lead, now)) continue
    const role = matcher(lead)
    if (!role.matched) continue
    if (!locationVerdict({ location: lead.location }, inputs.prefs).ok) continue
    c.postings.push(lead)
    if (!c.roleLabel) c.roleLabel = role.label
  }

  // 2. Similarity to companies the person likes, over the YC directory.
  const vocab: Vocabulary = buildVocabulary(directory)
  const liked = inputs.liked.map((l) => ({ ...l, tags: new Set(l.tags) })).filter((l) => l.tags.size > 0)
  if (liked.length > 0) {
    for (const row of directory) {
      if (row.source !== 'yc' || !row.profile_url || row.tags.length === 0) continue
      const domain = normalizeDomain(row.domain)
      if (excluded(row.name, domain, identityKey(domain, null, row.name))) continue
      if (!locationVerdict({ location: row.locations, regions: row.regions }, inputs.prefs).ok) continue
      const tags = new Set(row.tags.map((t) => t.toLowerCase()))
      let best: { liked: string; shared: string[] } | null = null
      for (const l of liked) {
        if (normalizeCompanyName(l.name) === normalizeCompanyName(row.name)) continue
        const shared = sharedTags(l.tags, tags, vocab)
        if (isSimilar(shared, vocab) && (!best || shared.length > best.shared.length)) best = { liked: l.name, shared }
      }
      if (!best) continue
      const c = ensure(row.name, domain)
      c.yc = { row, ...best }
    }
  }

  // 3. Live boards, keyed by the candidate they were probed for. A board counts
  //    only for roles that match AND sit in scope.
  for (const [key, hit] of boardHits) {
    const c = candidates.get(key)
    if (!c) continue
    const matching: BoardHit['jobs'] = []
    let label = ''
    for (const job of hit.jobs) {
      const role = matcher(job)
      if (!role.matched || !locationVerdict({ location: job.location }, inputs.prefs).ok) continue
      matching.push(job)
      if (!label) label = role.label
    }
    c.board = { hit, matching }
    if (matching.length > 0 && !c.roleLabel) c.roleLabel = label
  }

  // 4. Tier, order and reason.
  const tiered: { c: Candidate; tier: SuggestionTier; matches: number; newest: number; shared: number }[] = []
  for (const c of candidates.values()) {
    const boardMatches = c.board?.matching.length ?? 0
    c.postings.sort((a, b) => postedMs(b) - postedMs(a))
    let tier: SuggestionTier | null = null
    if (boardMatches > 0) tier = 1
    else if (c.postings.length >= 2) tier = 2
    else if (c.postings.length === 1) tier = 3
    else if (c.yc) tier = 4
    if (!tier) continue
    const newest = Math.max(postedMs(c.postings[0] ?? ({} as JobLead)), Date.parse(c.board?.matching[0]?.postedAt ?? '') || 0)
    tiered.push({ c, tier, matches: boardMatches + c.postings.length, newest, shared: c.yc?.shared.length ?? 0 })
  }
  tiered.sort(
    (a, b) => a.tier - b.tier || b.matches - a.matches || b.newest - a.newest || b.shared - a.shared || a.c.name.localeCompare(b.c.name)
  )

  return tiered.slice(0, MAX_SUGGESTIONS).map(({ c, tier }, i) => {
    const { reason, sourceUrl, sourceLabel } = reasonFor(c, tier)
    return {
      key: c.key,
      name: c.name,
      domain: c.domain,
      logoUrl: c.logoUrl,
      tier,
      rank: i + 1,
      reason,
      sourceUrl,
      sourceLabel,
      signals: signalsFor(c, tier),
      ats: c.board ? { provider: c.board.hit.provider, openRoles: c.board.hit.openRoles, matchingRoles: c.board.matching.length } : null,
    }
  })
}
