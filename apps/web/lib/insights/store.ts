// The ONE door onto public.insights (binding ruling 3 — the other is
// lib/kb/ingest.ts, which writes kb_documents/kb_chunks, not this table).
//
// WHAT THIS REPLACES
//   lib/harness/standing-preferences.ts's 12-slot FIFO evicted the OLDEST
//   preference the moment a 13th was recorded — a preference stated ten
//   conversations ago and never repeated just vanished, no trace, no way to
//   ask "what did I used to say?". insights rows never evict: ingestInsight
//   only ever inserts or (on an exact restatement) refreshes a row's
//   timestamp; readStandingPreferences still injects only the most-recently-
//   affirmed 12 into the prompt (the context-window argument in standing-
//   preferences.ts's header is still correct — this module keeps its
//   MAX_STANDING_PREFERENCES cap for exactly that reason) but everything past
//   the top 12 stays queryable via searchInsights instead of being destroyed.
//
//   standing-preferences.ts is deleted (Step 10): its zero-production-
//   importers proof is store.test.ts's own "no production file imports
//   standing-preferences.ts" check, and its old formatStandingPreferences
//   output is pinned by a golden reproduction in store.test.ts rather than an
//   import of the now-gone module.
//
// CONTRADICTION vs. DEDUPE
//   Dedupe is automatic, purely textual, and ATOMIC AT THE DB: ingestInsight
//   calls the upsert_insight RPC (20260816000005_insights.sql), which does a
//   single INSERT ... ON CONFLICT against uniq_insights_user_kind_statement_
//   active — the same case/punctuation-insensitive normalization dedupeKey
//   used to do in application code, now enforced by the unique index itself.
//   On an exact match against an existing ACTIVE row of the same kind, it's
//   treated as a restatement — bump the timestamp, no new row — exactly
//   addStandingPreference's "a user repeating themselves is emphasis, not a
//   new fact." Doing this as one DB statement (not a SELECT-then-INSERT) is
//   what actually closes the race: two concurrent ingestInsight calls for the
//   same normalized statement can't both "win" a check-then-act window that
//   no longer exists in application code — Postgres serializes on the index.
//
//   Contradiction is NOT inferred here. Deciding that "I'm open to any stage
//   now" contradicts "Series A+ only" requires judgment (semantic opposition,
//   not string equality) that belongs to whoever is producing the new
//   insight — the copilot tool that just heard the user say it, the judge
//   that just scored a verdict against an old strategy note — not to this
//   storage chokepoint. A caller signals it explicitly via
//   IngestInsightInput.supersedesId: the row at that id is marked
//   status='contradicted' + supersedes_id = the new row's id, NEVER deleted.
//
// EMBEDDING IS BEST-EFFORT, EXACTLY LIKE lib/kb/store.ts#embedChunksBestEffort
//   A missing/capped provider must never turn "record this insight" into a
//   failure — the row saves with a NULL embedding and searchInsights degrades
//   to recency-only ranking for it, same contract as kb_chunks.

import type { AdminClient } from '../harness/types'
import { loadApiKeys } from '../harness/keys'
import { callEmbedding, MissingKeyError } from '../harness/llm'
import { BudgetCapError } from '../harness/spend'
import { captureError } from '../observability/sentry'

export type InsightKind = 'preference' | 'strategy' | 'pattern' | 'company_note' | 'self'
export type InsightStatus = 'active' | 'retired' | 'contradicted'
export type InsightSource = 'reward_loop' | 'user_stated' | 'judge' | 'strategy_module'

export interface Insight {
  id: string
  kind: InsightKind
  statement: string
  evidence: unknown
  confidence: number | null
  status: InsightStatus
  source: InsightSource
  companyId: string | null
  supersedesId: string | null
  createdAt: string
  updatedAt: string
}

export interface IngestInsightInput {
  kind: InsightKind
  /** The insight as a short sentence, in whoever stated/derived it's own terms. */
  statement: string
  evidence?: unknown
  confidence?: number | null
  source: InsightSource
  companyId?: string | null
  /** Id of an existing ACTIVE insight this one contradicts/replaces. When set,
   *  that row is marked status='contradicted' with supersedes_id pointing at
   *  the newly-inserted row — see the CONTRADICTION vs. DEDUPE header note. */
  supersedesId?: string
}

export class InsightError extends Error {}

/**
 * Cap on how many preferences readStandingPreferences injects into a prompt —
 * ported verbatim from lib/harness/standing-preferences.ts#MAX_STANDING_PREFERENCES.
 * The reasoning is unchanged (a permanent tax on context + model attention);
 * what changed is that rows past this cap stay in the table instead of being
 * evicted.
 */
export const MAX_STANDING_PREFERENCES = 12

/** Same UX ceiling as the old FIFO's MAX_PREFERENCE_LENGTH. Enforced only at
 *  the remember_preference call site (kind='preference', user-typed) — a
 *  reward_loop/judge-authored strategy/pattern/company_note/self row may
 *  legitimately run longer, so ingestInsight itself does not enforce this. */
export const MAX_PREFERENCE_LENGTH = 200

/**
 * Render the top-12 for a system prompt — ported verbatim from standing-
 * preferences.ts#formatStandingPreferences (see that file's header for why
 * '' for empty and why the "never quietly ignore" line matters). Byte-
 * identical on purpose: lib/insights/store.test.ts pins this against the old
 * function's output for the same (text, recordedAt) pairs.
 */
function formatStandingPreferencesBlock(prefs: Array<{ text: string; recordedAt: string }>): string {
  if (prefs.length === 0) return ''
  const lines = prefs.map((p) => `- ${p.text}`).join('\n')
  return (
    `WHAT THIS USER HAS TOLD YOU THEY WANT (stated by them, in earlier conversations — ` +
    `honour these without being asked again):\n${lines}\n` +
    `If a request conflicts with one of these, say so and ask which wins — never quietly ignore one.`
  )
}

interface InsightRow {
  id: string
  kind: InsightKind
  statement: string
  evidence: unknown
  confidence: number | null
  status: InsightStatus
  source: InsightSource
  company_id: string | null
  supersedes_id: string | null
  created_at: string
  updated_at: string
}

function rowToInsight(row: InsightRow): Insight {
  return {
    id: row.id,
    kind: row.kind,
    statement: row.statement,
    evidence: row.evidence ?? null,
    confidence: row.confidence ?? null,
    status: row.status,
    source: row.source,
    companyId: row.company_id,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** AbortSignal.timeout() firing raises a DOMException/Error named this — same
 *  check as lib/kb/retrieve.ts#isTimeout. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/**
 * Embed `statement` and persist it onto the just-written row. NEVER throws —
 * same contract as lib/kb/store.ts#embedChunksBestEffort: no provider
 * configured, budget cap hit, a transient provider error all leave the row at
 * its default NULL embedding, which searchInsights already treats as
 * "recency-only for this row." Recording an insight must never fail because
 * embedding it did.
 */
async function embedInsightBestEffort(admin: AdminClient, userId: string, insightId: string, statement: string): Promise<void> {
  try {
    const keys = await loadApiKeys(admin, userId)
    const { embeddings } = await callEmbedding(keys, { texts: [statement] })
    const { error } = await admin.from('insights').update({ embedding: embeddings[0] }).eq('id', insightId).eq('user_id', userId)
    if (error) throw new Error(`persist embedding failed: ${error.message}`)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    console.error(`[insights:embed-failed] insight=${insightId} user=${userId}: ${error.message}`)
    void captureError(error, { tags: { area: 'insights', phase: 'embed' }, extra: { userId, insightId } })
  }
}

/**
 * Record one insight. Dedupe is atomic at the DB (uniq_insights_user_kind_
 * statement_active + upsert_insight's ON CONFLICT — see that migration's
 * header for why an app-level SELECT-then-INSERT can't close this race: two
 * concurrent calls for the same normalized statement both pass a SELECT
 * check before either INSERT commits; a single INSERT ... ON CONFLICT
 * statement can't be raced the same way, because Postgres itself serializes
 * on the unique index). Contradiction is handled per the header note above,
 * and only ever runs for a genuinely new row (see `inserted` below) — a
 * restatement is emphasis, never a contradiction. Every path returns the row
 * that is now ACTIVE and carries the given statement (either freshly
 * inserted, or the existing row that was refreshed).
 */
export async function ingestInsight(admin: AdminClient, userId: string, insight: IngestInsightInput): Promise<Insight> {
  const statement = (insight.statement ?? '').trim()
  if (!statement) throw new InsightError('An insight needs a statement.')

  const { data, error } = await admin.rpc('upsert_insight', {
    p_user_id: userId,
    p_kind: insight.kind,
    p_statement: statement,
    p_evidence: insight.evidence ?? null,
    p_confidence: insight.confidence ?? null,
    p_source: insight.source,
    p_company_id: insight.companyId ?? null,
  })
  if (error) throw new InsightError(`Could not save insight: ${error.message}`)
  const row = ((data ?? []) as (InsightRow & { inserted: boolean })[])[0]
  if (!row) throw new InsightError('upsert_insight returned no row')

  if (!row.inserted) {
    // A restatement of an existing active insight — the RPC already bumped
    // updated_at (see migration), so it counts as freshly affirmed for
    // readStandingPreferences' recency ordering. No re-embed: the text is
    // unchanged, so any embedding already on the row is still correct.
    return rowToInsight(row)
  }

  if (insight.supersedesId) {
    const { error: supersedeError } = await admin
      .from('insights')
      .update({ status: 'contradicted', supersedes_id: row.id })
      .eq('id', insight.supersedesId)
      .eq('user_id', userId)
      .eq('status', 'active')
    if (supersedeError) throw new InsightError(`Could not mark superseded insight: ${supersedeError.message}`)
  }

  await embedInsightBestEffort(admin, userId, row.id, statement)
  return rowToInsight(row)
}

/**
 * The system-prompt block for standing preferences — replaces
 * `formatStandingPreferences(readStandingPreferences(profile.preferences))`.
 * The 12 most-recently-affirmed ACTIVE kind='preference' rows, oldest-of-the-
 * top-12 first (matching the FIFO array's order — see the fixture test).
 */
export async function readStandingPreferences(admin: AdminClient, userId: string): Promise<string> {
  const { data, error } = await admin
    .from('insights')
    .select('statement, updated_at')
    .eq('user_id', userId)
    .eq('kind', 'preference')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(MAX_STANDING_PREFERENCES)
  if (error) throw new InsightError(`Could not read standing preferences: ${error.message}`)

  const rows = (data ?? []) as Array<{ statement: string; updated_at: string }>
  const prefs = rows.reverse().map((r) => ({ text: r.statement, recordedAt: r.updated_at }))
  return formatStandingPreferencesBlock(prefs)
}

/**
 * ponytail: fixed budget, matching lib/kb/retrieve.ts#EMBED_TIMEOUT_MS —
 * bounds the slowest acceptable wait for "maybe better ranking," never a
 * correctness requirement (recency-only is always a safe, complete result).
 */
const EMBED_TIMEOUT_MS = 2500

/**
 * Cosine-ranked (recency-tiebreak/fallback) search over a user's active
 * insights, via the search_insights RPC (20260816000005_insights.sql). Embeds
 * `query` best-effort and degrades to recency-only ranking on any embedding
 * failure — same MissingKeyError/BudgetCapError/timeout-is-expected contract
 * as lib/kb/retrieve.ts#retrieveKb.
 */
export async function searchInsights(
  admin: AdminClient,
  userId: string,
  query: string,
  opts: { kinds?: InsightKind[]; limit?: number } = {}
): Promise<Insight[]> {
  const trimmed = (query ?? '').trim()
  if (!trimmed || !userId) return []

  let vector: number[] | null = null
  try {
    const keys = await loadApiKeys(admin, userId)
    const { embeddings } = await callEmbedding(keys, { texts: [trimmed] }, AbortSignal.timeout(EMBED_TIMEOUT_MS))
    vector = embeddings[0] ?? null
  } catch (err) {
    if (!(err instanceof MissingKeyError) && !(err instanceof BudgetCapError) && !isTimeout(err)) {
      console.error(`[insights:search-embed-failed] user=${userId}: ${errMsg(err)}`)
      void captureError(err instanceof Error ? err : new Error(String(err)), {
        tags: { area: 'insights', phase: 'search-embed' },
        extra: { userId },
      })
    }
    // vector stays null — search_insights degrades to recency-only.
  }

  const { data, error } = await admin.rpc('search_insights', {
    p_user_id: userId,
    p_vec: vector,
    p_kinds: opts.kinds && opts.kinds.length > 0 ? opts.kinds : null,
    p_limit: opts.limit ?? 12,
  })
  if (error) throw new InsightError(`search_insights failed: ${error.message}`)
  return ((data ?? []) as InsightRow[]).map(rowToInsight)
}
