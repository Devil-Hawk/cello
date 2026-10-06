// THE ONE CONTEXT-ASSEMBLY DOOR (langgraph port design doc, Step 9 —
// "one assembly module feeds every feature"). Every agent/route that needs
// more than its own immediate row (memories, prior research, relationship
// history, standing preferences) reads it through one of the four builders
// below instead of hand-rolling its own query fan-out. Two things follow from
// that:
//
//   COST DISCIPLINE. Everything here is either a plain relational read
//   (dossier rows, interactions, insights, kb_documents) or a call to a
//   module that ALREADY degrades gracefully on a missing/capped provider
//   (retrieveKb, MemoryStore). buildMatchContext in particular makes ZERO
//   embedding calls — it is on the hottest per-job path in the product
//   (lib/harness/agents/matcher.ts scores one job per LLM call), so its
//   context has to be free to assemble. Every builder below wraps its
//   sub-fetches independently and degrades a missing piece to '' rather than
//   failing the whole call — the same idiom lib/kb/retrieve.ts and
//   lib/insights/store.ts#searchInsights already use for a missing/expired
//   provider key.
//
//   ONE INJECTION CHOKEPOINT. Every string in here that originates from an
//   employer (a dossier summary synthesized from a company's own pages, a kb
//   hit pulled from a stored company/career page) is untrusted exactly the
//   way a job posting is — lib/security/job-text.ts's header lays out why.
//   This file is the ONLY place that interpolates that text into a context
//   block, and every such interpolation goes through frameJobText/
//   frameJobTextList. lib/security/injection-chokepoints.test.ts enumerates
//   this file as a PROMPT_BUILDER and its DESCRIPTION_MARKER/PROMPT_MARKER
//   scan is extended to catch the specific idioms this file introduces
//   (formatKbContext-shaped output, a kb hit's `.content`, a dossier's
//   `.summary`) so a future caller that skips this door and interpolates one
//   of those directly gets caught the same way an unframed job posting does.
//   Text that is NOT employer-authored (our own interaction timeline, our own
//   insight statements, deterministic provenance instructions this file
//   writes itself) is not framed — framing text Cello wrote about itself
//   would just spend tokens telling the model to distrust nothing, the same
//   reasoning frameJobText's own empty-input branch already documents.

import type { AdminClient } from '../harness/types'
import { mcpToolsPromptBlock } from '../harness/copilot-tools'
import { readStandingPreferences } from '../insights/store'
import { readGoals, formatActiveGoalBlock } from '../harness/goals'
import { retrieveKb } from '../kb/retrieve'
import { formatKbContext } from '../kb/store'
import { getDossierByCompany } from '../dossier/store'
import { normalizeCompanyName, trackedRoleCount } from '../entities/companies'
import { timelineFor, type InteractionRow } from '../interactions/store'
import { frameJobText } from '@/lib/security/job-text'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// --- shared, small relational reads (no embedding, no LLM) -----------------

/**
 * Insights relevant to one company (or general, companyId null on the row),
 * newest-affirmed first. A plain filtered read, NOT lib/insights/store.ts's
 * searchInsights — that one embeds `query` first, and this file's callers
 * (buildMatchContext above all) need this to cost nothing.
 */
async function relevantInsights(
  admin: AdminClient,
  userId: string,
  companyId: string | null,
  kinds: string[],
  limit: number
): Promise<{ statement: string }[]> {
  try {
    let q = admin
      .from('insights')
      .select('statement, company_id, updated_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .in('kind', kinds)
      // Model-written rows stay out of prompts until they are reviewed (K15).
      .not('source', 'eq', 'reward_loop')
    q = companyId ? q.or(`company_id.eq.${companyId},company_id.is.null`) : q.is('company_id', null)
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []) as { statement: string }[]
  } catch (e) {
    console.error(`[context] assemble: relevantInsights failed for user=${userId}: ${errMsg(e)}`)
    return []
  }
}

function formatTimeline(rows: InteractionRow[]): string {
  return rows
    .map((r) => `- ${r.occurred_at.slice(0, 10)} ${r.kind}${r.title ? `: ${r.title}` : ''}`)
    .join('\n')
}

// --- buildMatchContext -------------------------------------------------------

/** Total cap on the composed block — see this file's header COST DISCIPLINE
 *  note; ~1500 chars is a few hundred tokens on the hottest per-job LLM call
 *  in the product. */
const MATCH_CONTEXT_MAX_CHARS = 1500
const MATCH_DOSSIER_MAX_CHARS = 700
const MATCH_INSIGHTS_LIMIT = 3
const MATCH_INTERACTIONS_LIMIT = 5

/**
 * Context for one match-scoring call: framed dossier summary + open-role size
 * proxy + prior interactions + relevant strategy insights, capped at
 * MATCH_CONTEXT_MAX_CHARS. ZERO embedding calls (see file header) — every
 * piece is a plain relational read, because this runs once per job scored.
 * '' when there is no company to build context for.
 */
export async function buildMatchContext(admin: AdminClient, userId: string, companyId: string | null): Promise<string> {
  if (!companyId) return ''

  const [dossier, roleCount, interactions, insights] = await Promise.all([
    getDossierByCompany(admin, userId, companyId).catch((e: unknown) => {
      console.error(`[context] assemble: getDossierByCompany failed for company=${companyId}: ${errMsg(e)}`)
      return null
    }),
    trackedRoleCount(admin, companyId),
    timelineFor(admin, userId, { companyId }, MATCH_INTERACTIONS_LIMIT).catch((e: unknown) => {
      console.error(`[context] assemble: timelineFor failed for company=${companyId}: ${errMsg(e)}`)
      return [] as InteractionRow[]
    }),
    relevantInsights(admin, userId, companyId, ['strategy', 'pattern'], MATCH_INSIGHTS_LIMIT),
  ])

  const parts: string[] = []
  if (dossier?.summary) {
    parts.push(
      `COMPANY RESEARCH ON FILE:\n${frameJobText(dossier.summary, { label: 'COMPANY DOSSIER', maxChars: MATCH_DOSSIER_MAX_CHARS })}`
    )
  }
  if (roleCount > 0) parts.push(`Tracked open roles at this company: ${roleCount}.`)
  if (interactions.length > 0) parts.push(`Recent history with this company:\n${formatTimeline(interactions)}`)
  if (insights.length > 0) {
    parts.push(`Relevant strategy notes:\n${insights.map((i) => `- ${i.statement}`).join('\n')}`)
  }

  const block = parts.join('\n\n')
  return block.length > MATCH_CONTEXT_MAX_CHARS ? `${block.slice(0, MATCH_CONTEXT_MAX_CHARS)}…` : block
}

// --- buildGoalStrategyContext (autopilot / goals) -----------------------------

const GOAL_STRATEGY_INSIGHTS_LIMIT = 5

/**
 * General (non-company-scoped) strategy/pattern insights for one user — the
 * autopilot goal tick's source-choice/threshold context
 * (lib/graph/autopilot.ts#runGoalTick feeds this into
 * lib/harness/goals.ts#judgeCandidates as `strategyContext`, reused for every
 * candidate the tick judges). Same zero-embedding, plain-relational-read
 * discipline as buildMatchContext. Cello/the user's own synthesized text,
 * never employer-authored, so nothing here needs frameJobText.
 */
export async function buildGoalStrategyContext(admin: AdminClient, userId: string): Promise<string> {
  const insights = await relevantInsights(admin, userId, null, ['strategy', 'pattern'], GOAL_STRATEGY_INSIGHTS_LIMIT)
  if (insights.length === 0) return ''
  return `LEARNED STRATEGY NOTES (from past outcomes — weigh these, don't treat them as absolute rules):\n${insights
    .map((i) => `- ${i.statement}`)
    .join('\n')}`
}

// --- buildOutreachContext -----------------------------------------------------

const OUTREACH_HISTORY_LIMIT = 8
const OUTREACH_INSIGHTS_LIMIT = 3

/**
 * Data for one outreach draft: the recorded history with this contact or
 * company (one line each, oldest first, as recorded, never embellished) and the
 * reply-pattern insights. Data only. The rules for how a draft may use them
 * (never claim a conversation that is not on record) live in prompts/outreach.md.
 */
export async function outreachHistory(
  admin: AdminClient,
  userId: string,
  contactId: string | null,
  companyId: string | null
): Promise<{ lines: string[]; patterns: string[] }> {
  if (!contactId && !companyId) return { lines: [], patterns: [] }

  const [history, insights] = await Promise.all([
    timelineFor(admin, userId, { contactId: contactId ?? undefined, companyId: companyId ?? undefined }, OUTREACH_HISTORY_LIMIT).catch(
      (e: unknown) => {
        console.error(`[context] assemble: timelineFor failed for contact=${contactId} company=${companyId}: ${errMsg(e)}`)
        return [] as InteractionRow[]
      }
    ),
    relevantInsights(admin, userId, companyId, ['pattern', 'strategy'], OUTREACH_INSIGHTS_LIMIT),
  ])

  return {
    lines: [...history].reverse().map((r) => `${r.occurred_at.slice(0, 10)} ${r.kind}${r.title ? `: ${r.title}` : ''}`),
    patterns: insights.map((i) => i.statement),
  }
}

// --- buildTurnContext (copilot) ----------------------------------------------

const KB_HITS_LIMIT = 4
const KB_HIT_MAX_CHARS = 400
const ENTITY_SCAN_LIMIT = 500
const ENTITY_DOSSIER_MAX_CHARS = 500

export interface TurnContext {
  /** Live-listed BYO-MCP tools — verbatim from lib/harness/copilot-tools.ts,
   *  unchanged by this file (see the module header). */
  mcpBlock: string
  /** The user's standing preferences (lib/insights/store.ts). */
  standingBlock: string
  /** The active search goal, if any (lib/harness/goals.ts). */
  goalsBlock: string
  /** Framed KB hits for the current message. */
  kbBlock: string
  /** Framed context for a company the message names, if any. */
  entityBlock: string
}

/**
 * Best-effort SQL match: does `message` name one of this user's tracked
 * companies? Exact/substring match on companies.name_key (the same
 * normalization companies.name_key is stamped with at ingest — see
 * lib/entities/companies.ts#normalizeCompanyName) against a bounded scan of
 * the user's own companies. SQL only — zero LLM calls, so this can run on
 * every turn regardless of budget.
 */
async function matchNamedCompany(
  admin: AdminClient,
  userId: string,
  message: string
): Promise<{ id: string; name: string } | null> {
  const normalizedMsg = normalizeCompanyName(message)
  if (!normalizedMsg) return null
  const { data, error } = await admin
    .from('companies')
    .select('id, name, name_key')
    .eq('user_id', userId)
    .not('name_key', 'is', null)
    .limit(ENTITY_SCAN_LIMIT)
  if (error) {
    console.error(`[context] assemble: matchNamedCompany scan failed for user=${userId}: ${error.message}`)
    return null
  }
  const rows = (data ?? []) as { id: string; name: string; name_key: string | null }[]
  // Word-boundary-ish: require the key to be at least a real word, not e.g.
  // "co" matching half the English language.
  const hit = rows.find((r) => r.name_key && r.name_key.length >= 3 && normalizedMsg.includes(r.name_key))
  return hit ? { id: hit.id, name: hit.name } : null
}

async function buildEntityBlock(admin: AdminClient, userId: string, message: string): Promise<string> {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return ''
  try {
    const company = await matchNamedCompany(admin, userId, trimmed)
    if (!company) return ''
    const dossier = await getDossierByCompany(admin, userId, company.id).catch(() => null)
    const parts = [`This message names a company you're tracking: ${company.name} (id ${company.id}).`]
    if (dossier?.summary) {
      parts.push(frameJobText(dossier.summary, { label: 'COMPANY DOSSIER', maxChars: ENTITY_DOSSIER_MAX_CHARS }))
    }
    return parts.join('\n')
  } catch (e) {
    console.error(`[context] assemble: buildEntityBlock failed for user=${userId}: ${errMsg(e)}`)
    return ''
  }
}

async function buildKbBlock(admin: AdminClient, userId: string, message: string): Promise<string> {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return ''
  try {
    const hits = await retrieveKb(admin, userId, trimmed, { limit: KB_HITS_LIMIT })
    if (hits.length === 0) return ''
    // formatKbContext (lib/kb/store.ts) is the one citation renderer every KB
    // consumer shares — reused here rather than re-composed so this block
    // carries the same `[1] Title (url)` attribution the copilot KB tool and
    // /api/kb/search already give the model. frameJobTextList's `id` is
    // documented as Cello's own short batch key, not a citation label, so the
    // citation header belongs in the body (via formatKbContext), and the
    // WHOLE rendered block gets ONE fence (frameJobText, not the per-item
    // frameJobTextList): scrubStructuralEscapes runs over the full body
    // regardless of its internal structure, so one hostile hit still cannot
    // forge a fence and impersonate another citation.
    return frameJobText(formatKbContext(hits, { maxChars: KB_HITS_LIMIT * KB_HIT_MAX_CHARS }), {
      label: 'KB EXCERPT',
      maxChars: KB_HITS_LIMIT * KB_HIT_MAX_CHARS,
    })
  } catch (e) {
    console.error(`[context] assemble: buildKbBlock failed for user=${userId}: ${errMsg(e)}`)
    return ''
  }
}

async function safeStandingBlock(admin: AdminClient, userId: string): Promise<string> {
  try {
    return await readStandingPreferences(admin, userId)
  } catch (e) {
    console.error(`[context] assemble: readStandingPreferences failed for user=${userId}: ${errMsg(e)}`)
    return ''
  }
}

async function safeGoalsBlock(admin: AdminClient, userId: string): Promise<string> {
  try {
    const { data } = await admin.from('profiles').select('preferences').eq('id', userId).maybeSingle()
    return formatActiveGoalBlock(readGoals((data as { preferences?: unknown } | null)?.preferences ?? null))
  } catch (e) {
    console.error(`[context] assemble: goals read failed for user=${userId}: ${errMsg(e)}`)
    return ''
  }
}

/**
 * Copilot's per-turn context: MCP tools + standing preferences + active goal
 * + KB hits for the current message + entity context when the message names
 * a tracked company. Replaces the ad-hoc mcpToolsPromptBlock/
 * readStandingPreferences/formatActiveGoalBlock(readGoals(...)) call trio
 * lib/graph/copilot.ts#beginTurn used to make directly — mcpToolsPromptBlock
 * itself is unchanged (see file header), just relocated behind this door
 * alongside the two blocks that used to sit next to it.
 *
 * Deliberately does NOT re-fetch memories: lib/graph/copilot.ts#
 * assembleTurnContext already does a MemoryStore.search scoped to this same
 * `message` as part of its rolling-summary + recent-messages composition
 * (Step 7) — calling MemoryStore.search a second time here would double the
 * embedding spend for the same turn to build a memoryBlock this file's only
 * wired caller would just discard. A second caller that has no such existing
 * memory fetch of its own is the trigger to add one here, not before.
 *
 * Every sub-fetch degrades independently to '' on failure (see file header) —
 * this function itself never throws.
 */
export async function buildTurnContext(admin: AdminClient, userId: string, message: string): Promise<TurnContext> {
  const [mcpBlock, standingBlock, goalsBlock, kbBlock, entityBlock] = await Promise.all([
    mcpToolsPromptBlock(admin, userId),
    safeStandingBlock(admin, userId),
    safeGoalsBlock(admin, userId),
    buildKbBlock(admin, userId, message),
    buildEntityBlock(admin, userId, message),
  ])
  return { mcpBlock, standingBlock, goalsBlock, kbBlock, entityBlock }
}
