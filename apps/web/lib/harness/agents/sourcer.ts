// Agent: sourcer — discover fresh jobs from public aggregator APIs.
//
// OWNER: sourcing workstream. Given the user's preferences + resume keywords,
// it queries the public job-source adapters (lib/sources/*.ts — TheMuse,
// Arbeitnow, RemoteOK, HN "Who is hiring", Y Combinator, and the keyless
// multi-employer aggregators registered in lib/sources/index.ts), dedupes
// against jobs already in the user's workspace, auto-creates the missing
// companies (Google-favicon logo), and inserts the new jobs with the
// service-role client. No HTML scraping, no LLM calls — every adapter reads a
// public JSON API. Output satisfies SourcerOutput.
//
// ROLE-INTENT PRECISION (lib/jobs/role-taxonomy.ts): when `input.query` names
// a role this app recognizes ("AI Engineer", "SWE - AI/ML", "Data
// Scientist", ...), sourcing (a) seeds the keyword query with that intent's
// curated title phrases, and (b) classifies every candidate lead by its
// ACTUAL title before it is ever ingested — so a stray keyword hit buried in
// an unrelated job's description, or an adjacent-but-wrong role like "AI
// Product Manager", cannot sneak into "SWE - AI/ML" results. See
// filterForIntent() below. Leads that don't match a recognized intent are
// unaffected — this is additive precision, not a requirement.
//
// GEOGRAPHY BY CONFIG: the user's full lib/targeting.ts Targeting (country,
// remote-only, seniority, function, language, exclusions) is resolved once
// and threaded into every source query, so the SAME config that drives the
// jobs list/matcher/digest also drives what gets fetched in the first place.
// There is no hardcoded region — an unconfigured targeting resolves to
// EMPTY_TARGETING, which every adapter treats as "no geographic constraint",
// not "assume US".
//
// BROADEN-ON-EMPTY: when a pass returns fewer matched jobs than requested,
// sourcing progressively widens in a fixed, reported sequence — include
// adjacent titles, then drop the location constraint, then drop the
// seniority constraint (see BROADEN_STEP_ORDER) — bounded to
// MAX_BROADEN_ROUNDS extra passes so it can never loop forever, and it never
// touches the user's HARD constraints (targeting.excludedCompanies /
// excludedKeywords) at any round — see violatesHardExclusions(), which is
// applied identically on every round using the ORIGINAL targeting, never the
// broadened one.
//
// LAST RUNG — OPEN-WEB SEARCH: when even the fully-broadened aggregator pass
// (adjacent titles + no location + no seniority) still hasn't filled the
// request, one final round searches the open web via the harness's own
// web_search tool (lib/search/job-discovery.ts) — site:-scoped queries
// against real ATS board hosts, every hit verified before it can become a
// lead. Free keyless sources ALWAYS run first; this only fires when they
// still come up short, and it is reported in `notes` exactly like every
// other round (see the 'web-search' line below) — never a silent extra step.

import { extractSkillsFromText } from '../../jobs/skills'
import type { AgentFn } from '../types'
import { SourcerInput } from '../schemas'
import { ingestLeads, queryAllSources } from '../../sources'
import type { JobLead } from '../../sources'
import { sanitizeLeads } from '../../sources/util'
import { resolveTargeting, type Targeting } from '../../targeting'
import {
  classifyTitleForIntent,
  keywordsForIntent,
  resolveRoleIntent,
  type RoleIntentDef,
} from '../../jobs/role-taxonomy'
import { discoverJobsViaWebSearch } from '../../search/job-discovery'

const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'you', 'your', 'our', 'are', 'job', 'jobs',
  'role', 'roles', 'work', 'remote', 'looking', 'want', 'wanted', 'hiring',
  'position', 'positions', 'engineer', 'developer',
])

/** Resume skills (curated list) + query terms → deduped, capped keyword list. */
function buildKeywords(query: string | undefined, resume: string | null): string[] {
  const out = new Set<string>()
  if (resume) {
    for (const skill of extractSkillsFromText(resume)) {
      const k = skill.name.toLowerCase().trim()
      if (k.length >= 2) out.add(k)
    }
  }
  if (query) {
    for (const raw of query.toLowerCase().split(/[^a-z0-9+#.]+/)) {
      const w = raw.trim()
      if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
    }
  }
  return [...out].slice(0, 30)
}

/** Merge two keyword lists, deduped case-insensitively, order preserved (primary first). */
function mergeKeywords(primary: string[], secondary: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of [...primary, ...secondary]) {
    const norm = k.trim().toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out.slice(0, 60)
}

/**
 * Free-text location strings (e.g. "New York", "Remote") + a remote flag,
 * read straight from the user's raw preferences. This is DELIBERATELY
 * separate from Targeting.countries (ISO codes): TheMuse's `location=` param
 * wants free text, not a country code, and this signal is additive to —
 * never a substitute for — the resolved Targeting passed alongside it.
 */
function readLocationPrefs(preferences: unknown): { locations: string[]; remote: boolean } {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const rawLocs = Array.isArray(p.preferredLocations) ? (p.preferredLocations as unknown[]) : []
  const locations = rawLocs
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.toLowerCase().trim())
    .filter(Boolean)
  const pref = typeof p.remotePreference === 'string' ? p.remotePreference : 'any'
  const remote = pref === 'remote' || pref === 'any' || locations.some((l) => l.includes('remote'))
  return { locations, remote }
}

// ---------------------------------------------------------------------------
// Broaden-on-empty
// ---------------------------------------------------------------------------

export interface BroadenState {
  targeting: Targeting
  /** Once true, adjacent (not just in-role) titles are accepted for the resolved intent. */
  allowAdjacent: boolean
}

export type BroadenStepId = 'adjacent-titles' | 'relax-location' | 'relax-seniority'

/** Fixed, bounded broadening sequence — see module header. Never reordered
 *  at runtime, so the bound below is a hard ceiling, not a loop guard. */
export const BROADEN_STEP_ORDER: readonly BroadenStepId[] = [
  'adjacent-titles',
  'relax-location',
  'relax-seniority',
]

/** Extra passes beyond the baseline. Equal to BROADEN_STEP_ORDER.length by
 *  construction — every step is attempted at most once, ever. */
export const MAX_BROADEN_ROUNDS = BROADEN_STEP_ORDER.length

export interface BroadenStepPlan {
  id: BroadenStepId
  /** False when there was nothing to relax this step (e.g. no seniority
   *  constraint was set) — the step is reported as skipped, not silently
   *  dropped, and `next` equals `state` unchanged. */
  applicable: boolean
  /** Human-readable description of what changed (or why nothing did) — folded into `notes`. */
  describe: string
  /** State to use for this round and all subsequent ones. */
  next: BroadenState
}

/**
 * Decide what ONE broadening step does to the current state. Pure function —
 * no I/O — so this is fully unit-testable independent of the network/DB
 * plumbing in the `sourcer` agent below.
 *
 * By construction, no branch here ever reads or writes
 * targeting.excludedCompanies, targeting.excludedKeywords, targeting.functions,
 * or targeting.languages — those are the user's hard/explicit constraints and
 * broadening structurally cannot touch fields it never references.
 */
export function planBroadenStep(
  stepId: BroadenStepId,
  state: BroadenState,
  intent: RoleIntentDef | null
): BroadenStepPlan {
  switch (stepId) {
    case 'adjacent-titles': {
      const applicable = !!intent && intent.adjacentKeywords.length > 0 && !state.allowAdjacent
      return {
        id: stepId,
        applicable,
        describe: applicable
          ? `included adjacent titles for "${intent!.label}" (${intent!.adjacentKeywords.join(', ')})`
          : 'adjacent titles: skipped (no resolved role intent, or already included)',
        next: applicable ? { ...state, allowAdjacent: true } : state,
      }
    }
    case 'relax-location': {
      const applicable = state.targeting.countries.length > 0 || state.targeting.remoteOnly
      return {
        id: stepId,
        applicable,
        describe: applicable
          ? `dropped location constraint (was countries=[${state.targeting.countries.join(',')}] remoteOnly=${state.targeting.remoteOnly})`
          : 'location: skipped (no geographic constraint set)',
        next: applicable
          ? { ...state, targeting: { ...state.targeting, countries: [], remoteOnly: false } }
          : state,
      }
    }
    case 'relax-seniority': {
      const applicable = state.targeting.seniority.length > 0
      return {
        id: stepId,
        applicable,
        describe: applicable
          ? `dropped seniority constraint (was seniority=[${state.targeting.seniority.join(',')}])`
          : 'seniority: skipped (no seniority constraint set)',
        next: applicable
          ? { ...state, targeting: { ...state.targeting, seniority: [] } }
          : state,
      }
    }
  }
}

/**
 * Title-classify every lead against the resolved role intent and keep only
 * 'in-role' matches (plus 'adjacent' ones once a broadening round has opted
 * in). 'excluded' and 'unmatched' are always dropped — this is the gate that
 * keeps a description-only keyword hit (e.g. an "AI Product Manager" posting
 * whose body happens to mention "machine learning") from surviving just
 * because relevanceScore() gave it a non-zero score. No-op when no intent was
 * resolved from the query.
 */
function filterForIntent(leads: JobLead[], intent: RoleIntentDef | null, allowAdjacent: boolean): JobLead[] {
  if (!intent) return leads
  return leads.filter((lead) => {
    const m = classifyTitleForIntent(lead.title, intent)
    return m === 'in-role' || (allowAdjacent && m === 'adjacent')
  })
}

/**
 * True when a lead violates one of the user's HARD exclusions
 * (targeting.excludedCompanies / excludedKeywords). Always called with the
 * ORIGINAL resolved targeting (never the broadened `state.targeting`) — see
 * the `sourcer` loop below — so these two fields can never be relaxed away by
 * broaden-on-empty, no matter how many rounds run.
 */
function violatesHardExclusions(lead: JobLead, targeting: Targeting): boolean {
  if (targeting.excludedCompanies.length > 0) {
    const company = lead.company.toLowerCase()
    if (targeting.excludedCompanies.some((c) => company.includes(c))) return true
  }
  if (targeting.excludedKeywords.length > 0) {
    const text = `${lead.title} ${lead.description}`.toLowerCase()
    if (targeting.excludedKeywords.some((k) => text.includes(k))) return true
  }
  return false
}

export const sourcer: AgentFn = async (ctx) => {
  const input = SourcerInput.parse(ctx.input ?? {})

  // Load resume + preferences for query building (service-role read).
  const { data: profile } = await ctx.admin
    .from('profiles')
    .select('resume_text, preferences')
    .eq('id', ctx.userId)
    .single()

  const resume = (profile?.resume_text as string | null) ?? null
  const baseTargeting = resolveTargeting(profile?.preferences)
  const { locations, remote } = readLocationPrefs(profile?.preferences)
  const totalLimit = input.limit ?? 80

  const intent = resolveRoleIntent(input.query)
  const resumeKeywords = buildKeywords(input.query, resume)
  const baselineKeywords = intent
    ? mergeKeywords([...keywordsForIntent(intent)], resumeKeywords)
    : resumeKeywords

  // Note: SourcerInput.companyIds is accepted but intentionally unused here —
  // the aggregator fan-out (queryAllSources) discovers NEW companies by
  // design; scoping it down to an explicit company list is a different,
  // ATS-refresh code path (lib/ats/*), not this one. Nothing in this agent
  // relies on it, so there is nothing broaden-on-empty could accidentally
  // widen away from it.

  const jobIds = new Set<string>()
  let found = 0
  let inserted = 0
  let createdCompanies = 0
  const errors: string[] = []
  const perSourceTotals: Record<string, { found: number; error?: string }> = {}
  const roundLog: string[] = []

  async function runRound(label: string, keywords: string[], roundState: BroadenState): Promise<void> {
    const { leads, perSource } = await queryAllSources(
      { keywords, locations, remote, targeting: roundState.targeting, signal: ctx.signal },
      { totalLimit }
    )
    for (const [id, s] of Object.entries(perSource)) {
      const prior = perSourceTotals[id]
      perSourceTotals[id] = {
        found: (prior?.found ?? 0) + s.found,
        error: s.error ?? prior?.error,
      }
    }
    const inRole = filterForIntent(leads, intent, roundState.allowAdjacent)
    const kept = inRole.filter((l) => !violatesHardExclusions(l, baseTargeting))

    const ingest = await ingestLeads(ctx.admin, ctx.userId, kept)
    found += ingest.found
    inserted += ingest.inserted
    createdCompanies += ingest.createdCompanies
    errors.push(...ingest.errors)

    const before = jobIds.size
    for (const id of ingest.jobIds) jobIds.add(id)
    const gained = jobIds.size - before
    roundLog.push(`${label}[leads=${leads.length} kept=${kept.length} newJobs=${gained} total=${jobIds.size}]`)
  }

  let state: BroadenState = { targeting: baseTargeting, allowAdjacent: false }
  let keywords = baselineKeywords
  await runRound('baseline', keywords, state)

  for (const stepId of BROADEN_STEP_ORDER) {
    if (jobIds.size >= totalLimit) break
    const plan = planBroadenStep(stepId, state, intent)
    roundLog.push(`broaden[${stepId}]: ${plan.describe}`)
    if (!plan.applicable) continue
    state = plan.next
    if (stepId === 'adjacent-titles' && intent) {
      keywords = mergeKeywords([...keywordsForIntent(intent, { includeAdjacent: true })], resumeKeywords)
    }
    await runRound(stepId, keywords, state)
  }

  // Final rung: the open-web search tool. Only reached when every free
  // keyless source above — baseline plus every applicable broaden round —
  // still hasn't filled the request. Reuses the WIDEST state reached above
  // (adjacent titles allowed, location/seniority relaxed as applicable) so
  // this rung searches exactly as broadly as the rest of the ladder already
  // agreed to, never narrower and never a fresh, unrelated relaxation policy.
  if (jobIds.size < totalLimit) {
    const ws = await discoverJobsViaWebSearch({
      intent,
      query: input.query,
      targeting: state.targeting,
      limit: totalLimit - jobIds.size,
      signal: ctx.signal,
      userId: ctx.userId,
      admin: ctx.admin,
    })
    roundLog.push(ws.notes)
    if (ws.leads.length > 0) {
      // Same quality/targeting gate every other round's leads pass (normally
      // applied inside queryAllSources) before the intent/exclusion filters.
      const clean = sanitizeLeads(ws.leads, state.targeting)
      const inRole = filterForIntent(clean, intent, state.allowAdjacent)
      const kept = inRole.filter((l) => !violatesHardExclusions(l, baseTargeting))

      const ingest = await ingestLeads(ctx.admin, ctx.userId, kept)
      found += ingest.found
      inserted += ingest.inserted
      createdCompanies += ingest.createdCompanies
      errors.push(...ingest.errors)

      const before = jobIds.size
      for (const id of ingest.jobIds) jobIds.add(id)
      const gained = jobIds.size - before
      roundLog.push(`web-search[leads=${ws.leads.length} kept=${kept.length} newJobs=${gained} total=${jobIds.size}]`)
    }
  } else {
    roundLog.push('web-search: skipped (limit already met by free sources)')
  }

  const sourceSummary = Object.entries(perSourceTotals)
    .map(([id, s]) => `${id}:${s.error ? 'err' : s.found}`)
    .join(' ')
  const notes =
    `sources[${sourceSummary}] leads=${found} newCompanies=${createdCompanies} inserted=${inserted}` +
    (errors.length ? ` errors=${errors.length}` : '') +
    (intent ? ` intent=${intent.id}` : ' intent=none') +
    ` | ${roundLog.join(' | ')}`

  return {
    output: {
      jobIds: [...jobIds],
      found,
      inserted,
      notes,
    },
    tokensUsed: 0, // pure API sourcing, no LLM calls
  }
}
