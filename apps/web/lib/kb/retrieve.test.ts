// retrieveKb() degradation contract: it must NEVER throw for an embedding-side
// failure — MissingKeyError (no provider configured, the common case),
// BudgetCapError (this month's cap already spent) and a provider timeout are
// all expected, everyday outcomes, not bugs. Each degrades to a plain
// searchKb() call with no vector (FTS-only) and still returns a result.
//
// searchKb() itself is mocked out here — its own RPC-forwarding and RRF-fixture
// behavior is covered in store.test.ts. This file is purely about
// retrieveKb()'s own decision: did it get a vector, and if not, why not.

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
