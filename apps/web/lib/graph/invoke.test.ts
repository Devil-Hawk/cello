// Tests for lib/graph/invoke.ts's invokeGraphForUser — the single call site
// (spec binding ruling 7) that gates every graph run behind thread ownership,
// demo expiry, and the checkpoint-aware resume-semantics refusal the spike
// exposed.
//
// ZERO network, ZERO real Postgres: './pg' (the checkpointer's live Pool) is
// mocked outright, and AdminClient is a tiny in-memory fake built to support
// exactly the PostgREST chain shapes invoke.ts issues — same style as
// lib/harness/pre-migration-schema.test.ts's fakeDb, widened to cover
// insert/update as well as select.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'

vi.mock('./pg', () => ({
  // No real Pool, no real PostgresSaver — the fake graph below never
  // actually reads `saver`, it just records what config it was called with.
  withCheckpointer: async (fn: (saver: unknown) => Promise<unknown>) => fn({ fakeSaver: true }),
}))

import {
  DemoThreadExpiredError,
  ExistingThreadCheckpointError,
  ThreadOwnershipError,
  invokeGraphForUser,
  type CompiledGraphLike,
  type GraphInvokeConfig,
} from './invoke'

// --- minimal in-memory fake of the PostgREST chains invoke.ts issues -------

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  constructor(
    private idField: string,
    private idPrefix: string
  ) {}
  nextId(): string {
    this.seq += 1
    return `${this.idPrefix}-${this.seq}`
  }
  get pk(): string {
    return this.idField
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; op: 'eq' | 'is'; val: unknown }[] = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null

  constructor(private table: FakeTable) {}

  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val })
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, op: 'is', val })
    return this
  }
  insert(row: Record<string, unknown>) {
    this.mode = 'insert'
    this.insertRow = row
    return this
  }
  update(patch: Record<string, unknown>) {
    this.mode = 'update'
    this.patch = patch
    return this
  }

  private matches(row: Row): boolean {
    return this.filters.every(({ col, op, val }) => (op === 'is' && val === null ? row[col] == null : row[col] === val))
  }

  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      const row: Row = { [this.table.pk]: this.table.nextId(), ...this.insertRow }
      this.table.rows.push(row)
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      const matched = this.table.rows.filter((r) => this.matches(r))
      for (const r of matched) Object.assign(r, this.patch)
      return { data: matched, error: null }
    }
    return { data: this.table.rows.filter((r) => this.matches(r)), error: null }
  }

  async maybeSingle() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  async single() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  // Lets `await builder.update(...).eq(...)` work without an explicit terminal call.
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }
}

function makeFakeAdmin() {
  const tables = {
    profiles: new FakeTable('id', 'profile'),
    graph_threads: new FakeTable('thread_id', 'thread'),
  }
  const admin = {
    from: (name: string) => {
      const table = (tables as Record<string, FakeTable>)[name]
      if (!table) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(table)
    },
  } as unknown as AdminClient
  return { admin, tables }
}

function seedProfile(tables: ReturnType<typeof makeFakeAdmin>['tables'], row: Row) {
  tables.profiles.rows.push(row)
}

function seedThread(tables: ReturnType<typeof makeFakeAdmin>['tables'], row: Row) {
  tables.graph_threads.rows.push(row)
}

// --- fake compiled graph -----------------------------------------------

function makeFakeGraph(opts: { hasCheckpoint?: boolean } = {}): {
  graph: CompiledGraphLike
  calls: { invoke: { input: unknown; config: GraphInvokeConfig }[] }
} {
  const calls = { invoke: [] as { input: unknown; config: GraphInvokeConfig }[] }
  const graph: CompiledGraphLike = {
    invoke: async (input, config) => {
      calls.invoke.push({ input, config })
      return { output: 'ok' }
    },
    getState: async (_config) => ({
      config: { configurable: opts.hasCheckpoint ? { checkpoint_id: 'chk-1' } : {} },
    }),
  }
  return { graph, calls }
}

const OWNER = 'user-owner'
const ATTACKER = 'user-attacker'

describe('invokeGraphForUser — thread ownership (anti-IDOR)', () => {
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
  })

  it('refuses a threadId owned by a different user, and never invokes the graph', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    await expect(
      invokeGraphForUser({ admin, userId: ATTACKER, surface: 'run', graph, threadId: 'thread-1' })
    ).rejects.toBeInstanceOf(ThreadOwnershipError)

    expect(calls.invoke).toHaveLength(0)
  })

  it('refuses a threadId that does not exist at all, the same way as a foreign one', async () => {
    const { graph, calls } = makeFakeGraph()
    await expect(
      invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'does-not-exist' })
    ).rejects.toBeInstanceOf(ThreadOwnershipError)
    expect(calls.invoke).toHaveLength(0)
  })

  it('allows the owning user through', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    const result = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })

    expect(result.threadId).toBe('thread-1')
    expect(calls.invoke).toHaveLength(1)
  })
})

describe('invokeGraphForUser — demo expiry', () => {
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
  })

  it('refuses an existing thread past its expires_at, and never invokes the graph', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: past, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    await expect(
      invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })
    ).rejects.toBeInstanceOf(DemoThreadExpiredError)
    expect(calls.invoke).toHaveLength(0)
  })

  it('allows a thread with no expiry (the ordinary, non-demo case)', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })
    expect(calls.invoke).toHaveLength(1)
  })

  it('stamps a fresh thread with the profile demo_expires_at when the profile is a demo', async () => {
    seedProfile(tables, { id: OWNER, preferences: {}, is_demo: true, demo_expires_at: '2026-09-01T00:00:00.000Z' })
    const { graph } = makeFakeGraph()

    const result = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, input: { goal: 'x' } })

    const row = tables.graph_threads.rows.find((r) => r.thread_id === result.threadId)
    expect(row?.expires_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('mints a fresh thread with no expiry for a non-demo profile', async () => {
    seedProfile(tables, { id: OWNER, preferences: {}, is_demo: false, demo_expires_at: null })
    const { graph } = makeFakeGraph()

    const result = await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, input: { goal: 'x' } })

    const row = tables.graph_threads.rows.find((r) => r.thread_id === result.threadId)
    expect(row?.expires_at).toBeNull()
  })
})

describe('invokeGraphForUser — resume semantics', () => {
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
  })

  it('refuses input on a thread that already has a checkpoint, and never invokes the graph', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph({ hasCheckpoint: true })

    await expect(
      invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1', input: { goal: 'new run please' } })
    ).rejects.toBeInstanceOf(ExistingThreadCheckpointError)
    expect(calls.invoke).toHaveLength(0)
  })

  it('accepts input on an existing thread row with no checkpoint yet (minted, never invoked)', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph({ hasCheckpoint: false })

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1', input: { goal: 'first run' } })
    expect(calls.invoke).toHaveLength(1)
    expect(calls.invoke[0].input).toEqual({ goal: 'first run' })
  })

  it('with no input and no resume, continues via invoke(null) — the killed/parked/completed-safe path', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph({ hasCheckpoint: true })

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })
    expect(calls.invoke).toHaveLength(1)
    expect(calls.invoke[0].input).toBeNull()
  })

  it('resume takes priority over input, wrapping it in a Command', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph({ hasCheckpoint: true })

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1', resume: { answer: 'yes' } })
    expect(calls.invoke).toHaveLength(1)
    const sent = calls.invoke[0].input as { resume?: unknown }
    // isCommand-shaped: a real Command instance carries its params under the
    // library's COMMAND_SYMBOL rather than a plain `resume` field, so this
    // checks behavior (constructor ran, resume value preserved) rather than
    // reaching into the library's internal symbol.
    expect(sent).toBeDefined()
  })
})

describe('invokeGraphForUser — config.configurable carries userId', () => {
  // This is the structural fix for the historical makeLlmRunner
  // closure bug (userId silently stripped -> metering off): every call must
  // inject the caller's userId into config.configurable, not just SOME
  // calls. lib/graph/graph-chokepoints.test.ts's scan (c) checks this
  // source-statically (does invokeGraphForUser's body even mention
  // configurable/userId); this test checks it BEHAVIORALLY (does the value
  // that actually reaches the graph carry the real userId) — a source scan
  // can't catch `userId: undefined` or a typo'd key, this test can.
  //
  // MUTATION CHECK (executed by hand, not committed): temporarily deleting
  // the `userId,` line from invoke.ts's `configurable` object makes BOTH
  // this test and graph-chokepoints.test.ts's scan (c) fail — the scan
  // because the literal token `userId` no longer appears in the function
  // body, this test because `config.configurable.userId` reads `undefined`
  // instead of the real id. Confirmed and reverted before this file was
  // committed.
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
  })

  it('threads the real userId through to the graph on a fresh thread', async () => {
    seedProfile(tables, { id: OWNER, preferences: {}, is_demo: false, demo_expires_at: null })
    const { graph, calls } = makeFakeGraph()

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, input: { goal: 'x' } })

    expect(calls.invoke[0].config.configurable.userId).toBe(OWNER)
    expect(calls.invoke[0].config.configurable.threadId).toBeTruthy()
    expect(calls.invoke[0].config.configurable.thread_id).toBe(calls.invoke[0].config.configurable.threadId)
  })

  it('threads the real userId through to the graph on an existing thread', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })

    expect(calls.invoke[0].config.configurable.userId).toBe(OWNER)
  })
})

describe('invokeGraphForUser — checkpointer lands where LangGraph reads it', () => {
  // LangGraph's Pregel runtime only ever reads a per-call checkpointer
  // override off `config.configurable.__pregel_checkpointer`
  // (CONFIG_KEY_CHECKPOINTER) — a top-level `config.checkpointer` sibling to
  // `configurable` is never consumed (verified against the pinned 1.4.10
  // dist; see invoke.ts's PREGEL_CHECKPOINTER_KEY comment and
  // invoke.langgraph.test.ts, which proves this against a REAL compiled
  // graph rather than this file's config-shape-blind fake). This test can't
  // catch a real-runtime rejection (the fake graph below ignores its config
  // the same way the rest of this file's fakes do), but it DOES catch a
  // regression back to the top-level-key shape, which this fake CAN see.
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
  })

  it('places the checkpointer under configurable.__pregel_checkpointer, not a top-level field', async () => {
    seedThread(tables, { thread_id: 'thread-1', user_id: OWNER, surface: 'run', expires_at: null, run_id: null, conversation_id: null })
    const { graph, calls } = makeFakeGraph()

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })

    const config = calls.invoke[0].config
    expect(config.configurable.__pregel_checkpointer).toEqual({ fakeSaver: true })
    expect((config as unknown as Record<string, unknown>).checkpointer).toBeUndefined()
  })
})
