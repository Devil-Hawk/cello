// Tests for lib/observability/langfuse.ts — the optional Langfuse export.
// ZERO real network: the `langfuse` package itself is mocked so nothing here
// ever talks to a real endpoint, same style as lib/observability/sentry's
// sibling tests mock `@sentry/nextjs`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpanRecord } from '../trace/spans'

const traceMock = vi.fn()
const spanMock = vi.fn()
const flushAsyncMock = vi.fn(async () => undefined)
const LangfuseCtor = vi.fn().mockImplementation(() => ({
  trace: traceMock,
  span: spanMock,
  flushAsync: flushAsyncMock,
}))

vi.mock('langfuse', () => ({
  Langfuse: LangfuseCtor,
}))

import { langfuseConfigured, mirrorSpansToLangfuse } from './langfuse'

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

describe('langfuseConfigured — the two-env-var gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('false when both are unset (the default)', async () => {
    vi.unstubAllEnvs()
    expect(langfuseConfigured()).toBe(false)
  })

  it('false with only one of the two set', async () => {
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', '')
    expect(langfuseConfigured()).toBe(false)
  })

  it('true when both are set to non-blank values', async () => {
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    expect(langfuseConfigured()).toBe(true)
  })
})

describe('mirrorSpansToLangfuse', () => {
  beforeEach(() => {
    traceMock.mockClear()
    spanMock.mockClear()
    flushAsyncMock.mockClear()
    LangfuseCtor.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('unconfigured: never constructs the client, never throws', async () => {
    vi.unstubAllEnvs()
    await expect(mirrorSpansToLangfuse([makeRow()])).resolves.toBeUndefined()
    expect(LangfuseCtor).not.toHaveBeenCalled()
  })

  it('configured: traces once per unique trace_id, spans every row, flushes', async () => {
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')

    const rows = [
      makeRow({ span_id: 'span-1' }),
      makeRow({ span_id: 'span-2', parent_span_id: 'span-1' }),
      makeRow({ span_id: 'span-3', trace_id: 'trace-2' }),
    ]
    await mirrorSpansToLangfuse(rows)

    expect(traceMock).toHaveBeenCalledTimes(2) // trace-1, trace-2 — not once per span
    expect(spanMock).toHaveBeenCalledTimes(3)
    expect(spanMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'span-2', parentObservationId: 'span-1' })
    )
    expect(flushAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('a throwing exporter is caught and logged, never rethrown', async () => {
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    traceMock.mockImplementationOnce(() => {
      throw new Error('langfuse ingestion is down')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(mirrorSpansToLangfuse([makeRow()])).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Langfuse export failed'))
    errSpy.mockRestore()
  })

  it('an empty row list never constructs the client', async () => {
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    await mirrorSpansToLangfuse([])
    expect(LangfuseCtor).not.toHaveBeenCalled()
  })
})
