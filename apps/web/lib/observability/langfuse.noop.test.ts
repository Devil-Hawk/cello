// Langfuse unconfigured, or the trace sampled out: a COMPLETE no-op. The Langfuse
// packages throw if anything imports them, `lfOf` is never called, nothing is
// delivered. Separate file because the mocks below would break the replay tests.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@langfuse/otel', () => {
  throw new Error('@langfuse/otel must not be imported when Langfuse is off')
})
vi.mock('@langfuse/tracing', () => {
  throw new Error('@langfuse/tracing must not be imported when Langfuse is off')
})
vi.mock('@langfuse/client', () => {
  throw new Error('@langfuse/client must not be imported when Langfuse is off')
})

import { SpanBuffer, withSpan } from '../trace/spans'
import { exportTrace } from './langfuse'

afterEach(() => {
  vi.unstubAllEnvs()
})

const spec = { parentSpanId: null, runId: null, kind: 'llm' as const, name: 'llm' }

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

describe('Langfuse off', () => {
  it('unconfigured: lfOf is never called, no record carries lf, flush imports nothing', async () => {
    const lfOf = vi.fn(() => ({ name: 'x' }))
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    expect(buffer.exportEnabled).toBe(false)
    expect(buffer.captureContent).toBe(false)
    await withSpan(buffer, spec, async () => 'ok', undefined, lfOf)
    await expect(withSpan(buffer, spec, async () => Promise.reject(new Error('boom')), undefined, lfOf)).rejects.toThrow('boom')
    expect(lfOf).not.toHaveBeenCalled()
    const rows: unknown[] = []
    const admin = { from: () => ({ insert: async (r: unknown[]) => (rows.push(...r), { error: null }) }) }
    await buffer.flush(admin as never)
    expect(rows).toHaveLength(2)
    for (const r of rows as Record<string, unknown>[]) expect(r).not.toHaveProperty('lf')
  })

  it('half configured is off', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
    const lfOf = vi.fn()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await withSpan(buffer, spec, async () => 'ok', undefined, lfOf)
    expect(lfOf).not.toHaveBeenCalled()
  })

  it('sampled out: configured, rate 0, still no lfOf and no import', async () => {
    configure()
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0')
    const lfOf = vi.fn()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    expect(buffer.exportEnabled).toBe(false)
    await withSpan(buffer, spec, async () => 'ok', undefined, lfOf)
    expect(lfOf).not.toHaveBeenCalled()
    const rows = [{ span_id: 's' }] as never
    await expect(exportTrace(buffer, rows)).resolves.toBeUndefined()
  })

  it('a demo trace sampled out by the demo rate is off too', () => {
    configure()
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '0')
    expect(new SpanBuffer('u', null, undefined, { isDemo: true }).exportEnabled).toBe(false)
    expect(new SpanBuffer('u', null, undefined, { isDemo: false }).exportEnabled).toBe(true)
  })

  it('a Langfuse-only span (persist:false) is not even run through lfOf or recorded when off', async () => {
    const lfOf = vi.fn()
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    const out = await withSpan(buffer, { ...spec, persist: false }, async () => 'ok', undefined, lfOf)
    expect(out).toBe('ok')
    expect(buffer.size).toBe(0)
    expect(lfOf).not.toHaveBeenCalled()
  })
})
