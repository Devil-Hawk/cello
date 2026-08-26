// The ONE call site for graph.invoke/stream (spec binding ruling 7; enforced
// mechanically by lib/graph/graph-chokepoints.test.ts's source scan (b)).
//
// Everything a graph surface needs that isn't graph-shape-specific lives
// here: thread ownership (anti-IDOR — a thread_id is a bare capability, see
// supabase/migrations/20260817000002_graph_threads.sql), demo-expiry refusal
// at USE time (not just at mint time), the resume-semantics decision the
// LangGraph spike proved out, and the {userId, runId, threadId} injection
// into config.configurable that is the structural fix for the historical
// makeLlmRunner closure bug (userId silently stripped out of a closure ->
// spend went unmetered). MCP's trigger_run and every A2A invoke/poll-resume
// route through this same function (ruling 7) — there is no second door.
//
// GRAPH DEFINITIONS ARE NOT IMPORTED HERE ON PURPOSE. The caller passes in
// its already-compiled graph (a CompiledGraphLike); this file never imports
// lib/graph/runs, lib/graph/copilot, lib/graph/refresh or lib/graph/autopilot
// — that is the inverse of scan (b): graph modules import nothing from
// routes, and this module imports nothing from graph modules. Compiled
// graphs are module singletons (they are user-free — nothing about a graph's
// SHAPE depends on which user is running it); the per-user, per-request bits
// (the checkpointer's live DB connection, config.configurable) are supplied
// fresh on every call, right here.
//
// RESUME SEMANTICS — SPIKE_FINDINGS, verified on real Supabase
// (wf_05c6a6df-a89, adversarially re-confirmed):
//   - {kind:'command', resume}: `new Command({resume})`, ONLY for delivering
//     a human answer to a KNOWN interrupt.
//   - {kind:'continue'} (no resume, no input): `invoke(null, cfg)`. Proven
//     safe and correct for all three states an existing thread can be in —
//     killed-mid-task (completed tasks are memoized by the Functional API and
//     skip; only the in-flight task re-runs), cleanly parked at interrupt()
//     (no-op, re-returns the SAME interrupt id), and fully completed (returns
//     the cached final result, no re-execution).
//   - {kind:'input', input}: `invoke(input, cfg)`, ONLY on a thread with NO
//     existing checkpoint. On a thread that already has one, this begins a
//     BRAND NEW run and re-executes the entire pre-interrupt body (all tasks,
//     a new interrupt id) — the exact accidental-new-run hazard the spike
//     exposed. Checked via graph.getState(config), not via "did this call
//     mint the thread": a thread row can legitimately exist with zero
//     checkpoints (minted, never yet invoked), and that case must still
//     accept input.

import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import { readProfileForDemoGuards } from '../harness/keys'
import type { AdminClient } from '../harness/types'
import { withCheckpointer } from './pg'
import { SpanBuffer, runInTraceContext, withSpan } from '../trace/spans'

/** Matches the `surface` CHECK constraint on public.graph_threads. */
export const GRAPH_SURFACES = ['run', 'copilot', 'refresh', 'autopilot'] as const
export type GraphSurface = (typeof GRAPH_SURFACES)[number]

export class ThreadOwnershipError extends Error {
  readonly threadId: string
  constructor(threadId: string) {
    super(`Thread ${threadId} does not belong to the requesting user.`)
    this.name = 'ThreadOwnershipError'
    this.threadId = threadId
  }
}

export class DemoThreadExpiredError extends Error {
  readonly threadId: string
  constructor(threadId: string) {
    super(`Thread ${threadId} has expired.`)
    this.name = 'DemoThreadExpiredError'
    this.threadId = threadId
  }
}

/**
 * Thrown when `input` is supplied for a thread that already has a
 * checkpoint. Delivering fresh input there would silently start a second,
 * parallel run instead of resuming the first — see the RESUME SEMANTICS note
 * above.
 */
export class ExistingThreadCheckpointError extends Error {
  readonly threadId: string
  constructor(threadId: string) {
    super(
      `Thread ${threadId} already has a checkpoint; refusing fresh input because it would start a NEW run and ` +
        `re-execute the entire pre-interrupt body instead of resuming. Pass no input to continue the in-flight ` +
        `task, or pass { resume } to answer a known interrupt().`
    )
    this.name = 'ExistingThreadCheckpointError'
    this.threadId = threadId
  }
}

/**
 * The per-call override key LangGraph's Pregel runtime reads to pick up a
 * checkpointer at invoke/stream/getState time (`CONFIG_KEY_CHECKPOINTER` in
 * @langchain/langgraph's constants.ts). It is NOT re-exported from the
 * package's public entry point (`@langchain/langgraph`'s index.d.ts has no
 * `CONFIG_KEY_CHECKPOINTER`), so it is pinned here as a literal, verified
 * directly against the pinned 1.4.10 dist:
 *   grep CONFIG_KEY_CHECKPOINTER .../@langchain/langgraph/dist/constants.cjs
 *     -> const CONFIG_KEY_CHECKPOINTER = "__pregel_checkpointer";
 *   .../dist/pregel/index.js:880 reads it off `config.configurable`, NOT off
 *   a top-level `config.checkpointer` — a top-level key is dead: a graph
 *   compiled with `checkpointer: true` throws "checkpointer: true cannot be
 *   used for root graphs" if no per-call override reaches it this way, and
 *   getState() throws "No checkpointer set". Reproduced and re-verified
 *   (see invoke.langgraph.test.ts, which exercises a REAL compiled
 *   StateGraph, not a fake).
 */
const PREGEL_CHECKPOINTER_KEY = '__pregel_checkpointer'

/**
 * The config bag a compiled graph's invoke/stream/getState receive.
 * The checkpointer is threaded through PER CALL under
 * `configurable[PREGEL_CHECKPOINTER_KEY]` (LangGraph's per-invoke
 * checkpointer override — see lib/graph/pg.ts's withCheckpointer), not baked
 * into the compiled graph at module load, because the compiled graph is a
 * module singleton and the checkpointer's Pool is opened and closed once per
 * request. There is deliberately no top-level `checkpointer` field on this
 * type — LangGraph's runtime never reads one (see PREGEL_CHECKPOINTER_KEY).
 */
export interface GraphInvokeConfig {
  configurable: Record<string, unknown>
  /**
   * Standard LangChain RunnableConfig field (@langchain/core/runnables) —
   * LangGraph's Pregel runtime reads it off the top level of the config
   * passed to invoke/stream, not off `configurable`, and surfaces it inside
   * every node as `config.signal`. Optional: most callers don't need
   * external cancellation (a harness run has no client waiting on it to
   * cancel); copilot's Stop button is the one that does — see
   * InvokeGraphForUserArgs.signal below.
   */
  signal?: AbortSignal
}

/**
 * The subset of a compiled LangGraph graph (StateGraph or Functional API
 * `entrypoint`) this file needs. Deliberately NOT the real LangGraph type —
 * this file has zero imports from graph-definition modules (see file header)
 * and this shape is what makes that possible: callers pass their compiled
 * graph in, tests pass a fake in, and neither needs a real @langchain/langgraph
 * compiled-graph instance to do it.
 */
export interface CompiledGraphLike {
  invoke: (input: unknown, config: GraphInvokeConfig) => Promise<unknown>
  stream?: (input: unknown, config: GraphInvokeConfig) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  /**
   * Used ONLY to answer "does this thread already have a checkpoint?" (see
   * ExistingThreadCheckpointError). A snapshot with a populated
   * `config.configurable.checkpoint_id` means yes.
   */
  getState: (config: GraphInvokeConfig) => Promise<GraphStateSnapshotLike | undefined> | GraphStateSnapshotLike | undefined
}

export interface GraphStateSnapshotLike {
  config?: { configurable?: Record<string, unknown> }
  /**
   * Optional, widened fields beyond the bare "does a checkpoint exist" check
   * threadHasCheckpoint uses: current channel values, the node names queued
   * to run next (empty exactly when the thread has fully completed — see
   * getGraphStateForUser below), and any pending task interrupt. Optional so
   * existing narrow fakes (invoke.test.ts) that only ever return `config`
   * keep typechecking unchanged.
   */
  values?: Record<string, unknown>
  next?: readonly string[]
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }>
}

interface GraphThreadRow {
  thread_id: string
  user_id: string
  surface: GraphSurface
  expires_at: string | null
  run_id: string | null
  conversation_id: string | null
}

const GRAPH_THREAD_COLUMNS = 'thread_id, user_id, surface, expires_at, run_id, conversation_id'

export interface InvokeGraphForUserArgs {
  admin: AdminClient
  userId: string
  surface: GraphSurface
  /** The already-compiled graph to run. Never imported by this file — see header. */
  graph: CompiledGraphLike
  /** Omit to mint a fresh thread. */
  threadId?: string
  /** Fresh input — see RESUME SEMANTICS. Ignored when `resume` is set. */
  input?: unknown
  /** Answers a known interrupt() — see RESUME SEMANTICS. Takes priority over `input`. */
  resume?: unknown
  /** Called with each chunk when the graph is driven via `.stream()` instead of `.invoke()`. */
  streamHandler?: (chunk: unknown) => void
  /**
   * External cancellation (e.g. copilot's Stop button aborting the HTTP
   * request) — threaded onto the top-level config, not `configurable` (see
   * GraphInvokeConfig.signal), so every node sees it as `config.signal`.
   * Distinct from LangGraph's own internal per-node signal: without this,
   * an aborted request.signal has no way to reach an in-flight callLlm/
   * dispatchTool call inside a node.
   */
  signal?: AbortSignal
  /**
   * Additional per-invocation values a caller needs threaded into
   * config.configurable, beyond the {userId, runId, threadId} this file
   * always injects — e.g. jobs/refresh's RLS-scoped DB client (spec binding
   * ruling 9: "the route's RLS client rides graph config; no silent
   * admin-client downgrade"). Safe for values a checkpoint could never hold
   * (a live DB client, ...) precisely because configurable is supplied
   * FRESH on every call, never persisted (see this file's header) — a graph
   * module reads it back via `getConfig().configurable` (or, inside a
   * Functional API task, via the same ambient config LangGraph threads into
   * nested task calls), never through a task's own input/output, which ARE
   * checkpointed. Reserved keys (thread_id, threadId, userId, runId, the
   * checkpointer key) always win on collision — see the merge order below.
   */
  extraConfigurable?: Record<string, unknown>
}

export interface InvokeGraphForUserResult {
  threadId: string
  result: unknown
}

/**
 * Determine whether a demo profile's deadline should be stamped onto a
 * freshly minted thread. Reads profile metadata ONLY — never touches API
 * keys, so this is not a fourth entry in GUARDED_KEY_SOURCES (see
 * lib/harness/keys.ts's header on why that list is pinned at three).
 */
async function demoExpiryForFreshThread(admin: AdminClient, userId: string): Promise<string | null> {
  const { row } = await readProfileForDemoGuards(admin, userId)
  if (!row || row.demoColumnsAbsent) return null
  if (!row.is_demo) return null
  return row.demo_expires_at ?? null
}

async function insertThread(admin: AdminClient, userId: string, surface: GraphSurface): Promise<GraphThreadRow> {
  const expiresAt = await demoExpiryForFreshThread(admin, userId)
  const { data, error } = await admin
    .from('graph_threads')
    .insert({ user_id: userId, surface, expires_at: expiresAt })
    .select(GRAPH_THREAD_COLUMNS)
    .single()
  if (error || !data) {
    throw new Error(`graph_threads insert failed: ${error?.message ?? 'no row returned'}`)
  }
  return data as GraphThreadRow
}

async function loadOwnedThread(admin: AdminClient, threadId: string, userId: string): Promise<GraphThreadRow> {
  const { data, error } = await admin.from('graph_threads').select(GRAPH_THREAD_COLUMNS).eq('thread_id', threadId).maybeSingle()
  if (error) {
    throw new Error(`graph_threads lookup failed: ${error.message}`)
  }
  const row = data as GraphThreadRow | null
  // A missing row and a row owned by someone else both fail the SAME way —
  // deliberately: telling an attacker "no such thread" vs. "not yours" for a
  // bare capability like a thread_id is a distinction with no honest use.
  if (!row || row.user_id !== userId) {
    throw new ThreadOwnershipError(threadId)
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new DemoThreadExpiredError(threadId)
  }
  return row
}

async function touchLastInvoked(admin: AdminClient, threadId: string): Promise<void> {
  const { error } = await admin.from('graph_threads').update({ last_invoked_at: new Date().toISOString() }).eq('thread_id', threadId)
  if (error) {
    console.error(`[graph] invoke: failed to stamp last_invoked_at for thread ${threadId}: ${error.message}`)
  }
}

async function threadHasCheckpoint(graph: CompiledGraphLike, config: GraphInvokeConfig): Promise<boolean> {
  const snapshot = await graph.getState(config)
  const checkpointId = snapshot?.config?.configurable?.checkpoint_id
  return typeof checkpointId === 'string' && checkpointId.length > 0
}

export interface GraphStateForUser {
  threadId: string
  /** Current checkpointed channel values (this repo's copilot graph state shape, read loosely here since this file has zero imports from graph-definition modules — see header). */
  values: Record<string, unknown>
  /**
   * Node names queued to run next. Empty means the thread has fully reached
   * END with no pending task (verified against a real MemorySaver — a
   * completed thread's snapshot.next is `[]`); non-empty with no
   * pendingInterrupt below means a task is mid-flight (killed before it
   * finished, e.g. a Stop/abort) rather than parked at interrupt().
   */
  next: readonly string[]
  /**
   * The value passed to the single interrupt() call parked on this thread's
   * next pending task, or null when nothing is parked (idle/completed, or a
   * killed-mid-task thread with no interrupt at all). Every graph in this
   * codebase raises at most one interrupt per node, so "the last task's last
   * interrupt" is unambiguous.
   */
  pendingInterrupt: unknown | null
}

/**
 * Read-only companion to invokeGraphForUser (spec binding ruling 7's "one
 * door" is about graph.invoke/stream — see graph-chokepoints.test.ts part
 * (b) — not about graph.getState, exactly like pg.ts's countThreadCheckpoints
 * is already a second, narrower reader alongside it). A caller needs this
 * BEFORE deciding what to invoke with: copilot's route has to know whether a
 * thread is idle-between-turns, parked at a tool-confirmation/ask, or
 * mid-task-killed, to build the right resume payload — invoke()/stream()
 * themselves only reveal that AFTER you've already committed to a call.
 * Ownership- and expiry-checked exactly like invokeGraphForUser (same
 * loadOwnedThread), never exposed to a route without going through this.
 */
export async function getGraphStateForUser(
  admin: AdminClient,
  userId: string,
  threadId: string,
  graph: CompiledGraphLike
): Promise<GraphStateForUser> {
  const thread = await loadOwnedThread(admin, threadId, userId)
  return withCheckpointer(async (saver) => {
    const config: GraphInvokeConfig = {
      configurable: { thread_id: thread.thread_id, [PREGEL_CHECKPOINTER_KEY]: saver },
    }
    const snapshot = await graph.getState(config)
    const tasks = snapshot?.tasks ?? []
    const lastTask = tasks[tasks.length - 1]
    const lastInterrupt = lastTask?.interrupts?.[lastTask.interrupts.length - 1]
    return {
      threadId: thread.thread_id,
      values: snapshot?.values ?? {},
      next: snapshot?.next ?? [],
      pendingInterrupt: lastInterrupt ? (lastInterrupt.value ?? null) : null,
    }
  })
}

export async function invokeGraphForUser(args: InvokeGraphForUserArgs): Promise<InvokeGraphForUserResult> {
  const { admin, userId, surface, graph, threadId: incomingThreadId, input, resume, streamHandler, extraConfigurable, signal } = args

  if (!GRAPH_SURFACES.includes(surface)) {
    throw new Error(`invokeGraphForUser: unknown surface "${surface}" — must be one of ${GRAPH_SURFACES.join(', ')}`)
  }

  const thread = incomingThreadId ? await loadOwnedThread(admin, incomingThreadId, userId) : await insertThread(admin, userId, surface)
  const threadId = thread.thread_id

  // Stamped before the invoke attempt (not only on success) so a thread that
  // was resumed and then hung or errored still reads as recently touched
  // rather than abandoned.
  await touchLastInvoked(admin, threadId)

  const baseConfigurable: Record<string, unknown> = {
    thread_id: threadId, // the key LangGraph's checkpointer itself reads
    threadId, // Cello-native alias — nodes/tools read this, not thread_id
    userId,
    runId: randomUUID(), // per-invocation id, distinct from any domain agent_runs.id
  }

  // Every call the compiled graph makes — getState (to decide the resume
  // rule) AND invoke/stream — needs the live checkpointer, and the
  // checkpointer only exists inside withCheckpointer's callback (its Pool is
  // opened there, see lib/graph/pg.ts). So the whole decision + call happens
  // inside this one callback, sharing one config.
  //
  // TRACING: this file is the outermost entry for every graphed surface
  // (spec Step 2), so it creates the invocation's SpanBuffer and the root
  // 'graph' span everything else (runAgentUnit's 'node' spans, callLlm's
  // 'llm' spans) nests under via runInTraceContext — see lib/trace/spans.ts's
  // header. `runId: null` on the root span itself: a graph invocation may
  // have no domain agent_runs row at all (copilot/refresh/autopilot never
  // mint one) — a unit nested inside a harness run supplies its OWN real
  // run id to its own span, this file never guesses one. Flushed in
  // `finally` so a thrown error (thread refusal, a killed invocation) still
  // best-effort-flushes whatever was buffered before the throw — see
  // SpanBuffer.flush's own doc for why that loss is bounded and acceptable.
  const spanBuffer = new SpanBuffer(userId, threadId)
  let result: unknown
  try {
    result = await withSpan(
      spanBuffer,
      { parentSpanId: null, runId: null, kind: 'graph', name: surface },
      (rootSpanId) =>
        runInTraceContext({ buffer: spanBuffer, parentSpanId: rootSpanId, runId: null }, () =>
          withCheckpointer(async (saver) => {
            // extraConfigurable first, baseConfigurable second: a caller-supplied
            // key can never shadow thread_id/threadId/userId/runId, and neither can
            // ever shadow the checkpointer override that always goes last.
            const invokeConfig: GraphInvokeConfig = {
              configurable: { ...(extraConfigurable ?? {}), ...baseConfigurable, [PREGEL_CHECKPOINTER_KEY]: saver },
              ...(signal ? { signal } : {}),
            }

            let graphInput: unknown
            if (resume !== undefined) {
              graphInput = new Command({ resume })
            } else if (input !== undefined) {
              if (await threadHasCheckpoint(graph, invokeConfig)) {
                throw new ExistingThreadCheckpointError(threadId)
              }
              graphInput = input
            } else {
              graphInput = null
            }

            if (streamHandler) {
              if (!graph.stream) {
                throw new Error(
                  `invokeGraphForUser: a streamHandler was passed but the graph for surface "${surface}" has no stream()`
                )
              }
              let last: unknown
              for await (const chunk of await graph.stream(graphInput, invokeConfig)) {
                streamHandler(chunk)
                last = chunk
              }
              return last
            }
            return graph.invoke(graphInput, invokeConfig)
          })
        ),
      (_res, err) =>
        err ? { surface, threadId, error: err instanceof Error ? err.message : String(err) } : { surface, threadId }
    )
  } finally {
    await spanBuffer.flush(admin)
  }

  return { threadId, result }
}
