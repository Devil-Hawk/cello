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
// LANGFUSE REPLAY. This buffer is also the ONLY capture point for the Langfuse
// export (lib/observability/langfuse.ts). A record may carry an in-memory `lf`
// payload (names, usage, cost, prompt text); flush() strips it before the
// insert and replays the records to Langfuse as observations with their real
// timestamps, so there is no second span tree and no live OTel context. `lf` is
// built only when the buffer's export is enabled (keys set and trace sampled).
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
import { readProfileForDemoGuards } from '../harness/keys'
import type { AdminClient } from '../harness/types'
import { contentCaptureFor, exportTrace, langfuseConfigured, traceSampled } from '../observability/langfuse'

/** Matches the `kind` CHECK constraint on public.trace_spans. */
export type SpanKind = 'graph' | 'node' | 'llm' | 'tool' | 'judge' | 'http'
export type SpanStatus = 'ok' | 'error'

/** Langfuse observation types a record can ask for. */
export type LfType = 'agent' | 'chain' | 'span' | 'generation' | 'embedding' | 'tool' | 'retriever'

/**
 * What the Langfuse export needs beyond the trace_spans columns. In memory
 * only: flush() strips it before the Postgres insert, so prompt and completion
 * text can never reach the database, and langfuse.ts redacts and caps every
 * string in it before it leaves the process. Built only when the buffer's
 * export is enabled (see SpanBuffer.exportEnabled).
 */
export interface LfPayload {
  /** Stable Langfuse name (a code constant, never free text). */
  name?: string
  /** Defaults from the span kind. Usage and cost only ride generation/embedding. */
  type?: LfType
  /** Observation input and output. Set only when the buffer captures content. */
  input?: unknown
  output?: unknown
  model?: string
  modelParameters?: Record<string, string | number>
  /** usageDetails buckets (input, output, total). */
  usage?: Record<string, number>
  /** costDetails in USD. */
  cost?: Record<string, number>
  /** Ids, enums and numbers only. Sent even with content capture off. */
  metadata?: Record<string, string | number | boolean>
  /** Free text (a planner label, an MCP server name). Sent only with capture on. */
  detail?: Record<string, string>
  /** Prompt version (a content hash). */
  version?: string
  level?: 'WARNING' | 'ERROR'
  /** Short machine code for a failure or warning, see errorCode(). */
  errorCode?: string
  /** The raw error text. Set only when the buffer captures content. */
  errorMessage?: string
}

/** Trace-level facts the Langfuse export stamps on every observation. */
export interface TraceMeta {
  /** Trace name constant. Defaults to the root observation's stable name. */
  name?: string
  /** Copilot conversation id, or a run/digest thread id. */
  sessionId?: string
  /** True for a demo workspace, false for the owner. Undefined is treated as
   *  demo (fail closed): demo content capture is off by default. */
  isDemo?: boolean
  /** Tag `feature:<x>` and metadata.feature. Defaults to the trace name. */
  feature?: string
  /** Ids and enums only, at most 200 chars each. */
  metadata?: Record<string, string>
  /** Root observation input and output (the trace input/output in Langfuse).
   *  The root span's lfOf reads these when it ends, so a graph that learns its
   *  answer late (copilot's finalize) can set the output after invoke returns.
   *  Used only when the buffer captures content. */
  input?: unknown
  output?: unknown
}

/** A judge verdict waiting to become a Langfuse score at replay time. Scores
 *  ride the replay so a sampled-out trace emits none. */
export interface PendingScore {
  /** `<subject_kind>.<judge>`, e.g. `outreach_draft.factuality`. */
  name: string
  /** 0..1 for a numeric score, null for a refusal (sent as a categorical outcome). */
  value: number | null
  /** pass, fail, insufficient-data... */
  verdict: string
  /** span_id of the judge generation that produced it, when known. */
  spanId?: string | null
  rationale?: string | null
  /** Ids, enums and numbers only. */
  metadata?: Record<string, string | number | boolean>
}

/** A short, content-free code for a failure: `http_429`, `ETIMEDOUT`,
 *  `TypeError`, else `error`. Never the message text. */
export function errorCode(err: unknown): string {
  const e = err as { status?: unknown; code?: unknown; name?: unknown } | null | undefined
  if (typeof e?.status === 'number') return `http_${e.status}`
  if (typeof e?.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(e.code)) return e.code
  if (typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name
  return 'error'
}

/** One trace_spans row, shaped for a direct `.insert()`, plus `lf`, which is
 *  NOT a column: flush() strips it before the insert so prompt and
 *  completion text can never reach Postgres. */
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
  lf?: LfPayload
  /** False keeps the record out of trace_spans (Langfuse only, e.g. embeddings).
   *  Not a column either: flush() strips it. */
  persist?: false
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
  private flushed = false
  private exportCache: boolean | undefined
  meta: TraceMeta
  readonly scores: PendingScore[] = []

  constructor(userId: string, threadId: string | null = null, traceId: string = randomUUID(), meta: TraceMeta = {}) {
    this.userId = userId
    this.threadId = threadId
    this.traceId = traceId
    this.meta = meta
  }

  /** Merge trace-level facts (name, session, isDemo...). Re-decides sampling. */
  setMeta(patch: Partial<TraceMeta>): void {
    this.meta = { ...this.meta, ...patch, metadata: { ...this.meta.metadata, ...patch.metadata } }
    this.exportCache = undefined
  }

  /** Queue a judge verdict for the Langfuse replay. Nothing is kept when the
   *  trace is not exported. */
  addScore(score: PendingScore): void {
    if (this.exportEnabled) this.scores.push(score)
  }

  /** Hand the queued scores to one replay (each is sent once). */
  takeScores(): PendingScore[] {
    return this.scores.splice(0, this.scores.length)
  }

  /** Fill isDemo when the buffer was created before the profile was known.
   *  Fails closed: an unknown flag is filled, and a later `true` (the key
   *  loader saw a demo profile) downgrades an earlier `false`, never the
   *  other way round. */
  adoptDemoFlag(isDemo: boolean | undefined): void {
    if (isDemo === undefined) return
    if (this.meta.isDemo === undefined || (isDemo && this.meta.isDemo === false)) this.setMeta({ isDemo })
  }

  /** Langfuse is configured and this trace is sampled in. Decided once per
   *  trace (and again by setMeta); when false no `lf` payload is built, no
   *  Langfuse package is imported and nothing leaves the process. */
  get exportEnabled(): boolean {
    this.exportCache ??= langfuseConfigured() && traceSampled(this.traceId, this.meta.isDemo)
    return this.exportCache
  }

  /** Prompt and completion text may be sent for this trace. */
  get captureContent(): boolean {
    return this.exportEnabled && contentCaptureFor(this.meta.isDemo)
  }

  record(span: Omit<SpanRecord, 'trace_id' | 'user_id' | 'thread_id'>): void {
    if (this.flushed) {
      // Recorded after the owner already flushed: still exported if flush()
      // runs again, but a span that nobody flushes is lost, so say so once.
      this.flushed = false
      console.warn(`[trace] span "${span.name}" recorded after flush; it is lost unless flush() runs again`)
    }
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
    this.flushed = true
    // Started first so it overlaps the insert. It never rejects. On Vercel it
    // runs inside waitUntil and resolves at once; elsewhere it is awaited up to
    // a deadline. See langfuse.ts's delivery notes.
    const exporting = exportTrace(this, rows).catch((err) =>
      console.error(`[trace] Langfuse export threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`)
    )
    try {
      // `lf` (prompt/completion text) is dropped here, never persisted, and
      // Langfuse-only records (persist:false) never become rows at all.
      // trace_spans.parent_span_id is a foreign key, so a persisted row whose
      // parent is Langfuse-only (an embedding or retriever record) re-parents to
      // its nearest persisted ancestor, or becomes a root.
      const byId = new Map(rows.map((r) => [r.span_id, r]))
      const persistedParent = (r: SpanRecord): string | null => {
        let p = r.parent_span_id ? byId.get(r.parent_span_id) : undefined
        for (let hops = 0; p && hops < 64; hops += 1) {
          if (p.persist !== false) return p.span_id
          p = p.parent_span_id ? byId.get(p.parent_span_id) : undefined
        }
        return null
      }
      const persisted = rows
        .filter((r) => r.persist !== false)
        .map(({ lf: _lf, persist: _persist, ...row }) => ({
          ...row,
          parent_span_id: row.parent_span_id && byId.get(row.parent_span_id)?.persist === false ? persistedParent(row) : row.parent_span_id,
        }))
      if (persisted.length > 0) {
        const { error } = await admin.from('trace_spans').insert(persisted)
        if (error) console.error(`[trace] span flush failed (${persisted.length} span(s) dropped): ${error.message}`)
      }
    } catch (err) {
      console.error(
        `[trace] span flush threw (${rows.length} span(s) dropped): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    await exporting
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
export function acquireSpanScope(userId: string, isDemo?: boolean): SpanScope {
  const ctx = currentTraceContext()
  if (ctx) {
    ctx.buffer.adoptDemoFlag(isDemo)
    return { buffer: ctx.buffer, parentSpanId: ctx.parentSpanId, runId: ctx.runId, owns: false }
  }
  return { buffer: new SpanBuffer(userId, null, undefined, { isDemo }), parentSpanId: null, runId: null, owns: true }
}

// --- span emission ---------------------------------------------------------

export interface SpanSpec {
  parentSpanId: string | null
  runId: string | null
  kind: SpanKind
  name: string
  /** False: a Langfuse-only span. Recorded only when the trace is exported,
   *  and never inserted into trace_spans. */
  persist?: false
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
  fn: (spanId: string | null) => Promise<T>,
  attributesOf?: (result: T | undefined, err: unknown) => Record<string, unknown> | undefined,
  lfOf?: (result: T | undefined, err: unknown, capture: boolean) => LfPayload | undefined
): Promise<T> {
  const spanId = randomUUID()
  const startTime = new Date().toISOString()
  // A Langfuse-only span has nowhere to go when the trace is not exported. It
  // is never recorded, so children nest under its parent: a phantom id would
  // break trace_spans.parent_span_id's foreign key and drop the whole batch.
  if (spec.persist === false && !buffer.exportEnabled) return fn(spec.parentSpanId)
  // The Langfuse payload is built ONLY when this trace is exported, and gets
  // `capture` so it can skip building prompt text when content is off. A
  // failure here must never fail the request: observability only.
  const lfFor = (result: T | undefined, err: unknown, failed: boolean): LfPayload | undefined => {
    if (!buffer.exportEnabled) return undefined
    let lf: LfPayload | undefined
    try {
      lf = lfOf?.(result, err, buffer.captureContent)
    } catch (e) {
      console.warn(`[trace] lfOf threw: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (!failed) return lf
    const message = err instanceof Error ? err.message : String(err)
    return {
      ...lf,
      errorCode: lf?.errorCode ?? errorCode(err),
      errorMessage: lf?.errorMessage ?? (buffer.captureContent ? message : undefined),
    }
  }
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
      lf: lfFor(result, undefined, false),
      ...(spec.persist === false ? { persist: false as const } : {}),
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
      lf: lfFor(undefined, err, true),
      ...(spec.persist === false ? { persist: false as const } : {}),
    })
    throw err
  }
}

export interface ObserveSpec {
  /** Langfuse name: a lowercase code constant. */
  name: string
  type: LfType
  /** trace_spans kind when the span is persisted. Default `tool`. */
  kind?: SpanKind
  /** False keeps it Langfuse-only (retrievers and the like). */
  persist?: false
  /** Small, content-free trace_spans attributes for a persisted span. */
  attributesOf?: (result: never, err: unknown) => Record<string, unknown> | undefined
}

/**
 * Record `fn` as one child observation of the ambient trace (a tool call, a
 * retrieval). Outside a trace, and when the trace is not exported and the span
 * is Langfuse-only, it just runs `fn`: lone observations would make
 * single-observation traces that cost units and show nothing.
 */
export async function observe<T>(
  spec: ObserveSpec,
  fn: () => Promise<T>,
  lfOf?: (result: T | undefined, err: unknown, capture: boolean) => Omit<LfPayload, 'name' | 'type'> | undefined
): Promise<T> {
  const ctx = currentTraceContext()
  if (!ctx) return fn()
  return withSpan(
    ctx.buffer,
    { parentSpanId: ctx.parentSpanId, runId: ctx.runId, kind: spec.kind ?? 'tool', name: spec.name, persist: spec.persist },
    (spanId) => runInTraceContext({ ...ctx, parentSpanId: spanId }, fn),
    spec.attributesOf as ((result: T | undefined, err: unknown) => Record<string, unknown> | undefined) | undefined,
    (result, err, capture) => ({ name: spec.name, type: spec.type, ...lfOf?.(result, err, capture) })
  )
}

/** Set the output of the current trace's root observation (copilot's reply,
 *  a run's summary). A no-op outside a trace. */
export function setTraceOutput(output: unknown): void {
  const ctx = currentTraceContext()
  if (ctx) ctx.buffer.meta.output = output
}

/** Set the input of the current trace's root observation, for a route that
 *  only knows it after parsing its body. Request essentials only (ids, titles),
 *  never resume text. A no-op outside a trace. */
export function setTraceInput(input: unknown): void {
  const ctx = currentTraceContext()
  if (ctx) ctx.buffer.meta.input = input
}

export interface TraceSpec {
  /** Trace and root observation name: a lowercase code constant. */
  name: string
  /** Root observation type, default `span`. */
  type?: LfType
  /** Request essentials (ids, titles, counts). Never resume text or base64. */
  input?: unknown
  /** Result summary for the root observation's output. */
  outputOf?: (result: never) => unknown
  isDemo?: boolean
  sessionId?: string
  /** Ids and enums only. */
  metadata?: Record<string, string>
}

/**
 * Give a standalone route (or any code with no graph around it) a named
 * Langfuse trace: a root observation that every `callLlm`, judge and tool call
 * inside `fn` nests under. The root is Langfuse-only (persist:false), so
 * trace_spans gains no rows. Inside an ambient trace this is a plain child
 * observation, and only the call that created the buffer flushes it.
 */
export async function withTrace<T>(admin: AdminClient, userId: string, spec: TraceSpec, fn: () => Promise<T>): Promise<T> {
  // Demo or owner decides whether prompt text may leave and how the trace is
  // sampled, and the root observation is decided at its start, so the answer
  // is needed before the first span. Read only when Langfuse is on.
  let isDemo = spec.isDemo
  if (isDemo === undefined && !currentTraceContext() && langfuseConfigured()) {
    try {
      const { row } = await readProfileForDemoGuards(admin, userId)
      isDemo = row ? (row.is_demo === true || Boolean(row.demo_expires_at) ? true : row.is_demo === false ? false : undefined) : undefined
    } catch {
      // Unknown stays unknown, which counts as demo (fail closed).
    }
  }
  const scope = acquireSpanScope(userId, isDemo)
  if (scope.owns) {
    scope.buffer.setMeta({
      name: spec.name,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    })
  }
  try {
    return await withSpan(
      scope.buffer,
      { parentSpanId: scope.parentSpanId, runId: scope.runId, kind: 'http', name: spec.name, persist: false },
      (spanId) => runInTraceContext({ buffer: scope.buffer, parentSpanId: spanId, runId: scope.runId }, fn),
      undefined,
      (result, _err, capture) => ({
        name: spec.name,
        type: spec.type ?? 'span',
        ...(capture
          ? {
              input: (scope.owns ? scope.buffer.meta.input : undefined) ?? spec.input,
              output:
                (scope.owns ? scope.buffer.meta.output : undefined) ??
                (result !== undefined && spec.outputOf ? (spec.outputOf as (r: T) => unknown)(result) : undefined),
            }
          : {}),
      })
    )
  } finally {
    // A root with nothing under it (a request that never reached a model) is
    // not worth a unit: only the call that created the buffer flushes, and only
    // when something ran inside it.
    if (scope.owns && (scope.buffer.size > 1 || !scope.buffer.exportEnabled)) await scope.buffer.flush(admin)
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
