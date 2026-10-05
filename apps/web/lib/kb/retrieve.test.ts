// retrieveKb() degradation contract: it must NEVER throw for an embedding-side
// failure — MissingKeyError (no provider configured, the common case),
// BudgetCapError (this month's cap already spent) and a provider timeout are
// all expected, everyday outcomes, not bugs. Each degrades to a plain
// searchKb() call with no vector (FTS-only) and still returns a result.
//
// searchKb() itself is mocked out here — its own RPC-forwarding and RRF-fixture
// behavior is covered in store.test.ts. This file is purely about
// retrieveKb()'s own decision: did it get a vector, and if not, why not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInTraceContext, SpanBuffer, type SpanRecord } from '../trace/spans'

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({ loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args) }))

const callEmbeddingMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callEmbedding: (...args: unknown[]) => callEmbeddingMock(...args) }
})

const searchKbMock = vi.fn()
vi.mock('./store', () => ({ searchKb: (...args: unknown[]) => searchKbMock(...args) }))

const { retrieveKb } = await import('./retrieve')
const { MissingKeyError } = await import('../harness/llm')
const { BudgetCapError } = await import('../harness/spend')

const admin = {} as Parameters<typeof retrieveKb>[0]

const FTS_HIT = [
  { chunkId: 'c1', documentId: 'd1', sourceId: 's1', ord: 0, content: 'x', title: null, url: null, rank: 0.1 },
]

beforeEach(() => {
  loadApiKeysMock.mockReset()
  callEmbeddingMock.mockReset()
  searchKbMock.mockReset()
  searchKbMock.mockResolvedValue(FTS_HIT)
})

describe('retrieveKb', () => {
  it('embeds the query and passes the vector through on the happy path', async () => {
    loadApiKeysMock.mockResolvedValue({ userId: 'u1' })
    callEmbeddingMock.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]], model: 'x', promptTokens: 3 })

    const hits = await retrieveKb(admin, 'u1', 'search this')

    expect(hits).toEqual(FTS_HIT)
    expect(searchKbMock).toHaveBeenCalledWith(
      admin,
      'u1',
      'search this',
      expect.objectContaining({ vector: [0.1, 0.2, 0.3] })
    )
  })

  it('degrades to FTS-only when no embedding provider is configured (MissingKeyError)', async () => {
    loadApiKeysMock.mockResolvedValue({})
    callEmbeddingMock.mockRejectedValue(new MissingKeyError('No embedding provider configured'))

    const hits = await expectNoThrow(() => retrieveKb(admin, 'u1', 'search this'))

    expect(hits).toEqual(FTS_HIT)
    expect(searchKbMock).toHaveBeenCalledWith(
      admin,
      'u1',
      'search this',
      expect.objectContaining({ vector: undefined })
    )
  })

  it('degrades to FTS-only when the monthly spend cap is already hit (BudgetCapError)', async () => {
    loadApiKeysMock.mockResolvedValue({})
    callEmbeddingMock.mockRejectedValue(new BudgetCapError(10, 10))

    const hits = await expectNoThrow(() => retrieveKb(admin, 'u1', 'search this'))

    expect(hits).toEqual(FTS_HIT)
    expect(searchKbMock).toHaveBeenCalledWith(
      admin,
      'u1',
      'search this',
      expect.objectContaining({ vector: undefined })
    )
  })

  it('degrades to FTS-only when the embedding call times out', async () => {
    loadApiKeysMock.mockResolvedValue({})
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    callEmbeddingMock.mockRejectedValue(timeout)

    const hits = await expectNoThrow(() => retrieveKb(admin, 'u1', 'search this'))

    expect(hits).toEqual(FTS_HIT)
    expect(searchKbMock).toHaveBeenCalledWith(
      admin,
      'u1',
      'search this',
      expect.objectContaining({ vector: undefined })
    )
  })

  it('an unexpected embedding failure also degrades rather than throwing', async () => {
    loadApiKeysMock.mockResolvedValue({})
    callEmbeddingMock.mockRejectedValue(new Error('dimension mismatch'))

    const hits = await expectNoThrow(() => retrieveKb(admin, 'u1', 'search this'))

    expect(hits).toEqual(FTS_HIT)
    expect(searchKbMock).toHaveBeenCalledWith(
      admin,
      'u1',
      'search this',
      expect.objectContaining({ vector: undefined })
    )
  })

  it('short-circuits an empty query without touching the embedding chokepoint or searchKb', async () => {
    const hits = await retrieveKb(admin, 'u1', '   ')
    expect(hits).toEqual([])
    expect(loadApiKeysMock).not.toHaveBeenCalled()
    expect(searchKbMock).not.toHaveBeenCalled()
  })
})

describe('retrieveKb in Langfuse', () => {
  const run = async (isDemo: boolean) => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
    loadApiKeysMock.mockResolvedValue({ userId: 'u1' })
    callEmbeddingMock.mockResolvedValue({ embeddings: [[0.1]], model: 'x', promptTokens: 1 })
    searchKbMock.mockResolvedValue([{ ...FTS_HIT[0], title: 'My notes', url: 'https://x.test/n', content: 'PRIVATE CHUNK TEXT' }])
    const buffer = new SpanBuffer('u1', null, undefined, { isDemo })
    await runInTraceContext({ buffer, parentSpanId: 'root', runId: null }, () => retrieveKb(admin, 'u1', 'visa rules', { limit: 5 }))
    return (buffer as unknown as { pending: SpanRecord[] }).pending[0]
  }
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is a Langfuse-only retriever with the query, the hit titles and an excerpt of each chunk, and names its embedding call', async () => {
    const row = await run(false)
    expect(row).toMatchObject({ name: 'retrieve-knowledge', persist: false, parent_span_id: 'root' })
    expect(row.lf).toMatchObject({ name: 'retrieve-knowledge', type: 'retriever', input: { query: 'visa rules' }, metadata: { limit: 5, hits: 1 } })
    expect(JSON.stringify(row.lf)).toContain('My notes')
    expect(row.lf?.output).toMatchObject({ hits: [{ excerpt: 'PRIVATE CHUNK TEXT' }] })
    expect(callEmbeddingMock.mock.calls[0][1]).toMatchObject({ name: 'embed-query' })
  })

  it('a demo trace keeps the query out', async () => {
    const row = await run(true)
    expect(row.lf?.input).toBeUndefined()
    expect(row.lf?.output).toBeUndefined()
    expect(JSON.stringify(row.lf)).not.toContain('PRIVATE CHUNK TEXT')
    expect(row.lf?.metadata).toMatchObject({ hits: 1 })
  })
})

/** Documents the "must not throw" assertion at the call site, not just via a
 *  passing await — a caller that swapped `await x()` for a throwing branch
 *  should fail this test, not silently reject. */
async function expectNoThrow<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(`expected no throw, got: ${err instanceof Error ? err.message : err}`)
  }
}
