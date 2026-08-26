// apply_phase_tokens — the fill-phase / submit-phase authorization for
// assisted apply (binding ruling 8).
//
// WHY THIS TABLE DOES NOT WORK LIKE lib/access/tokens.ts
//   api_tokens hands its plaintext to a HUMAN, who pastes it into an MCP
//   client and presents it back on every request. apply_phase_tokens hands
//   nothing to anyone: the only caller that could ever present a bearer value
//   is .github/workflows/browser-apply.yml's workflow_dispatch job, and its
//   ONLY inputs are `draft_id` + `phase` — plain text, printed in the run's
//   own logs. There is no channel in that dispatch a secret could travel
//   through without being logged, so no plaintext is ever minted for the
//   runner to hold. See supabase/migrations/20260819000003_assisted_apply.sql
//   for the full reasoning.
//
//   What the runner DOES present is BROWSER_RUNNER_SECRET (a static,
//   transport-level shared secret — proves "this is our GitHub Actions job",
//   never a per-draft authorization) plus draft_id + phase. Consuming the
//   row is then "is there an unconsumed, unexpired token for THIS (draft,
//   phase) pair" — issuePhaseToken()/consumePhaseToken() below never expose
//   a plaintext at all; the hash exists purely as the audit-shaped column
//   ruling 8 names.
//
// EVERY WRITE GOES THROUGH THE SERVICE-ROLE ADMIN CLIENT, PASSED IN
// EXPLICITLY — the migration gives `authenticated` no policy on this table
// at all, matching lib/access/tokens.ts's own convention of taking an
// AdminClient as the first argument rather than constructing one internally.

import { createHash, randomBytes } from 'node:crypto'
import type { AdminClient } from '@/lib/harness/types'

const TABLE = 'apply_phase_tokens'

export type ApplyPhase = 'fill' | 'submit'

/** Ruling 8: expires_at <= 15 minutes from issuance. */
export const PHASE_TOKEN_TTL_MS = 15 * 60 * 1000

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** SHA-256 hex of a server-only random value. See the file header for why
 *  this is never returned to a caller. */
function hashPhaseToken(): string {
  return sha256Hex(randomBytes(32).toString('hex'))
}

export interface IssuePhaseTokenInput {
  draftId: string
  userId: string
  phase: ApplyPhase
}

export interface IssuedPhaseToken {
  id: string
  expiresAt: string
}

/**
 * Mint a fill/submit authorization row.
 *
 * FIRST invalidates any still-live token for the SAME (draft, phase) pair —
 * best-effort (route-level status guards make this a no-op in the common
 * case), not what actually guarantees at most one live row: that guarantee
 * is a DB-level partial unique index on (draft_id, phase) WHERE
 * consumed_at IS NULL (20260819000004_apply_phase_tokens_live_unique.sql).
 * A true concurrent double-mint (two callers whose invalidation UPDATEs
 * both run before either INSERT commits) throws here — the loser's insert
 * violates that constraint — rather than silently leaving two live rows.
 * This is what makes consumePhaseToken()'s single UPDATE correct: with at
 * most one live row per (draft, phase) enforced by the database, "consume
 * the unconsumed, unexpired row for this pair" cannot land on an ambiguous
 * duplicate.
 *
 * Does not check is_demo itself: that refusal belongs to the route, which
 * can answer in a sentence before this is ever reached. The migration's
 * forbid_demo_apply_phase_tokens trigger is the backstop for any caller
 * that forgets.
 */
export async function issuePhaseToken(
  admin: AdminClient,
  input: IssuePhaseTokenInput
): Promise<IssuedPhaseToken> {
  await admin
    .from(TABLE)
    .update({ consumed_at: new Date().toISOString() })
    .eq('draft_id', input.draftId)
    .eq('phase', input.phase)
    .is('consumed_at', null)

  const expiresAt = new Date(Date.now() + PHASE_TOKEN_TTL_MS).toISOString()
  const { data, error } = await admin
    .from(TABLE)
    .insert({
      draft_id: input.draftId,
      user_id: input.userId,
      phase: input.phase,
      token_hash: hashPhaseToken(),
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single()
  if (error) throw new Error(`issuePhaseToken failed: ${error.message}`)
  return { id: data.id, expiresAt: data.expires_at }
}

export interface ConsumePhaseTokenInput {
  draftId: string
  phase: ApplyPhase
}

/**
 * Atomically consume the live token for (draft, phase). Returns true exactly
 * once per issued token — a second call with the same (draft, phase) after
 * it is consumed or past expiry returns false, which app/api/apply/bundle
 * treats as "refuse, do not release the bundle."
 *
 * ATOMICITY: this is one `UPDATE ... WHERE consumed_at IS NULL RETURNING`,
 * exactly the shape ruling 8 names — the predicate is evaluated by Postgres
 * as part of the row lock, not read-then-write from this client. Two
 * concurrent calls racing on the same row serialize at the database: the
 * first to acquire the lock sets consumed_at and its UPDATE matches; the
 * second's UPDATE then re-evaluates WHERE against the now-committed row,
 * finds consumed_at is no longer null, and touches zero rows.
 * `.select().maybeSingle()` on zero touched rows returns `{ data: null }`,
 * turned into `false` here. issuePhaseToken() guarantees at most one live
 * row per (draft, phase), so there is no "which row" ambiguity for this
 * single UPDATE to resolve. See app/api/apply/bundle/route.test.ts for the
 * simulated-concurrent-claim proof.
 */
export async function consumePhaseToken(
  admin: AdminClient,
  input: ConsumePhaseTokenInput
): Promise<{ id: string } | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await admin
    .from(TABLE)
    .update({ consumed_at: nowIso })
    .eq('draft_id', input.draftId)
    .eq('phase', input.phase)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`consumePhaseToken failed: ${error.message}`)
  // The consumed row's id is part of the contract, not a discardable detail:
  // mintReportToken() scopes its overwrite to exactly this row. Matching only
  // on (draft, phase, consumed) could land the mint on a DIFFERENT consumed
  // row for the same pair — e.g. an expired earlier fill attempt — leaving
  // the row this consumption claimed holding the OLD hash.
  return (data as { id: string } | null) ?? null
}

export interface ReportTokenInput {
  draftId: string
  phase: ApplyPhase
  /** The exact row consumePhaseToken() just claimed — the mint lands there and nowhere else. */
  consumedRowId: string
}

/**
 * Mints a fresh, PRESENTABLE report secret for the (draft, phase) row that
 * was just consumed, and overwrites that row's token_hash with its hash —
 * the "future mint site" this table's migration header names as the cheap
 * follow-up once a real, unlogged channel exists. Unlike hashPhaseToken()'s
 * issue-time value (never returned to anyone, because workflow_dispatch
 * inputs are the only channel available then, and GitHub logs those in
 * plain text), THIS plaintext is handed back in the bundle response BODY —
 * a channel only the caller who just proved BROWSER_RUNNER_SECRET +
 * consumption ever sees, never a dispatch input.
 *
 * Call ONLY immediately after consumePhaseToken() has returned the consumed
 * row for the same (draft, phase) — the UPDATE below is scoped to THAT ROW's
 * id (with the draft/phase/consumed predicates kept as belt-and-suspenders),
 * so a second consumed row for the same pair can never receive the mint.
 */
export async function mintReportToken(admin: AdminClient, input: ReportTokenInput): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const { error } = await admin
    .from(TABLE)
    .update({ token_hash: sha256Hex(token) })
    .eq('id', input.consumedRowId)
    .eq('draft_id', input.draftId)
    .eq('phase', input.phase)
    .not('consumed_at', 'is', null)
  if (error) throw new Error(`mintReportToken failed: ${error.message}`)
  return token
}

export interface VerifyReportTokenInput {
  draftId: string
  phase: ApplyPhase
  reportToken: string
}

/**
 * True when `reportToken` hashes to the token_hash currently stored for
 * (draft_id, phase) on a row that has actually been consumed — i.e. the
 * caller is holding the exact secret mintReportToken() handed back from a
 * REAL bundle release for this run, not merely someone who knows the
 * (draftId, phase) pair plus BROWSER_RUNNER_SECRET. This is the bearer-
 * secret check PATCH app/api/apply/state's callback presents back on,
 * closing the gap a bare BROWSER_RUNNER_SECRET + draftId/phase would
 * otherwise leave: without it, a caller could report a fill/submit outcome
 * for a run that never actually fetched a bundle at all. token_hash is
 * globally unique (schema constraint), so a scan across every row for this
 * (draft_id, phase) pair cannot false-positive on a stale row from an
 * earlier cycle.
 */
export async function verifyReportToken(admin: AdminClient, input: VerifyReportTokenInput): Promise<boolean> {
  if (!input.reportToken) return false
  const { data, error } = await admin
    .from(TABLE)
    .select('token_hash, consumed_at')
    .eq('draft_id', input.draftId)
    .eq('phase', input.phase)
  if (error) throw new Error(`verifyReportToken failed: ${error.message}`)
  const expectedHash = sha256Hex(input.reportToken)
  const rows = (data ?? []) as { token_hash: string; consumed_at: string | null }[]
  return rows.some((r) => r.consumed_at !== null && r.token_hash === expectedHash)
}
