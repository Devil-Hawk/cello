// Integration-style test for lib/graph/invoke.ts's checkpointer wiring
// against a REAL compiled @langchain/langgraph graph — not the fake in
// invoke.test.ts.
//
// WHY THIS FILE EXISTS SEPARATELY FROM invoke.test.ts
//   invoke.test.ts's makeFakeGraph() ignores whatever config it is called
//   with (its invoke/getState mocks never inspect the argument), so it
//   cannot catch invoke.ts wiring the checkpointer into a config key
//   LangGraph's Pregel runtime never reads — exactly the bug an adversarial
//   review caught here: a top-level `config.checkpointer` field is dead
//   against the real runtime, which only reads a per-call override off
//   `config.configurable.__pregel_checkpointer` (CONFIG_KEY_CHECKPOINTER,
//   verified against the pinned 1.4.10 dist — see invoke.ts's comment on
//   PREGEL_CHECKPOINTER_KEY).
//
//   This file swaps in a REAL StateGraph (compiled with `checkpointer: true`,
//   LangGraph's deferred-to-per-call-binding mode — matching invoke.ts's
//   module-singleton compiled-graph design) and a REAL MemorySaver in place
//   of PostgresSaver. './pg' is still mocked — no network, no Postgres — but
//   the saver itself is @langchain/langgraph's own checkpointer
//   implementation, not a stub that ignores its input. If invoke.ts ever
//   again puts the checkpointer at a config key the runtime doesn't read,
//   these tests throw the SAME real-runtime errors a production request
//   would ("checkpointer: true cannot be used for root graphs.", "No
//   checkpointer set") instead of silently passing the way invoke.test.ts's
//   fake-graph suite does.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph'
import type { AdminClient } from '../harness/types'

// A holder vi.mock's factory can close over safely under vitest's hoisting
// (vi.hoisted runs before the mock factory, so this is initialized by the
// time './pg' is first required).
const checkpointerHolder = vi.hoisted<{ saver: unknown }>(() => ({ saver: null }))

vi.mock('./pg', () => ({
  // No real Pool, no real PostgresSaver, no network — but a REAL
  // @langchain/langgraph MemorySaver, so the checkpointer this hands back
  // actually implements getTuple/put/... the way PostgresSaver does, and
  // will throw the real runtime's errors if invoke.ts wires it in wrong.
  //
  // In production, PostgresSaver instances are created fresh per request but
  // all point at the SAME Postgres tables, so a thread's checkpoint history
  // survives across requests. To match that here, ONE MemorySaver is reused
  // across every withCheckpointer call within a test (reset in beforeEach
  // below) rather than a fresh one per call, which would silently discard
  // checkpoint history between invokeGraphForUser calls and invalidate every
  // assertion in this file about cross-call resume/refusal behavior.
  withCheckpointer: async (fn: (saver: unknown) => Promise<unknown>) => fn(checkpointerHolder.saver),
}))

import { ExistingThreadCheckpointError, invokeGraphForUser, type CompiledGraphLike } from './invoke'

// --- a real, tiny compiled graph -------------------------------------------

const CounterState = Annotation.Root({
  value: Annotation<number>(),
})

function compileCounterGraph(): CompiledGraphLike {
  const graph = new StateGraph(CounterState)
    .addNode('inc', async (state) => ({ value: state.value + 1 }))
    .addEdge(START, 'inc')
    .addEdge('inc', END)
    // `checkpointer: true` defers the actual checkpointer to a per-call
    // override — invoke.ts's module-singleton compiled-graph design.
    .compile({ checkpointer: true })
  // Real compiled-graph methods use LangGraph's own RunnableConfig type,
  // which is structurally wider than (and incompatible in fine detail with)
  // GraphInvokeConfig; the cast is the seam between "real graph" and "what
  // invoke.ts needs", exactly like a route casts its already-compiled graph
  // when passing it in.
  return graph as unknown as CompiledGraphLike
}

// --- minimal in-memory fake of the PostgREST chains invoke.ts issues -------
// (deliberately NOT shared with invoke.test.ts's fuller fake — this file
// only needs graph_threads insert/select/update, and keeping it separate
// keeps this file's real point, the real graph, uncluttered.)

interface Row extends Record<string, unknown> {}

function makeFakeAdmin() {
  const rows: Row[] = []
  let seq = 0
  const query = {
    _mode: 'select' as 'select' | 'insert' | 'update',
    _filters: [] as { col: string; val: unknown }[],
    _patch: null as Record<string, unknown> | null,
    _insertRow: null as Record<string, unknown> | null,
  }
  const admin = {
    from: (name: string) => {
      if (name === 'profiles') {
        // readProfileForDemoGuards (via invoke.ts's demoExpiryForFreshThread)
        // looks this up on every fresh-thread mint. No profile row -> not a
        // demo -> no expiry stamped, which is all these tests need.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }
      }
      if (name !== 'graph_threads') throw new Error(`fake admin: unhandled table "${name}"`)
      const filters: { col: string; val: unknown }[] = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      let patch: Record<string, unknown> | null = null
      let insertRow: Record<string, unknown> | null = null

      const exec = () => {
        if (mode === 'insert') {
          seq += 1
          const row: Row = { thread_id: `thread-${seq}`, ...insertRow }
          rows.push(row)
          return { data: row, error: null }
        }
        const matched = rows.filter((r) => filters.every(({ col, val }) => r[col] === val))
        if (mode === 'update') {
          for (const r of matched) Object.assign(r, patch)
          return { data: matched, error: null }
        }
        return { data: matched, error: null }
      }

      const builder = {
        select: (_cols?: string) => builder,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val })
          return builder
        },
        insert: (row: Record<string, unknown>) => {
          mode = 'insert'
          insertRow = row
          return builder
        },
        update: (p: Record<string, unknown>) => {
          mode = 'update'
          patch = p
          return builder
        },
        maybeSingle: async () => {
          const { data, error } = exec()
          const r = (Array.isArray(data) ? data[0] : data) ?? null
          return { data: r, error }
        },
        single: async () => {
          const { data, error } = exec()
          const r = (Array.isArray(data) ? data[0] : data) ?? null
          return { data: r, error }
        },
        then: (onfulfilled?: (v: unknown) => unknown, onrejected?: (r: unknown) => unknown) =>
          Promise.resolve(exec()).then(onfulfilled, onrejected),
      }
      return builder
    },
  } as unknown as AdminClient
  return { admin, rows }
}

const OWNER = 'user-owner'

describe('invokeGraphForUser — checkpointer wiring against a real compiled graph', () => {
  let admin: AdminClient

  beforeEach(() => {
    ;({ admin } = makeFakeAdmin())
    checkpointerHolder.saver = new MemorySaver()
  })

  it('runs a fresh invoke without the runtime throwing "checkpointer: true cannot be used for root graphs"', async () => {
    const graph = compileCounterGraph()

    const { threadId, result } = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'run',
      graph,
      input: { value: 0 },
    })

    expect(threadId).toBeTruthy()
    expect(result).toEqual({ value: 1 })
  })

  it('continues (invoke(null)) on an existing thread without the runtime throwing "No checkpointer set"', async () => {
    const graph = compileCounterGraph()

    const first = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, input: { value: 0 } })

    // No input, no resume -> invoke(null, cfg) against the SAME thread. If
    // the checkpointer were wired to a key the runtime doesn't read, this
    // throws "No checkpointer set" (no-checkpointer case) or silently loses
    // state (misrouted-checkpointer case) instead of returning the cached
    // completed result.
    const second = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: first.threadId })

    expect(second.threadId).toBe(first.threadId)
    expect(second.result).toEqual({ value: 1 })
  })

  it('refuses fresh input on a thread that already carries a REAL checkpoint (getState sees it correctly)', async () => {
    const graph = compileCounterGraph()

    const first = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, input: { value: 0 } })

    // getState() on the misrouted-checkpointer bug either throws ("No
    // checkpointer set") or returns an empty snapshot (no checkpointer means
    // no checkpoint was ever written) — either way it can never correctly
    // detect the existing checkpoint here, so this refusal could not fire.
    await expect(
      invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: first.threadId, input: { value: 99 } })
    ).rejects.toBeInstanceOf(ExistingThreadCheckpointError)
  })
})
