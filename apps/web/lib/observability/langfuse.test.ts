// Tests for lib/observability/langfuse.ts — the optional Langfuse export.
// ZERO real network: the `langfuse` package itself is mocked so nothing here
// ever talks to a real endpoint, same style as lib/observability/sentry's
// sibling tests mock `@sentry/nextjs`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpanRecord } from '../trace/spans'

const traceMock = vi.fn()
const spanMock = vi.fn()
const generationMock = vi.fn()
const flushAsyncMock = vi.fn(async (): Promise<unknown> => undefined)
const LangfuseCtor = vi.fn().mockImplementation(() => ({
  trace: traceMock,
  span: spanMock,
  generation: generationMock,
  flushAsync: flushAsyncMock,
}))

vi.mock('langfuse', () => ({
  Langfuse: LangfuseCtor,
}))

type LangfuseModule = typeof import('./langfuse')
// The module caches its client, so every test gets a fresh copy.
async function load(): Promise<LangfuseModule> {
  vi.resetModules()
  return import('./langfuse')
}

function makeRow(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    trace_id: 'trace-1',
    span_id: 'span-1',
    parent_span_id: null,
    user_id: 'user-1',
    thread_id: 'thread-1',
    run_id: null,
    name: 'sourcer',
    kind: 'node',
    start_time: new Date(0).toISOString(),
    end_time: new Date(1000).toISOString(),
    status: 'ok',
    attributes: null,
    events: null,
    ...overrides,
  }
}

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

const llmRow = (overrides: Partial<SpanRecord> = {}) =>
  makeRow({
    span_id: 'llm-1',
    parent_span_id: 'span-1',
    name: 'llm',
    kind: 'llm',
    attributes: {
      model: 'anthropic/claude-sonnet-5',
      promptTokens: 100,
      completionTokens: 40,
      tokensUsed: 140,
      costUsd: 0.0009,
      metered: true,
      userId: 'user-1',
    },
    ...overrides,
  })

beforeEach(() => {
  traceMock.mockClear()
  spanMock.mockClear()
  generationMock.mockClear()
  flushAsyncMock.mockReset()
  flushAsyncMock.mockResolvedValue(undefined)
  LangfuseCtor.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('langfuseConfigured: the three-env-var gate', () => {
  it('false when all are unset (the default)', async () => {
    const { langfuseConfigured } = await load()
    expect(langfuseConfigured()).toBe(false)
  })

  it('false when any one of the three is missing or blank', async () => {
    const { langfuseConfigured } = await load()
    for (const missing of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) {
      vi.unstubAllEnvs()
      configure()
      vi.stubEnv(missing, '   ')
      expect(langfuseConfigured()).toBe(false)
    }
  })

  it('true when all three are non-blank', async () => {
    const { langfuseConfigured } = await load()
    configure()
    expect(langfuseConfigured()).toBe(true)
  })
})

describe('capture and sampling switches', () => {
  it('capture defaults ON when configured, off when LANGFUSE_CAPTURE_CONTENT=0, always off when unconfigured', async () => {
    const { langfuseCaptureEnabled } = await load()
    expect(langfuseCaptureEnabled()).toBe(false)
    configure()
    expect(langfuseCaptureEnabled()).toBe(true)
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    expect(langfuseCaptureEnabled()).toBe(false)
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'false')
    expect(langfuseCaptureEnabled()).toBe(false)
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '1')
    expect(langfuseCaptureEnabled()).toBe(true)
  })

  it('sample rate: unset/blank/garbage is 1, clamped to 0..1', async () => {
    const { langfuseSampleRate } = await load()
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '')
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', 'lots')
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0.25')
    expect(langfuseSampleRate()).toBe(0.25)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '7')
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '-3')
    expect(langfuseSampleRate()).toBe(0)
  })

  it('traceSampled is deterministic per trace_id and roughly honours the rate', async () => {
    const { traceSampled } = await load()
    const ids = Array.from({ length: 2000 }, (_, i) => `trace-${i}`)
    const first = ids.map((id) => traceSampled(id, 0.3))
    expect(ids.map((id) => traceSampled(id, 0.3))).toEqual(first) // same answer every time
    const share = first.filter(Boolean).length / ids.length
    expect(share).toBeGreaterThan(0.25)
    expect(share).toBeLessThan(0.35)
    expect(ids.every((id) => traceSampled(id, 1))).toBe(true)
    expect(ids.some((id) => traceSampled(id, 0))).toBe(false)
    // A trace sampled in at 0.3 stays in at any higher rate.
    ids.forEach((id, i) => {
      if (first[i]) expect(traceSampled(id, 0.6)).toBe(true)
    })
  })
})

describe('mirrorSpansToLangfuse', () => {
  it('unconfigured: never constructs the client, never throws', async () => {
    const { mirrorSpansToLangfuse } = await load()
    await expect(mirrorSpansToLangfuse([makeRow()])).resolves.toBeUndefined()
    expect(LangfuseCtor).not.toHaveBeenCalled()
  })

  it('half-configured (no public key): still a no-op', async () => {
    const { mirrorSpansToLangfuse } = await load()
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    await mirrorSpansToLangfuse([makeRow()])
    expect(LangfuseCtor).not.toHaveBeenCalled()
  })

  it('configured: traces once per unique trace_id, one observation per row, flushes once', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([
      makeRow({ span_id: 'span-1' }),
      makeRow({ span_id: 'span-2', parent_span_id: 'span-1' }),
      makeRow({ span_id: 'span-3', trace_id: 'trace-2' }),
    ])

    expect(traceMock).toHaveBeenCalledTimes(2)
    expect(spanMock).toHaveBeenCalledTimes(3)
    expect(spanMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'span-2', parentObservationId: 'span-1' }))
    expect(flushAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('client gets environment from VERCEL_ENV (default development) and release from the commit sha', async () => {
    configure()
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc123')
    const prod = await load()
    await prod.mirrorSpansToLangfuse([makeRow()])
    expect(LangfuseCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'pk-lf-fake',
        secretKey: 'sk-lf-fake',
        baseUrl: 'https://langfuse.example.com',
        environment: 'production',
        release: 'abc123',
        sampleRate: 1, // our own per-trace sampling is the only one
      })
    )

    LangfuseCtor.mockClear()
    vi.unstubAllEnvs()
    configure()
    const dev = await load()
    await dev.mirrorSpansToLangfuse([makeRow()])
    expect(LangfuseCtor).toHaveBeenCalledWith(expect.objectContaining({ environment: 'development', release: undefined }))
  })

  it('the trace is named after the surface (the root graph span) and keeps user and session', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([
      makeRow({ span_id: 'n1', parent_span_id: 'g1', name: 'sourcer' }),
      makeRow({ span_id: 'g1', kind: 'graph', name: 'copilot' }),
    ])
    expect(traceMock).toHaveBeenCalledTimes(1)
    expect(traceMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'trace-1', name: 'copilot', userId: 'user-1', sessionId: 'thread-1' }))
  })

  it("an 'llm' row becomes a GENERATION with model, usage, cost and timing; node rows stay spans", async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([makeRow({ span_id: 'span-1' }), llmRow()])

    expect(spanMock).toHaveBeenCalledTimes(1)
    expect(generationMock).toHaveBeenCalledTimes(1)
    const body = generationMock.mock.calls[0][0]
    expect(body).toMatchObject({
      id: 'llm-1',
      traceId: 'trace-1',
      parentObservationId: 'span-1',
      name: 'llm',
      model: 'anthropic/claude-sonnet-5',
      usageDetails: { input: 100, output: 40, total: 140 },
      costDetails: { total: 0.0009 },
      level: 'DEFAULT',
    })
    expect(body.startTime).toEqual(new Date(0))
    expect(body.endTime).toEqual(new Date(1000))
    // numeric metrics survive metadata scrubbing
    expect(body.metadata).toMatchObject({ promptTokens: 100, completionTokens: 40, tokensUsed: 140, costUsd: 0.0009 })
  })

  it('an unmetered (local) llm call sends usage but no invented cost', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([llmRow({ attributes: { model: 'llama', promptTokens: 1, completionTokens: 2, tokensUsed: 3, costUsd: 0.5, metered: false } })])
    const body = generationMock.mock.calls[0][0]
    expect(body.usageDetails).toEqual({ input: 1, output: 2, total: 3 })
    expect(body.costDetails).toBeUndefined()
  })

  it('a failed llm call is an ERROR generation with a redacted status message', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([
      llmRow({
        status: 'error',
        attributes: { model: 'm', metered: true, error: 'provider said 401 for Bearer abc.def.ghi and key sk-or-v1-abcdefghijklmnop' },
      }),
    ])
    const body = generationMock.mock.calls[0][0]
    expect(body.level).toBe('ERROR')
    expect(body.statusMessage).not.toMatch(/abc\.def|sk-or-v1/)
    expect(body.usageDetails).toEqual({})
    expect(JSON.stringify(body.metadata)).not.toMatch(/abc\.def|sk-or-v1/)
  })

  describe('prompt and completion capture', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl'
    const secretPrompt = `Hi, I am jane.doe@example.com. My key is sk-or-v1-abcdefghijklmnopqrstuv, header Bearer abc123token, jwt ${jwt}, blob QUJDREVGR0g=:QUJDREVGR0g=:QUJDREVGR0hJSktM`
    const content = { input: [{ role: 'system', content: 'be helpful' }, { role: 'user', content: secretPrompt }], output: `Reply to jane.doe@example.com with ${jwt}` }

    it('on by default: messages and completion reach the generation, fully redacted', async () => {
      configure()
      const { mirrorSpansToLangfuse } = await load()
      await mirrorSpansToLangfuse([llmRow({ content })])
      const body = generationMock.mock.calls[0][0]
      expect(body.input).toHaveLength(2)
      expect(body.input[0]).toEqual({ role: 'system', content: 'be helpful' })
      const sent = JSON.stringify([body.input, body.output, body.metadata, body.statusMessage])
      for (const leaked of ['jane.doe@example.com', 'sk-or-v1-abcdefghijklmnopqrstuv', 'abc123token', jwt, 'QUJDREVGR0hJSktM']) {
        expect(sent).not.toContain(leaked)
      }
      expect(body.input[1].content).toContain('[redacted-email]')
      expect(body.output).toContain('[redacted-token]')
    })

    it('LANGFUSE_CAPTURE_CONTENT=0: no input or output at all, metrics still sent', async () => {
      configure()
      vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
      const { mirrorSpansToLangfuse } = await load()
      await mirrorSpansToLangfuse([llmRow({ content })])
      const body = generationMock.mock.calls[0][0]
      expect(body.input).toBeUndefined()
      expect(body.output).toBeUndefined()
      expect(body.usageDetails.total).toBe(140)
    })

    it('every field is capped at about 16KB, after redaction', async () => {
      configure()
      const { mirrorSpansToLangfuse, CONTENT_CAP_CHARS } = await load()
      await mirrorSpansToLangfuse([llmRow({ content: { input: [{ role: 'user', content: 'x'.repeat(200_000) }], output: 'y'.repeat(200_000) } })])
      const body = generationMock.mock.calls[0][0]
      expect(body.input[0].content.length).toBeLessThan(CONTENT_CAP_CHARS + 20)
      expect(body.input[0].content).toContain('[truncated]')
      expect(body.output.length).toBeLessThan(CONTENT_CAP_CHARS + 20)
    })

    it('a secret straddling the cap is still not leaked', async () => {
      configure()
      const { mirrorSpansToLangfuse, CONTENT_CAP_CHARS } = await load()
      const key = 'sk-or-v1-abcdefghijklmnopqrstuv'
      const text = `${'a '.repeat(CONTENT_CAP_CHARS / 2 - 5)}${key} tail`
      await mirrorSpansToLangfuse([llmRow({ content: { output: text } })])
      expect(generationMock.mock.calls[0][0].output).not.toContain('sk-or-v1')
    })
  })

  it('metadata is scrubbed without destroying numbers: error text redacted, tokens kept', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([
      makeRow({ attributes: { error: 'Bearer abc.def sk-aaaaaaaaaaaaaaaa', promptTokens: 5, tokensUsed: 9, apiKey: 'plaintext-secret', label: 'sourcer' }, status: 'error' }),
    ])
    const body = spanMock.mock.calls[0][0]
    expect(body.metadata.promptTokens).toBe(5)
    expect(body.metadata.tokensUsed).toBe(9)
    expect(body.metadata.label).toBe('sourcer')
    expect(body.metadata.apiKey).toBe('[redacted]')
    expect(body.metadata.error).not.toMatch(/abc\.def|sk-aaaa/)
    expect(body.statusMessage).not.toMatch(/abc\.def|sk-aaaa/)
  })

  it('LANGFUSE_SAMPLE_RATE=0 exports nothing and never loads the client; a sampled trace goes whole', async () => {
    configure()
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0')
    const zero = await load()
    await zero.mirrorSpansToLangfuse([makeRow()])
    expect(LangfuseCtor).not.toHaveBeenCalled()

    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0.5')
    const half = await load()
    const kept = Array.from({ length: 40 }, (_, i) => `t-${i}`).filter((id) => half.traceSampled(id, 0.5))
    const dropped = Array.from({ length: 40 }, (_, i) => `t-${i}`).filter((id) => !half.traceSampled(id, 0.5))
    expect(kept.length).toBeGreaterThan(0)
    expect(dropped.length).toBeGreaterThan(0)
    await half.mirrorSpansToLangfuse([
      makeRow({ trace_id: kept[0], span_id: 'a' }),
      makeRow({ trace_id: kept[0], span_id: 'b' }),
      makeRow({ trace_id: dropped[0], span_id: 'c' }),
    ])
    expect(traceMock).toHaveBeenCalledTimes(1)
    expect(spanMock).toHaveBeenCalledTimes(2) // both of the kept trace's spans, none of the dropped one
  })

  it('a throwing exporter is caught and logged, never rethrown', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    traceMock.mockImplementationOnce(() => {
      throw new Error('langfuse ingestion is down')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(mirrorSpansToLangfuse([makeRow()])).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Langfuse export failed'))
    errSpy.mockRestore()
  })

  it('an empty row list never constructs the client', async () => {
    configure()
    const { mirrorSpansToLangfuse } = await load()
    await mirrorSpansToLangfuse([])
    expect(LangfuseCtor).not.toHaveBeenCalled()
  })
})

describe('mirrorSpansWithDeadline: a slow or dead Langfuse never holds a request', () => {
  it('returns at the deadline when the export hangs, and never throws', async () => {
    configure()
    const { mirrorSpansWithDeadline, MIRROR_DEADLINE_MS } = await load()
    expect(MIRROR_DEADLINE_MS).toBeLessThanOrEqual(2500)
    flushAsyncMock.mockImplementation(() => new Promise(() => undefined)) // never settles
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.useFakeTimers()

    let done = false
    const p = mirrorSpansWithDeadline([makeRow()]).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(MIRROR_DEADLINE_MS - 100)
    expect(done).toBe(false) // still within the budget
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(done).toBe(true)
    errSpy.mockRestore()
  })

  it('a fast export returns immediately and leaves no pending timer', async () => {
    configure()
    const { mirrorSpansWithDeadline } = await load()
    vi.useFakeTimers()
    await mirrorSpansWithDeadline([makeRow()])
    expect(vi.getTimerCount()).toBe(0)
    expect(flushAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('unconfigured: returns at once without a timer', async () => {
    const { mirrorSpansWithDeadline } = await load()
    vi.useFakeTimers()
    await mirrorSpansWithDeadline([makeRow()])
    expect(vi.getTimerCount()).toBe(0)
  })
})
