// trace_spans emission — Step 2 of the langgraph port (docs/superpowers/
// specs/2026-08-16-langgraph-port-design.md, "Reward loops + tracing":
// "trace_spans emitted from callLlm + the unit wrapper + the invoke wrapper
// (all surfaces, graphed or not — never from LangGraph callbacks)").
// supabase/migrations/20260818000001_trace_spans.sql already landed the
// table (RLS + demo wipe, ruling 5). This file was its only writer through
// Step 2; Step 7 (the journal swap, ruling 1's endgame) added a SECOND,
// direct writer — lib/graph/journal.ts's upsertStep — for the live, resumable
// step ledger this file's batched-flush SpanBuffer structurally can't offer
// (see journal.ts's own header for why the two coexist instead of merging).
// Both writers are enforced by lib/graph/graph-chokepoints.test.ts's
// "trace_spans has exactly its two known writers" scan — a THIRD writer
// appearing anywhere else is a scan failure, not a silent addition.
//
// OTEL-SHAPED, NOT OTEL. SpanRecord below mirrors an OTel span's fields
// (trace/span/parent ids, kind, start/end, status, attributes) because that
// vocabulary is already the right shape for a call tree — but there is no
// OTel SDK here, on purpose. The SDK's exporters are built around a
// long-lived process with a batch processor flushing on a timer; a
// serverless invocation has neither — it can be frozen or killed between
// "the SDK queued this span" and "the SDK's timer fired", losing spans
// silently with no queue to recover from on the next cold start. Postgres,
// written directly by whoever is already inside the invocation and about to
// return, has no such gap. (Spec decision, see the doc's "Tracing" row.)
//
// WHY AsyncLocalStorage, REUSING lib/memory/mem0-store.ts's PATTERN
//   callLlm has no `config`/context parameter — its signature is
//   (apiKeys, opts, signal), unchanged by this port on purpose (see llm.ts's
//   own header) — so a span buffer can't reach it as an explicit argument
//   without changing that signature at every one of its ~15 call sites, most
//   of which have no notion of "the current graph invocation" to pass down.
//   lib/memory/mem0-store.ts already solved the identical shape of problem
//   (a per-call context a deeply-nested library call needs, that can't be a
//   constructor/call argument) with an AsyncLocalStorage — apiKeysContext,
//   see that file's own header. Reusing that exact mechanism here (ponytail
//   rung 2: a pattern already in this codebase) rather than inventing a
//   second one is what "detect via an explicit context argument... unless
//   the repo already has an AsyncLocalStorage pattern" in the build brief
//   means in practice.
//
// BUFFER, NOT STREAM. A SpanBuffer only ever accumulates in memory; nothing
// in this file talks to Postgres until `.flush()` is called. Every span
// already carries both its start AND end time by the time it's recorded
// (see `withSpan` below) — there is no "open span" state to persist, which
// is what makes a single batched insert at the end of an invocation correct
// instead of lossy: a killed invocation loses at most the spans already
// buffered for THAT invocation, never a partially-written one. The
// checkpointer (lib/graph/pg.ts) holds the authoritative resumable state for
// a graph run regardless — this buffer is observability, not a source of
// truth, so losing it on a kill is an acceptable, bounded loss, not a data-
// loss bug.

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AdminClient } from '../harness/types'
import { mirrorSpansToLangfuse } from '../observability/langfuse'

/** Matches the `kind` CHECK constraint on public.trace_spans. */
export type SpanKind = 'graph' | 'node' | 'llm' | 'tool' | 'judge' | 'http'
export type SpanStatus = 'ok' | 'error'

/** One trace_spans row, shaped for a direct `.insert()`. */
export interface SpanRecord {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  user_id: string
  thread_id: string | null
  run_id: string | null
  name: string
  kind: SpanKind
  start_time: string
  end_time: string
  status: SpanStatus
  attributes: Record<string, unknown> | null
  events: unknown | null
}

// --- attribute size discipline -----------------------------------------
//
// ponytail: a single fixed per-VALUE cap (not a whole-attributes-object
// cap), applied to strings only — the fields this stage actually attaches
// (model ids, token counts, cost, an error message) are either numbers/
// booleans that are never large, or strings whose only realistic way to
// blow past a few hundred bytes is an error message. Full payloads already
// live in agent_steps/journal (see runAgentUnit); raise this only if a
// legitimate short attribute is ever observed clipped.
export const SPAN_ATTRIBUTE_VALUE_CAP_BYTES = 8 * 1024

function capValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (Buffer.byteLength(value, 'utf8') <= SPAN_ATTRIBUTE_VALUE_CAP_BYTES) return value
  return `${Buffer.from(value, 'utf8').subarray(0, SPAN_ATTRIBUTE_VALUE_CAP_BYTES).toString('utf8')}…[truncated]`
}

export function capAttributes(attrs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!attrs) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) out[k] = capValue(v)
  return out
}

// --- buffer --------------------------------------------------------------

/**
 * Accumulates spans for ONE invocation (a graph invoke, or a standalone
 * runAgentUnit/callLlm call that found no ambient invocation to join — see
 * `acquireSpanScope` below) and flushes them as a single batched insert.
 * `userId`/`threadId` are invocation-level constants shared by every span in
 * the buffer; `run_id` varies per span (a graph invocation may have no
 * domain agent_runs row at all — see invoke.ts — while a unit nested inside
 * a harness run does), so it is supplied per-record, not here.
 */
export class SpanBuffer {
  readonly traceId: string
  readonly userId: string
  readonly threadId: string | null
  private pending: SpanRecord[] = []

  constructor(userId: string, threadId: string | null = null, traceId: string = randomUUID()) {
    this.userId = userId
    this.threadId = threadId
    this.traceId = traceId
  }

  record(span: Omit<SpanRecord, 'trace_id' | 'user_id' | 'thread_id'>): void {
    this.pending.push({ trace_id: this.traceId, user_id: this.userId, thread_id: this.threadId, ...span })
  }

  get size(): number {
    return this.pending.length
  }

  /**
   * Batched single-insert flush. Best-effort, ALWAYS: a flush failure (bad
   * connection, an admin fake in a test with no trace_spans table, whatever)
   * is logged and swallowed, never thrown — losing observability must never
   * fail the request that produced it. Drains `pending` up front so a second
   * flush() call (e.g. a redundant one in an error path) never double-inserts.
   */
  async flush(admin: AdminClient): Promise<void> {
    if (this.pending.length === 0) return
    const rows = this.pending.splice(0, this.pending.length)
    try {
      const { error } = await admin.from('trace_spans').insert(rows)
      if (error) console.error(`[trace] span flush failed (${rows.length} span(s) dropped): ${error.message}`)
    } catch (err) {
      console.error(
        `[trace] span flush threw (${rows.length} span(s) dropped): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    // Fire-and-forget Langfuse mirror — never awaited, so a slow or
    // unreachable Langfuse never adds latency to the request that produced
    // these spans. Postgres above is the write this function's caller
    // actually depends on; this is a bonus copy for whoever opted into it.
    // See lib/observability/langfuse.ts's header for the full rationale.
    void mirrorSpansToLangfuse(rows).catch((err) =>
      console.error(`[trace] Langfuse mirror threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`)
    )
  }
}

// --- ambient context -------------------------------------------------------

export interface TraceContext {
  buffer: SpanBuffer
  /** The span new work started from here should nest under. */
  parentSpanId: string | null
  /** The domain agent_runs.id this context knows about, or null when none
   *  is known at this level (e.g. invoke.ts's own graph-root context — see
   *  that file's header for why it never guesses one). */
  runId: string | null
}

const traceContext = new AsyncLocalStorage<TraceContext>()

export function currentTraceContext(): TraceContext | undefined {
  return traceContext.getStore()
}

export function runInTraceContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return traceContext.run(ctx, fn)
}

export interface SpanScope {
  buffer: SpanBuffer
  parentSpanId: string | null
  runId: string | null
  /** True when this call created `buffer` itself (no ambient TraceContext
   *  was active) — ownership of `.flush()` follows creation: whoever made
   *  the buffer is the one who must flush it, an invocation nested inside
   *  another's context never flushes a buffer it doesn't own. */
  owns: boolean
}

/**
 * Join the ambient invocation's span buffer, or start a fresh one when
 * called with no invocation around it at all (runAgentUnit called directly
 * via lib/graph/oneshot.ts#runUnitOnce; callLlm called directly by a route
 * that never went through a unit or a graph). The fresh buffer has no known
 * thread — a standalone call has no real graph_threads row to point at (see
 * trace_spans' nullable thread_id) — and no known run_id; a caller that DOES
 * know its own domain run id (runAgentUnit always does) supplies it directly
 * to `withSpan`/`runInTraceContext` rather than through this function.
 */
export function acquireSpanScope(userId: string): SpanScope {
  const ctx = currentTraceContext()
  if (ctx) return { buffer: ctx.buffer, parentSpanId: ctx.parentSpanId, runId: ctx.runId, owns: false }
  return { buffer: new SpanBuffer(userId), parentSpanId: null, runId: null, owns: true }
}

// --- span emission ---------------------------------------------------------

export interface SpanSpec {
  parentSpanId: string | null
  runId: string | null
  kind: SpanKind
  name: string
}

/**
 * Run `fn`, recording exactly one span into `buffer` covering its full
 * duration — 'ok' with `attributesOf(result, undefined)` on success, 'error'
 * with `attributesOf(undefined, err)` on failure, the thrown error always
 * rethrown unchanged either way. `fn` receives the new span's own id so a
 * caller that wants CHILDREN of this span (runAgentUnit nesting callLlm
 * under its own 'node' span) can pass it into `runInTraceContext` from
 * inside `fn`.
 */
export async function withSpan<T>(
  buffer: SpanBuffer,
  spec: SpanSpec,
  fn: (spanId: string) => Promise<T>,
  attributesOf?: (result: T | undefined, err: unknown) => Record<string, unknown> | undefined
): Promise<T> {
  const spanId = randomUUID()
  const startTime = new Date().toISOString()
  try {
    const result = await fn(spanId)
    buffer.record({
      span_id: spanId,
      parent_span_id: spec.parentSpanId,
      run_id: spec.runId,
      kind: spec.kind,
      name: spec.name,
      start_time: startTime,
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: capAttributes(attributesOf?.(result, undefined)),
      events: null,
    })
    return result
  } catch (err) {
    buffer.record({
      span_id: spanId,
      parent_span_id: spec.parentSpanId,
      run_id: spec.runId,
      kind: spec.kind,
      name: spec.name,
      start_time: startTime,
      end_time: new Date().toISOString(),
      status: 'error',
      attributes: capAttributes(attributesOf?.(undefined, err)),
      events: null,
    })
    throw err
  }
}

// --- retention -------------------------------------------------------------
//
// The trace_spans migration's own header flags this as unimplemented at
// landing time and names its future home precisely: "A later wiring step
// adds a pruning pass to the existing daily cron... rather than standing up
// a second scheduled path" (supabase/migrations/20260818000001_trace_spans.
// sql). app/api/harness/cron/route.ts wires this in beside its own demo-wipe
// pass (lib/access/demo-wipe.ts), same independent-and-best-effort posture.

// ponytail: one fixed retention window for every span, not a per-user or
// per-kind setting — raise or split this only if a real need for variable
// retention shows up.
export const TRACE_SPAN_RETENTION_DAYS = 60

/**
 * Deletes every trace_spans row older than TRACE_SPAN_RETENTION_DAYS.
 * Never throws: a failed prune is logged and returns 0, matching demo-
 * wipe.ts's fire-and-log posture for the same cron tick.
 */
export async function pruneOldTraceSpans(admin: AdminClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRACE_SPAN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { error, count } = await admin.from('trace_spans').delete({ count: 'exact' }).lt('start_time', cutoff)
  if (error) {
    console.error(`[trace] prune failed: ${error.message}`)
    return 0
  }
  return count ?? 0
}
