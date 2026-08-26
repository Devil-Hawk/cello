// Idempotent agent_runs journaling + the step ledger, backed by trace_spans
// (Step 7 of the langgraph port — binding ruling 1's endgame: "agent_steps
// dies; trace_spans wins... stage 3 swaps journal.ts's backing store to
// trace_spans, repoints the UI, drops agent_steps.").
//
// WHY THIS FILE EXISTS SEPARATELY FROM lib/harness/executor.ts
//   executor.ts's insertStep/startStep/finishStep are keyed on a Postgres
//   `id` the caller remembers in a local variable across a single in-process
//   run. A LangGraph Functional-API task has no such variable to remember
//   across invocations — a killed-and-resumed run re-enters the SAME task
//   function from the top, with nothing but the arguments it was originally
//   called with (see SPIKE_FINDINGS in lib/graph/invoke.ts). So this file's
//   primitive is find-by-(run_id, label, iteration)-then-write, not
//   write-then-remember-the-id: calling journalStepStart/journalStepFinish
//   twice with the same key updates the row the first call created instead
//   of inserting a duplicate.
//
// WHY A ROW HERE COEXISTS WITH lib/trace/spans.ts's OWN 'node' SPAN, NOT A
// MERGE OF THE TWO
//   lib/graph/unit.ts wraps every unit call in BOTH this file's journal AND
//   lib/trace/spans.ts's withSpan (kind:'node' there too). That looks
//   redundant but is structurally necessary, not an oversight: spans.ts's
//   SpanBuffer only ever writes once, at the END of a whole invocation (see
//   its own header — "there is no 'open span' state to persist"), so a run
//   still IN PROGRESS has nothing queryable there yet. This file's whole
//   reason to exist is the opposite: a step's 'running' row must be visible
//   the instant it starts (the run-detail UI polls it live) and survive a
//   kill before the matching finish ever arrives — properties a buffered,
//   flush-at-the-end writer cannot offer. So both write kind='node' rows
//   for the same call, for two different reasons — the live, resumable step
//   ledger (this file) and the OTel-shaped trace tree (spans.ts) — and
//   `isJournaledStepRow` below is how a reader (this file's own upsert
//   lookup, and the run-detail API route) tells its own rows apart from
//   spans.ts's: only THIS file's rows carry `attributes.stepStatus`.
//
// This file does NOT import lib/trace/spans.ts — the writes below are
// direct, synchronous inserts/updates, never routed through SpanBuffer. A
// buffered writer is wrong for this file's job (see above); reusing the
// buffer's plumbing just to bypass it immediately would be a fake shared
// abstraction, not a real one.

import { randomUUID } from 'node:crypto'
import type { AdminClient, AgentType, RunStatus, StepStatus } from '../harness/types'
import type { AgentStepRow } from '../harness/types'

// --- the step ledger, backed by trace_spans -----------------------------

/** Identifies one journaled step without needing to remember its span_id. */
export interface StepKey {
  runId: string
  label: string
  /** null/omitted for a plain plan step; set for a loop iteration or fan-out child. */
  iteration?: number | null
}

/** The subset of a trace_spans row's shape this file reads/writes attributes as. */
interface StepAttributes {
  agentType: string
  stepStatus: StepStatus
  iteration: number | null
  input?: unknown
  output?: unknown
  tokensUsed?: number
}

/** True for a trace_spans row THIS FILE wrote — see the file header for why
 *  a kind='node' row can otherwise belong to lib/trace/spans.ts instead. */
export function isJournaledStepRow(row: { kind?: unknown; attributes?: unknown }): boolean {
  const attrs = row.attributes as Record<string, unknown> | null | undefined
  return row.kind === 'node' && typeof attrs?.stepStatus === 'string'
}

interface FoundStepRow {
  span_id: string
  attributes: StepAttributes
}

/**
 * Look up an existing journaled row by (run_id, label, iteration). Fetches
 * every kind='node' row sharing (run_id, name) — which may include a
 * spans.ts-authored row with the SAME name (see file header) — and picks
 * the one THIS file wrote whose iteration matches, in application code
 * rather than a jsonb-path DB filter (simpler, and every candidate set here
 * is at most a couple of rows).
 */
async function findStepRow(admin: AdminClient, key: StepKey): Promise<FoundStepRow | null> {
  const { data, error } = await admin
    .from('trace_spans')
    .select('span_id, kind, attributes')
    .eq('run_id', key.runId)
    .eq('kind', 'node')
    .eq('name', key.label)
  if (error) {
    console.error(`[graph] journal: step lookup failed for run ${key.runId} label ${key.label}: ${error.message}`)
    return null
  }
  const wantIteration = key.iteration ?? null
  const rows = (data ?? []) as { span_id: string; kind: string; attributes: Record<string, unknown> | null }[]
  const match = rows.find(
    (r) => isJournaledStepRow(r) && (((r.attributes as Record<string, unknown>).iteration as number | null) ?? null) === wantIteration
  )
  return match ? { span_id: match.span_id, attributes: match.attributes as unknown as StepAttributes } : null
}

/** agent_runs.user_id for `runId` — trace_spans.user_id is NOT NULL, and
 *  neither journalStepStart's nor journalStepFinish's args carry a userId
 *  (their call sites are untouched by this port stage), so a fresh row's
 *  owner is looked up from the run it belongs to, the same fact
 *  lib/graph/unit.ts already trusts agent_runs to hold. Only paid on the
 *  INSERT path — an update never needs it, the row already has an owner. */
async function lookupRunUserId(admin: AdminClient, runId: string): Promise<string | null> {
  const { data, error } = await admin.from('agent_runs').select('user_id').eq('id', runId).maybeSingle()
  if (error || !data) {
    console.error(`[graph] journal: could not resolve user_id for run ${runId} (required to journal a new step): ${error?.message ?? 'run not found'}`)
    return null
  }
  return (data as { user_id: string }).user_id
}

/** 'running'/'pending' have no span yet to close (span open, status NULL —
 *  trace_spans.status only ever means ok/error); 'skipped' is the system
 *  working as intended, not an error, so it projects to 'ok' alongside
 *  'completed'. The fine-grained StepStatus survives regardless, in
 *  attributes.stepStatus — this projection is only for the coarse span
 *  column every OTHER span kind in this table also uses. */
function projectSpanStatus(stepStatus: StepStatus): 'ok' | 'error' | null {
  if (stepStatus === 'failed') return 'error'
  if (stepStatus === 'running' || stepStatus === 'pending') return null
  return 'ok'
}

/**
 * Insert-or-update one journaled step, keyed on (run_id, label, iteration).
 * `attrPatch` merges into the row's existing `attributes` (never replaces it
 * wholesale — journalStepStart and journalStepFinish each touch only their
 * own fields, exactly like the pre-port agent_steps columns they used to
 * write independently); `columnPatch` touches real trace_spans columns
 * directly. `parentSpanId` is only ever applied on INSERT, matching the
 * pre-port behavior of the identical `parent_step_id` field this replaces.
 * Safe to call any number of times with the same key — the second call
 * updates rather than duplicates.
 */
async function upsertStep(
  admin: AdminClient,
  key: StepKey,
  columnPatch: { start_time?: string; end_time?: string },
  attrPatch: Partial<StepAttributes>,
  insertExtra: { agentType: string; parentSpanId: string | null }
): Promise<string | null> {
  const existing = await findStepRow(admin, key)
  const mergedAttrs: StepAttributes = {
    agentType: insertExtra.agentType,
    stepStatus: 'running',
    ...existing?.attributes,
    ...attrPatch,
    iteration: key.iteration ?? null, // identity, never drifts from the key regardless of what attrPatch carries
  }
  const status = projectSpanStatus(mergedAttrs.stepStatus)

  if (existing) {
    const { error } = await admin
      .from('trace_spans')
      .update({ ...columnPatch, status, attributes: mergedAttrs })
      .eq('span_id', existing.span_id)
    if (error) {
      console.error(`[graph] journal: step update failed for ${existing.span_id}: ${error.message}`)
      return null
    }
    return existing.span_id
  }

  const userId = await lookupRunUserId(admin, key.runId)
  if (!userId) return null

  // Generated client-side, not read back via .select().single() after an
  // INSERT — the same choice lib/trace/spans.ts's own withSpan already
  // makes (see its `const spanId = randomUUID()`), and for the same reason:
  // this file's caller (journalStepStart) needs the id immediately, to hand
  // back to whoever's about to journal this step's finish.
  const spanId = randomUUID()
  const row: Record<string, unknown> = {
    span_id: spanId,
    // Groups every journal row for one run under one trace — see file
    // header; there is no ambient invocation trace to join from here (this
    // file writes directly, never through SpanBuffer), and agent_runs.id is
    // already a UUID, so reusing it needs no extra lookup.
    trace_id: key.runId,
    parent_span_id: insertExtra.parentSpanId,
    user_id: userId,
    run_id: key.runId,
    name: key.label,
    kind: 'node',
    status,
    attributes: mergedAttrs,
    events: null,
    // trace_spans.start_time is `timestamptz not null` with no default
    // (supabase/migrations/20260818000001_trace_spans.sql). The defensive
    // insert path — journalStepFinish called with no prior journalStepStart,
    // e.g. runs.ts's markSkipped for a dependency that never ran — only
    // supplies end_time in columnPatch, which would otherwise omit
    // start_time from the INSERT entirely and fail the not-null constraint.
    // Falling back to end_time (the skip happened instantaneously) or now
    // keeps that row landing instead of silently vanishing from the ledger.
    start_time: columnPatch.start_time ?? columnPatch.end_time ?? new Date().toISOString(),
    ...columnPatch,
  }
  const { error } = await admin.from('trace_spans').insert(row)
  if (error) {
    console.error(`[graph] journal: step insert failed for run ${key.runId} label ${key.label}: ${error.message}`)
    return null
  }
  return spanId
}

export interface JournalStepStartArgs extends StepKey {
  agentType: string
  input: unknown
  parentStepId?: string | null
}

/** Port of executor.ts's insertStep+startStep, as one idempotent upsert. */
export async function journalStepStart(admin: AdminClient, args: JournalStepStartArgs): Promise<string | null> {
  return upsertStep(
    admin,
    { runId: args.runId, label: args.label, iteration: args.iteration },
    { start_time: new Date().toISOString() },
    { stepStatus: 'running', input: args.input },
    { agentType: args.agentType, parentSpanId: args.parentStepId ?? null }
  )
}

export interface JournalStepFinishArgs extends StepKey {
  /** Required so a finish call that finds no existing row can still insert one (defensive — see file header). */
  agentType: string
  status: StepStatus
  output: unknown
  tokensUsed: number
  parentStepId?: string | null
}

/** Port of executor.ts's finishStep, as an idempotent upsert. */
export async function journalStepFinish(admin: AdminClient, args: JournalStepFinishArgs): Promise<string | null> {
  return upsertStep(
    admin,
    { runId: args.runId, label: args.label, iteration: args.iteration },
    { end_time: new Date().toISOString() },
    { stepStatus: args.status, output: args.output, tokensUsed: args.tokensUsed },
    { agentType: args.agentType, parentSpanId: args.parentStepId ?? null }
  )
}

/**
 * Reads back a previously-journaled step's output by key, for a caller that
 * needs to inspect a PAST result without ever having remembered its row id
 * (lib/graph/runs.ts's replan-idempotency guard — see that file's own
 * header for why it can't be a memoized task call instead). Returns null
 * when no matching journaled row exists yet.
 */
export async function journalStepOutput(admin: AdminClient, key: StepKey): Promise<unknown> {
  const existing = await findStepRow(admin, key)
  return existing?.attributes.output ?? null
}

/**
 * Maps one trace_spans row this file journaled back into the pre-port
 * AgentStepRow shape the run-detail UI and its API route already speak —
 * the seam translation ruling 1 asks for, so app/api/harness/run/route.ts
 * (and anything else reading the step ledger) never needs to know the
 * backing store changed. `row` is expected to satisfy `isJournaledStepRow`
 * — a caller reads a run's whole `trace_spans` set, filters to this file's
 * own rows, THEN maps each one.
 */
export interface JournaledSpanRow {
  span_id: string
  run_id: string | null
  parent_span_id: string | null
  name: string
  kind: string
  start_time: string
  end_time: string | null
  attributes: Record<string, unknown> | null
}

export function stepRowToAgentStepRow(row: JournaledSpanRow): AgentStepRow {
  const attrs = (row.attributes ?? {}) as Partial<StepAttributes>
  return {
    id: row.span_id,
    run_id: row.run_id ?? '',
    agent_type: (attrs.agentType ?? 'planner') as AgentType,
    label: row.name,
    status: attrs.stepStatus ?? 'pending',
    input: attrs.input ?? null,
    output: attrs.output ?? null,
    tokens_used: attrs.tokensUsed ?? 0,
    started_at: row.start_time,
    finished_at: row.end_time,
    created_at: row.start_time,
    parent_step_id: row.parent_span_id,
    iteration: attrs.iteration ?? null,
  }
}

// --- agent_runs ----------------------------------------------------------
//
// agent_runs.status is untyped `text` with no CHECK constraint (see
// supabase/migrations/20260728000009_run_incomplete_status.sql), so writing
// a value RunStatus (lib/harness/types.ts) doesn't carry breaks nothing at
// the DB layer. 'paused' is graph-native vocabulary for an interrupt()
// boundary, deliberately distinct from the pre-port 'incomplete' status:
// 'incomplete' named a continuation-counter mechanism as the PRIMARY resume
// path (bump-and-cap BEFORE every attempt, regardless of why the run
// stopped) plus the stuck-run reaper — see the spec's "Budget-abort is a
// terminal return... deadline is a typed interrupt" ruling. The reaper is
// fully deleted; agent_runs.continuation_count itself survives as a narrow
// backstop app/api/harness/cron/route.ts's resume pass reuses for a
// DIFFERENT purpose (a consecutive-failure-streak ceiling for resume
// attempts that never reach a checkpoint — see RESUME_ATTEMPT_CEILING
// there), not the primary resume mechanism this file implements. Terminal
// states reuse RunStatus's own terminal members so nothing downstream
// (the UI's completed/failed rendering) needs to change.

export type TerminalRunStatus = Extract<RunStatus, 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'>

async function updateRun(admin: AdminClient, runId: string, fields: Record<string, unknown>, label: string): Promise<void> {
  const { error } = await admin.from('agent_runs').update(fields).eq('id', runId)
  if (error) {
    console.error(`[graph] journal: ${label} failed for run ${runId}: ${error.message}`)
  }
}

/**
 * `threadId`, when supplied, is written in the SAME update as the status
 * flip — see lib/graph/runs.ts's own call site for why this is the only
 * reliable place to persist agent_runs.thread_id: this call re-executes at
 * the very top of every invocation attempt of harnessRun (fresh, resumed, or
 * replaying after a kill), so it lands before any task call that could fail
 * partway through, unlike a write attempted by the calling route only AFTER
 * invokeGraphForUser resolves — which never runs if graph.invoke() itself
 * throws or the process is killed mid-invocation. Idempotent: the same
 * threadId is written on every replay of the same thread.
 */
export async function markRunRunning(admin: AdminClient, runId: string, startedAt?: string, threadId?: string): Promise<void> {
  const fields: Record<string, unknown> = { status: 'running' }
  if (startedAt) fields.started_at = startedAt
  if (threadId) fields.thread_id = threadId
  await updateRun(admin, runId, fields, 'markRunRunning')
}

/** A run parked at interrupt() — resumable, not a failure. */
export async function markRunPaused(admin: AdminClient, runId: string): Promise<void> {
  await updateRun(admin, runId, { status: 'paused' }, 'markRunPaused')
}

export async function markRunTerminal(
  admin: AdminClient,
  runId: string,
  status: TerminalRunStatus,
  extra?: { error?: string | null; result?: unknown }
): Promise<void> {
  const fields: Record<string, unknown> = { status, finished_at: new Date().toISOString() }
  if (extra && 'error' in extra) fields.error = extra.error ?? null
  if (extra && 'result' in extra) fields.result = extra.result
  await updateRun(admin, runId, fields, `markRunTerminal(${status})`)
}
