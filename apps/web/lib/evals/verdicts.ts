// eval_verdicts — the single verdict store (design doc: "eval_verdicts is
// the single verdict store"). See supabase/migrations/
// 20260818000002_eval_verdicts.sql for the schema, the subject_kind/
// subject_id polymorphic-reference rationale, and the RLS + demo-wipe
// treatment (ruling 5, class 2). writeVerdict/readVerdicts are its only
// reader/writer surface — every caller that judges something and wants the
// verdict to survive goes through these, never a raw
// `admin.from('eval_verdicts')` elsewhere, so the shape stays exactly what
// this migration's CHECK constraints describe.
//
// WHY writeVerdict IS BEST-EFFORT (LOGS, NEVER THROWS)
//   Same contract as spend.ts#recordSpend and lib/trace/spans.ts#SpanBuffer.
//   flush, which this deliberately matches: a bookkeeping failure must never
//   fail the request that already produced a real judge result the user is
//   about to see. Silence is still not acceptable — REFUSE-OVER-GUESS
//   (invariant 7) is about the VERDICT never being silent, not about this
//   write never failing — so a failed insert is logged loudly via
//   logApiError, exactly like recordSpend's own "the cap may under-count"
//   line is loud rather than swallowed.
//
// WHY span_id ONLY WHEN A BUFFER IS ACTIVE
//   currentTraceContext() (lib/trace/spans.ts) is only populated inside a
//   graph invocation or a unit run — a plain route handler like /api/
//   outreach/judge never enters it, so its verdicts link no span today. A
//   FUTURE judge call made from inside a graph node (e.g. a verify step)
//   picks up parentSpanId automatically, for free, the same way callLlm's own
//   span nesting does — no caller has to thread anything through by hand.

import { logApiError } from '../observability/log'
import { currentTraceContext } from '../trace/spans'
import type { AdminClient } from '../harness/types'

/** Matches the `subject_kind` CHECK constraint on public.eval_verdicts. */
export type VerdictSubjectKind =
  | 'match_score'
  | 'cv_tailor_draft'
  | 'outreach_draft'
  | 'plan'
  | 'tool_call'
  | 'distillation'

/** Matches the `judge` CHECK constraint. containment/deterministic need no model call. */
export type VerdictJudge = 'factuality' | 'closed_qa' | 'containment' | 'deterministic'

/** Matches the `verdict` CHECK constraint — REFUSE-OVER-GUESS's three typed refusals
 *  (insufficient-data/insufficient-budget/unjudged) sit alongside pass/fail/error. */
export type Verdict = 'pass' | 'fail' | 'insufficient-data' | 'insufficient-budget' | 'unjudged' | 'error'

export interface WriteVerdictInput {
  userId: string
  /** The agent_runs row this verdict traces back to, when there is one — a
   *  user-triggered route click (like /api/outreach/judge) has none. */
  runId?: string | null
  subjectKind: VerdictSubjectKind
  subjectId: string
  judge: VerdictJudge
  verdict: Verdict
  /** NULL for a refusal verdict — see the migration's own column comment:
   *  a refusal never carries a substituted score. */
  score?: number | null
  threshold?: number | null
  rationale?: string | null
  model?: string | null
  tokensUsed?: number | null
}

/** Persist one verdict row. Service-role write — RLS on eval_verdicts is
 *  owner-SELECT-only, so every writer uses the admin client (see the
 *  migration's RLS section for why that's correct here, not a gap). */
export async function writeVerdict(admin: AdminClient, input: WriteVerdictInput): Promise<void> {
  try {
    const spanId = currentTraceContext()?.parentSpanId ?? null
    const { error } = await admin.from('eval_verdicts').insert({
      user_id: input.userId,
      run_id: input.runId ?? null,
      span_id: spanId,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId,
      judge: input.judge,
      score: input.score ?? null,
      verdict: input.verdict,
      threshold: input.threshold ?? null,
      rationale: input.rationale ?? null,
      model: input.model ?? null,
      tokens_used: input.tokensUsed ?? null,
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    logApiError('eval_verdicts:write', err, {
      userId: input.userId,
      subjectKind: input.subjectKind,
      judge: input.judge,
    })
  }
}

export interface EvalVerdictRow {
  id: string
  user_id: string
  run_id: string | null
  span_id: string | null
  subject_kind: VerdictSubjectKind
  subject_id: string
  judge: VerdictJudge
  score: number | null
  verdict: Verdict
  threshold: number | null
  rationale: string | null
  model: string | null
  tokens_used: number | null
  created_at: string
}

/** Every verdict recorded for one subject, newest first. Throws on a query
 *  failure (unlike writeVerdict) — a caller reading verdicts back needs to
 *  know a query failed rather than silently seeing "no verdicts yet". */
export async function readVerdicts(
  admin: AdminClient,
  query: { userId: string; subjectKind: VerdictSubjectKind; subjectId: string }
): Promise<EvalVerdictRow[]> {
  const { data, error } = await admin
    .from('eval_verdicts')
    .select('*')
    .eq('user_id', query.userId)
    .eq('subject_kind', query.subjectKind)
    .eq('subject_id', query.subjectId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`Failed to read eval verdicts: ${error.message}`)
  return (data ?? []) as EvalVerdictRow[]
}

/**
 * Which of these application_drafts ids carry an 'unjudged' cv_tailor_draft
 * verdict — ruling 2c's "requires human review, never auto-advances" check,
 * batched (one query, not N) for a caller re-validating a whole review
 * manifest. See app/api/drafts/batch-approve/eligibility.ts#BatchCandidate.
 * requiresReview for how this feeds the batch gate.
 */
export async function unjudgedCvTailorDraftIds(admin: AdminClient, userId: string, draftIds: string[]): Promise<Set<string>> {
  if (draftIds.length === 0) return new Set()
  const { data, error } = await admin
    .from('eval_verdicts')
    .select('subject_id')
    .eq('user_id', userId)
    .eq('subject_kind', 'cv_tailor_draft')
    .eq('verdict', 'unjudged')
    .in('subject_id', draftIds)
  if (error) throw new Error(`unjudgedCvTailorDraftIds failed: ${error.message}`)
  return new Set(((data ?? []) as { subject_id: string }[]).map((r) => r.subject_id))
}
