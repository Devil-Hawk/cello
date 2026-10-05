// Tests for lib/trace/spans.ts — the trace_spans emission primitives (Step 2
// of the langgraph port). ZERO network: `admin` is a tiny hand-rolled fake
// capturing whatever a flush() inserts, same style as lib/graph/invoke.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'
import {
  SPAN_ATTRIBUTE_VALUE_CAP_BYTES,
  SpanBuffer,
  acquireSpanScope,
  capAttributes,
  currentTraceContext,
  errorCode,
  observe,
  runInTraceContext,
  setTraceInput,
  setTraceOutput,
  withSpan,
  withTrace,
} from './spans'

// Real env gates (langfuseConfigured, traceSampled, contentCaptureFor); only the
// replay itself is a spy.
const exportTraceMock = vi.fn(async (_buffer: unknown, _rows: unknown[]) => undefined)
vi.mock('../observability/langfuse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability/langfuse')>()
  return { ...actual, exportTrace: (buffer: unknown, rows: unknown[]) => exportTraceMock(buffer, rows) }
})

function configureLangfuse() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

function makeCapturingAdmin() {
  const insertCalls: Record<string, unknown>[][] = []
  const admin = {
    from: (name: string) => {
      if (name !== 'trace_spans') throw new Error(`unexpected table "${name}"`)
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          insertCalls.push(rows)
          return { error: null }
        },
      }
    },
  } as unknown as AdminClient
  return { admin, insertCalls }
}

beforeEach(() => {
  exportTraceMock.mockReset()
  exportTraceMock.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SpanBuffer.flush — batched single-insert', () => {
  it('N recorded spans flush as exactly ONE insert call carrying all N rows', async () => {
    const buffer = new SpanBuffer('user-1', 'thread-1')
    for (let i = 0; i < 4; i += 1) {
      buffer.record({
        span_id: `span-${i}`,
        parent_span_id: null,
        run_id: null,
        kind: 'llm',
        name: `call-${i}`,
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        status: 'ok',
        attributes: null,
        events: null,
      })
    }
    expect(buffer.size).toBe(4)

    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)

    expect(insertCalls).toHaveLength(1) // one insert call...
    expect(insertCalls[0]).toHaveLength(4) // ...carrying all four rows
    expect(buffer.size).toBe(0) // drained, so a second flush is a no-op
  })

  it('an empty buffer never touches the admin client at all', async () => {
    const buffer = new SpanBuffer('user-1')
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls).toHaveLength(0)
  })

  it('a flush that fails (bad connection, unhandled table) is swallowed, never thrown', async () => {
    const buffer = new SpanBuffer('user-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'graph',
      name: 'run',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: null,
      events: null,
    })
    const throwingAdmin = { from: () => { throw new Error('no such table') } } as unknown as AdminClient
    await expect(buffer.flush(throwingAdmin)).resolves.toBeUndefined()
  })

  it('every row carries the buffer\'s own trace_id/user_id/thread_id, stamped by record()', async () => {
    const buffer = new SpanBuffer('user-1', 'thread-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: 'run-1',
      kind: 'node',
      name: 'sourcer',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: null,
      events: null,
    })
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls[0][0]).toMatchObject({ trace_id: buffer.traceId, user_id: 'user-1', thread_id: 'thread-1', run_id: 'run-1' })
  })

  it('hands every flushed record to the Langfuse export, awaited', async () => {
    const buffer = new SpanBuffer('user-1', 'thread-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'llm',
      name: 'llm',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: { model: 'm' },
      events: null,
    })
    const { admin } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(exportTraceMock).toHaveBeenCalledTimes(1)
    expect(exportTraceMock.mock.calls[0][0]).toBe(buffer)
    expect(exportTraceMock.mock.calls[0][1]).toHaveLength(1)
  })

  it('prompt and completion text reach the export but NEVER the Postgres insert', async () => {
    const buffer = new SpanBuffer('user-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'llm',
      name: 'llm',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: { model: 'm' },
      events: null,
      lf: { input: [{ role: 'user', content: 'MY-SECRET-PROMPT' }], output: { role: 'assistant', content: 'MY-SECRET-COMPLETION' } },
    })
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)

    expect(JSON.stringify(insertCalls)).not.toContain('MY-SECRET')
    expect(insertCalls[0][0]).not.toHaveProperty('lf')
    expect(insertCalls[0][0]).not.toHaveProperty('persist')
    const exported = exportTraceMock.mock.calls[0][1] as { lf?: { output?: { content?: string } } }[]
    expect(exported[0].lf?.output?.content).toBe('MY-SECRET-COMPLETION')
  })

  it('a withSpan lfOf payload is built only when exporting, and its text never lands in the insert', async () => {
    configureLangfuse()
    const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false })
    await withSpan(
      buffer,
      { parentSpanId: null, runId: null, kind: 'llm', name: 'llm' },
      async () => 'reply',
      () => ({ model: 'm' }),
      (_r, _e, capture) => ({ name: 'call-llm', ...(capture ? { input: 'PLANTED-PROMPT' } : {}) })
    )
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(JSON.stringify(insertCalls)).not.toContain('PLANTED')
    expect((exportTraceMock.mock.calls[0][1] as { lf?: { input?: string } }[])[0].lf?.input).toBe('PLANTED-PROMPT')
  })

  it('an error span always carries a content-free errorCode; the raw message only with capture on', async () => {
    configureLangfuse()
    const run = async (buffer: SpanBuffer) => {
      await expect(
        withSpan(buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'llm' }, async () => {
          throw Object.assign(new Error('secret message'), { status: 429 })
        })
      ).rejects.toThrow('secret message')
      return (buffer as unknown as { pending: { lf?: { errorCode?: string; errorMessage?: string } }[] }).pending[0].lf
    }
    expect(await run(new SpanBuffer('u', null, undefined, { isDemo: false }))).toEqual({ errorCode: 'http_429', errorMessage: 'secret message' })
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
    expect(await run(new SpanBuffer('u', null, undefined, { isDemo: true }))).toEqual({ errorCode: 'http_429', errorMessage: undefined })
  })

  it('errorCode never returns message text', () => {
    expect(errorCode(Object.assign(new Error('x'), { status: 503 }))).toBe('http_503')
    expect(errorCode(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT')
    expect(errorCode(new TypeError('with secret sk-abc'))).toBe('TypeError')
    expect(errorCode(Object.assign(new Error('x'), { name: 'weird name with spaces' }))).toBe('error')
    expect(errorCode('a string')).toBe('error')
    expect(errorCode(null)).toBe('error')
  })

  it('a throwing lfOf never fails the request or loses the span', async () => {
    configureLangfuse()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    const out = await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'llm' }, async () => 'ok', undefined, () => {
      throw new Error('bad payload')
    })
    expect(out).toBe('ok')
    expect(buffer.size).toBe(1)
  })

  it('Langfuse-only records (persist:false) are exported but never inserted', async () => {
    configureLangfuse()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'embedding', persist: false }, async () => 'ok', undefined, () => ({ type: 'embedding' }))
    await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'llm' }, async () => 'ok')
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(exportTraceMock.mock.calls[0][1]).toHaveLength(2)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toHaveLength(1)
    expect(insertCalls[0][0]).toMatchObject({ name: 'llm' })
  })

  it('a buffer holding only Langfuse-only records makes no insert call at all', async () => {
    configureLangfuse()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'embedding', persist: false }, async () => 'ok')
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls).toHaveLength(0)
    expect(exportTraceMock).toHaveBeenCalledTimes(1)
  })

  it('a record that arrives after flush is reported once, and still exported by the next flush', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const buffer = new SpanBuffer('u')
    const r: Parameters<SpanBuffer['record']>[0] = {
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'llm',
      name: 'llm',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: { model: 'm' },
      events: null,
    }
    buffer.record(r)
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    buffer.record({ ...r, span_id: 's2' })
    buffer.record({ ...r, span_id: 's3' })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('recorded after flush'))).toHaveLength(1)
    await buffer.flush(admin)
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[1]).toHaveLength(2)
  })

  it('a rejecting export cannot fail the flush: the insert still lands', async () => {
    exportTraceMock.mockRejectedValue(new Error('langfuse ingestion is down'))
    const buffer = new SpanBuffer('user-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'llm',
      name: 'llm',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: { model: 'm' },
      events: null,
    })
    const { admin, insertCalls } = makeCapturingAdmin()
    await expect(buffer.flush(admin)).resolves.toBeUndefined()
    expect(insertCalls).toHaveLength(1)
  })

  it('flush waits for the export (so an awaited delivery path is not cut short)', async () => {
    let finished = false
    exportTraceMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      finished = true
    })
    const buffer = new SpanBuffer('user-1')
    buffer.record({
      span_id: 's1',
      parent_span_id: null,
      run_id: null,
      kind: 'llm',
      name: 'llm',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ok',
      attributes: { model: 'm' },
      events: null,
    })
    const { admin } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(finished).toBe(true)
  })

  it('isDemo can be filled in later and only ever tightens toward demo', () => {
    const buffer = new SpanBuffer('u')
    buffer.adoptDemoFlag(false)
    expect(buffer.meta.isDemo).toBe(false)
    buffer.adoptDemoFlag(true)
    expect(buffer.meta.isDemo).toBe(true)
    buffer.adoptDemoFlag(false)
    expect(buffer.meta.isDemo).toBe(true)
  })
})

describe('capAttributes — the ~8KB per-value cap', () => {
  it('undefined attributes become null (nothing to insert)', () => {
    expect(capAttributes(undefined)).toBeNull()
  })

  it('short strings, numbers and booleans pass through unchanged', () => {
    expect(capAttributes({ model: 'x', tokens: 42, metered: true })).toEqual({ model: 'x', tokens: 42, metered: true })
  })

  it('a string over the byte cap is truncated with a marker; a string at the cap is untouched', () => {
    const atCap = 'a'.repeat(SPAN_ATTRIBUTE_VALUE_CAP_BYTES)
    const overCap = 'a'.repeat(SPAN_ATTRIBUTE_VALUE_CAP_BYTES + 1)
    const capped = capAttributes({ atCap, overCap }) as Record<string, string>
    expect(capped.atCap).toBe(atCap) // exactly at the cap: untouched
    expect(capped.overCap).not.toBe(overCap) // one byte over: truncated
    expect(capped.overCap.endsWith('…[truncated]')).toBe(true)
    expect(capped.overCap.startsWith('a'.repeat(100))).toBe(true) // real content survives, only the tail is cut
  })
})

describe('withSpan — records on success and on failure, always rethrows', () => {
  it('success: records status "ok" using attributesOf(result, undefined)', async () => {
    const buffer = new SpanBuffer('user-1')
    const result = await withSpan(
      buffer,
      { parentSpanId: null, runId: 'run-1', kind: 'node', name: 'sourcer' },
      async () => ({ tokensUsed: 7 }),
      (r) => ({ tokensUsed: r?.tokensUsed })
    )
    expect(result).toEqual({ tokensUsed: 7 })
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls[0][0]).toMatchObject({ status: 'ok', kind: 'node', name: 'sourcer', run_id: 'run-1', attributes: { tokensUsed: 7 } })
  })

  it('failure: records status "error" using attributesOf(undefined, err) and rethrows the SAME error', async () => {
    const buffer = new SpanBuffer('user-1')
    const boom = new Error('agent exploded')
    await expect(
      withSpan(
        buffer,
        { parentSpanId: null, runId: null, kind: 'node', name: 'sourcer' },
        async () => {
          throw boom
        },
        (_r, err) => ({ error: err instanceof Error ? err.message : String(err) })
      )
    ).rejects.toBe(boom)

    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls[0][0]).toMatchObject({ status: 'error', attributes: { error: 'agent exploded' } })
  })
})

describe('acquireSpanScope + runInTraceContext — span parentage (graph -> node -> llm)', () => {
  beforeEach(() => {
    expect(currentTraceContext()).toBeUndefined() // AsyncLocalStorage doesn't leak between tests
  })

  it('with no ambient context, a fresh buffer is created and owns:true', () => {
    const scope = acquireSpanScope('user-1')
    expect(scope.owns).toBe(true)
    expect(scope.parentSpanId).toBeNull()
    expect(scope.runId).toBeNull()
  })

  it('nested contexts chain parent ids exactly like invoke.ts -> unit.ts -> callLlm', async () => {
    const buffer = new SpanBuffer('user-1', 'thread-1')

    // invoke.ts: root 'graph' span, establishes the ambient context every
    // unit/callLlm call below joins via acquireSpanScope.
    await withSpan(
      buffer,
      { parentSpanId: null, runId: null, kind: 'graph', name: 'run' },
      (graphSpanId) =>
        runInTraceContext({ buffer, parentSpanId: graphSpanId, runId: null }, async () => {
          // unit.ts: joins the ambient buffer (owns:false), nests its own
          // 'node' span under the graph root, then establishes ITS OWN
          // context (its own domain runId) for anything nested inside it.
          const unitScope = acquireSpanScope('user-1')
          expect(unitScope.owns).toBe(false)
          expect(unitScope.parentSpanId).toBe(graphSpanId)

          await withSpan(
            unitScope.buffer,
            { parentSpanId: unitScope.parentSpanId, runId: 'run-domain-1', kind: 'node', name: 'sourcer' },
            (nodeSpanId) =>
              runInTraceContext({ buffer, parentSpanId: nodeSpanId, runId: 'run-domain-1' }, async () => {
                // llm.ts: joins the SAME buffer again, nests under the node span.
                const llmScope = acquireSpanScope('user-1')
                expect(llmScope.owns).toBe(false)
                expect(llmScope.parentSpanId).toBe(nodeSpanId)
                expect(llmScope.runId).toBe('run-domain-1')

                await withSpan(llmScope.buffer, { parentSpanId: llmScope.parentSpanId, runId: llmScope.runId, kind: 'llm', name: 'llm' }, async () => 'ok')
              }),
            () => undefined
          )
        }),
      () => undefined
    )

    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls).toHaveLength(1) // one buffer, one batched flush for the whole invocation
    const rows = insertCalls[0]
    expect(rows).toHaveLength(3)

    const graphSpan = rows.find((r) => r.kind === 'graph')!
    const nodeSpan = rows.find((r) => r.kind === 'node')!
    const llmSpan = rows.find((r) => r.kind === 'llm')!
    expect(graphSpan.parent_span_id).toBeNull()
    expect(nodeSpan.parent_span_id).toBe(graphSpan.span_id)
    expect(llmSpan.parent_span_id).toBe(nodeSpan.span_id)
    expect(llmSpan.run_id).toBe('run-domain-1')
    expect(graphSpan.run_id).toBeNull() // invoke.ts never guesses a domain run id — see spans.ts's header
  })
})

describe('SpanBuffer.flush: Langfuse-only parents', () => {
  it('a persisted row whose parent is Langfuse-only re-parents to its nearest persisted ancestor, so the foreign key holds', async () => {
    configureLangfuse()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    const at = new Date().toISOString()
    const base = { run_id: null, start_time: at, end_time: at, status: 'ok' as const, attributes: null, events: null }
    buffer.record({ ...base, span_id: 'root', parent_span_id: null, kind: 'graph', name: 'run' })
    buffer.record({ ...base, span_id: 'lf-only', parent_span_id: 'root', kind: 'http', name: 'x', persist: false })
    buffer.record({ ...base, span_id: 'lf-only-2', parent_span_id: 'lf-only', kind: 'http', name: 'y', persist: false })
    buffer.record({ ...base, span_id: 'child', parent_span_id: 'lf-only-2', kind: 'llm', name: 'llm' })
    buffer.record({ ...base, span_id: 'orphan', parent_span_id: 'lf-only', kind: 'llm', name: 'llm' })
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    const rows = insertCalls[0] as { span_id: string; parent_span_id: string | null }[]
    expect(rows.map((r) => r.span_id).sort()).toEqual(['child', 'orphan', 'root'])
    expect(rows.find((r) => r.span_id === 'child')?.parent_span_id).toBe('root')
    expect(rows.find((r) => r.span_id === 'orphan')?.parent_span_id).toBe('root')
    // the Langfuse replay still sees the original tree
    const exported = exportTraceMock.mock.calls[0][1] as { span_id: string; parent_span_id: string | null }[]
    expect(exported.find((r) => r.span_id === 'child')?.parent_span_id).toBe('lf-only-2')
  })
})

describe('withTrace and observe', () => {
  const profileAdmin = (profile: Record<string, unknown> | null) => {
    const inserts: Record<string, unknown>[][] = []
    const admin = {
      from: (name: string) => {
        if (name === 'profiles') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }
        }
        return { insert: async (rows: Record<string, unknown>[]) => (inserts.push(rows), { error: null }) }
      },
    } as unknown as AdminClient
    return { admin, inserts }
  }
  const rowsOf = () => exportTraceMock.mock.calls[0][1] as { name: string; kind: string; parent_span_id: string | null; span_id: string; persist?: false; lf?: { name?: string; type?: string; input?: unknown; output?: unknown } }[]

  it('makes a Langfuse-only root that the model calls inside nest under, and flushes once', async () => {
    configureLangfuse()
    const { admin, inserts } = profileAdmin({ id: 'u', is_demo: false })
    const out = await withTrace(admin, 'u', { name: 'draft-outreach' }, async () => {
      setTraceInput({ contactId: 'c1' })
      await withSpan(
        currentTraceContext()!.buffer,
        { parentSpanId: currentTraceContext()!.parentSpanId, runId: null, kind: 'llm', name: 'llm' },
        async () => 'reply'
      )
      setTraceOutput({ ok: true })
      return 'done'
    })
    expect(out).toBe('done')
    expect(exportTraceMock).toHaveBeenCalledTimes(1)
    const [root, child] = [rowsOf().find((r) => r.name === 'draft-outreach')!, rowsOf().find((r) => r.name === 'llm')!]
    expect(root.persist).toBe(false)
    expect(root.lf).toMatchObject({ name: 'draft-outreach', type: 'span', input: { contactId: 'c1' }, output: { ok: true } })
    expect(child.parent_span_id).toBe(root.span_id)
    // no trace_spans row for the root: only the llm row, re-parented to nothing
    expect(inserts[0]).toHaveLength(1)
    expect(inserts[0][0]).toMatchObject({ name: 'llm', parent_span_id: null })
    expect((exportTraceMock.mock.calls[0][0] as SpanBuffer).meta).toMatchObject({ name: 'draft-outreach', isDemo: false })
  })

  it('reads the profile for the demo flag: a demo profile means no content, an owner means content', async () => {
    configureLangfuse()
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
    await withTrace(profileAdmin({ id: 'u', is_demo: true }).admin, 'u', { name: 'a-trace', input: { x: 1 } }, async () => {
      await observe({ name: 'inner', type: 'span' }, async () => 1)
    })
    expect(rowsOf().find((r) => r.name === 'a-trace')?.lf?.input).toBeUndefined()
    exportTraceMock.mockClear()
    await withTrace(profileAdmin({ id: 'u', is_demo: false }).admin, 'u', { name: 'a-trace', input: { x: 1 } }, async () => {
      await observe({ name: 'inner', type: 'span' }, async () => 1)
    })
    expect(rowsOf().find((r) => r.name === 'a-trace')?.lf?.input).toEqual({ x: 1 })
  })

  it('a root with nothing under it is not exported, and an unconfigured trace still flushes its rows', async () => {
    configureLangfuse()
    await withTrace(profileAdmin({ id: 'u', is_demo: false }).admin, 'u', { name: 'a-trace' }, async () => 'no model call')
    expect(exportTraceMock).not.toHaveBeenCalled()

    vi.unstubAllEnvs() // Langfuse off: the llm row must still reach trace_spans
    const { admin, inserts } = profileAdmin(null)
    await withTrace(admin, 'u', { name: 'a-trace' }, async () => {
      await withSpan(currentTraceContext()!.buffer, { parentSpanId: null, runId: null, kind: 'llm', name: 'llm' }, async () => 'x')
    })
    expect(inserts[0]).toHaveLength(1)
  })

  it('inside an ambient trace it is a plain child and never flushes the buffer it does not own', async () => {
    configureLangfuse()
    const { admin, inserts } = profileAdmin({ id: 'u', is_demo: false })
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await runInTraceContext({ buffer, parentSpanId: 'outer', runId: null }, () =>
      withTrace(admin, 'u', { name: 'child-trace' }, async () => {
        await observe({ name: 'inner', type: 'tool', kind: 'tool' }, async () => 1)
      })
    )
    expect(inserts).toHaveLength(0)
    expect(exportTraceMock).not.toHaveBeenCalled()
    expect(buffer.size).toBe(2)
  })

  it('observe records a tool span as a persisted row and a retriever as Langfuse-only; outside a trace it only runs fn', async () => {
    configureLangfuse()
    expect(await observe({ name: 'search-kb', type: 'tool' }, async () => 'plain')).toBe('plain')
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await runInTraceContext({ buffer, parentSpanId: 'root', runId: null }, async () => {
      await observe({ name: 'list_jobs', type: 'tool' }, async () => ({ jobs: [] }), (_r, _e, capture) => ({ ...(capture ? { input: { q: 1 } } : {}) }))
      await observe({ name: 'search-memory', type: 'retriever', persist: false }, async () => [])
    })
    const { admin, insertCalls } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(insertCalls[0].map((r) => (r as { name: string; kind: string }).kind)).toEqual(['tool'])
    expect(rowsOf().map((r) => r.lf?.type)).toEqual(['tool', 'retriever'])
    expect(rowsOf()[0].parent_span_id).toBe('root')
  })
})
