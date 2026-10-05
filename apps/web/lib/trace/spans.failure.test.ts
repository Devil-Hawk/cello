// Handled failures on the root observation, trace metadata ids, and embedding
// usage folded into a retriever (lib/trace/spans.ts). The replay itself is a spy:
// these tests read the `lf` payload each record hands it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'
import {
  SpanBuffer,
  currentTraceContext,
  observe,
  runInTraceContext,
  setTraceError,
  setTraceMeta,
  withSpan,
  withTrace,
} from './spans'

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

const admin = {
  from: (name: string) =>
    name === 'profiles'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'u', is_demo: false }, error: null }) }) }) }
      : { insert: async () => ({ error: null }) },
} as unknown as AdminClient

type LfRow = { name: string; lf?: Record<string, unknown> }
const rows = () => exportTraceMock.mock.calls[0][1] as LfRow[]
const rootLf = () => rows().find((r) => r.name === 'match-job')?.lf
const callModel = async () => {
  const ctx = currentTraceContext()!
  await withSpan(ctx.buffer, { parentSpanId: ctx.parentSpanId, runId: null, kind: 'llm', name: 'llm' }, async () => 'x')
}

beforeEach(() => {
  exportTraceMock.mockReset()
  exportTraceMock.mockResolvedValue(undefined)
  configureLangfuse()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a handled failure marks the root observation', () => {
  it('setTraceError gives the root level ERROR, the code, and {error: code} as output, though nothing threw', async () => {
    const out = await withTrace(admin, 'u', { name: 'match-job' }, async () => {
      await callModel()
      setTraceError('scoring-failed')
      return { status: 200 }
    })
    expect(out).toEqual({ status: 200 })
    expect(rootLf()).toMatchObject({ level: 'ERROR', errorCode: 'scoring-failed', output: { error: 'scoring-failed' } })
  })

  it('a returned response with status >= 500 is an ERROR root (http_<status>); 4xx and 2xx are not', async () => {
    for (const [status, expected] of [[500, 'http_500'], [503, 'http_503'], [400, undefined], [200, undefined]] as const) {
      exportTraceMock.mockClear()
      await withTrace(admin, 'u', { name: 'match-job' }, async () => {
        await callModel()
        return { status }
      })
      expect(rootLf()?.errorCode).toBe(expected)
      expect(rootLf()?.level).toBe(expected ? 'ERROR' : undefined)
    }
  })

  it('with content capture off the code still reaches the root but no output does', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', 'off')
    await withTrace(admin, 'u', { name: 'match-job' }, async () => {
      await callModel()
      return { status: 500 }
    })
    expect(rootLf()).toMatchObject({ level: 'ERROR', errorCode: 'http_500' })
    expect(rootLf()?.output).toBeUndefined()
  })
})

describe('setTraceMeta', () => {
  it('merges ids into the trace metadata and is a no-op outside a trace', async () => {
    setTraceMeta({ job_id: 'nowhere' }) // must not throw
    await withTrace(admin, 'u', { name: 'match-job', metadata: { source: 'ui' } }, async () => {
      await callModel()
      setTraceMeta({ job_id: 'job-1' })
      setTraceMeta({ judge: 'skipped' })
    })
    expect((exportTraceMock.mock.calls[0][0] as SpanBuffer).meta.metadata).toEqual({ source: 'ui', job_id: 'job-1', judge: 'skipped' })
  })
})

describe('observe foldEmbeddings', () => {
  it('puts the usage folded under a retriever on its metadata; an expected failure is flagged; others have none', async () => {
    const buffer = new SpanBuffer('u', null, undefined, { isDemo: false })
    await runInTraceContext({ buffer, parentSpanId: null, runId: null }, async () => {
      await observe({ name: 'search-memory', type: 'retriever', persist: false, foldEmbeddings: true }, async () => {
        const fold = currentTraceContext()!.embed!
        fold.calls += 2
        fold.tokens += 70
        fold.costUsd += 0.0000014
      })
      await observe(
        { name: 'search-insights', type: 'retriever', persist: false, foldEmbeddings: true },
        async () => {
          throw new Error('no key')
        },
        () => ({ expected: true, metadata: { fallback: 'no-embedding' } })
      ).catch(() => undefined)
      await observe({ name: 'plain-retriever', type: 'retriever', persist: false }, async () => 1)
    })
    await buffer.flush(admin)
    expect(rows().find((r) => r.name === 'search-memory')?.lf?.metadata).toEqual({ embedding_calls: 2, embedding_tokens: 70, embedding_cost: 0.0000014 })
    expect(rows().find((r) => r.name === 'search-insights')?.lf).toMatchObject({ expected: true, metadata: { fallback: 'no-embedding' } })
    expect(rows().find((r) => r.name === 'plain-retriever')?.lf?.metadata).toBeUndefined()
  })
})
