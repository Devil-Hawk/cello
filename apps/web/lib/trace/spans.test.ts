// Tests for lib/trace/spans.ts — the trace_spans emission primitives (Step 2
// of the langgraph port). ZERO network: `admin` is a tiny hand-rolled fake
// capturing whatever a flush() inserts, same style as lib/graph/invoke.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'
import {
  SPAN_ATTRIBUTE_VALUE_CAP_BYTES,
  SpanBuffer,
  acquireSpanScope,
  capAttributes,
  currentTraceContext,
  runInTraceContext,
  withSpan,
} from './spans'

const mirrorSpansToLangfuseMock = vi.fn(async (_rows: unknown[]) => undefined)
vi.mock('../observability/langfuse', () => ({
  mirrorSpansToLangfuse: (rows: unknown[]) => mirrorSpansToLangfuseMock(rows),
}))

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
  mirrorSpansToLangfuseMock.mockReset()
  mirrorSpansToLangfuseMock.mockResolvedValue(undefined)
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

  it('mirrors the flushed rows to Langfuse, fire-and-forget', async () => {
    mirrorSpansToLangfuseMock.mockResolvedValue(undefined)
    const buffer = new SpanBuffer('user-1', 'thread-1')
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
    const { admin } = makeCapturingAdmin()
    await buffer.flush(admin)
    expect(mirrorSpansToLangfuseMock).toHaveBeenCalledTimes(1)
    expect(mirrorSpansToLangfuseMock.mock.calls[0][0]).toHaveLength(1)
  })

  it('a Langfuse mirror that rejects is caught — the run completes, never fails on it', async () => {
    mirrorSpansToLangfuseMock.mockRejectedValue(new Error('langfuse ingestion is down'))
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
    const { admin, insertCalls } = makeCapturingAdmin()
    // flush() itself resolves fine — it never awaits the mirror promise —
    // and the Postgres insert (the write this function's caller actually
    // depends on) still lands, regardless of the exporter throwing.
    await expect(buffer.flush(admin)).resolves.toBeUndefined()
    expect(insertCalls).toHaveLength(1)
    // Let the fire-and-forget promise's rejection settle before the test
    // ends, so its .catch(log) handler (not an unhandled rejection) is what
    // actually resolves it.
    await new Promise((resolve) => setImmediate(resolve))
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
