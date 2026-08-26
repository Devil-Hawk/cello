// Parity tests for callEmbedding's chokepoint shape against callLlm's. ZERO
// real network calls: every backend (../providers/embeddings) is mocked, and
// the metered path also mocks ./supabase-admin + ./spend so nothing touches a
// real database either. See lib/harness/llm.test.ts — this is its sibling.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callOpenRouterEmbeddingMock = vi.fn()
const callOpenAiDirectEmbeddingMock = vi.fn()
const callLocalServerEmbeddingMock = vi.fn()
vi.mock('./providers/embeddings', async () => {
  const actual = await vi.importActual<typeof import('./providers/embeddings')>('./providers/embeddings')
  return {
    ...actual,
    callOpenRouterEmbedding: (...args: unknown[]) => callOpenRouterEmbeddingMock(...args),
    callOpenAiDirectEmbedding: (...args: unknown[]) => callOpenAiDirectEmbeddingMock(...args),
    callLocalServerEmbedding: (...args: unknown[]) => callLocalServerEmbeddingMock(...args),
  }
})

const assertWithinBudgetMock = vi.fn()
const recordSpendMock = vi.fn()
vi.mock('./spend', () => ({
  assertWithinBudget: (...args: unknown[]) => assertWithinBudgetMock(...args),
  recordSpend: (...args: unknown[]) => recordSpendMock(...args),
}))

const createAdminClientMock = vi.fn()
vi.mock('./supabase-admin', () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}))

import { callEmbedding, EMBEDDING_MODEL, MissingKeyError } from './llm'
import { testEmbedding, EMBEDDING_DIMS } from './providers/embeddings'
import type { DecryptedApiKeys } from './types'
import type { EmbedBatchResult } from './providers/embeddings'

const FAKE_RESULT: EmbedBatchResult = {
  embeddings: [[0.1, 0.2, 0.3]],
  model: EMBEDDING_MODEL,
  promptTokens: 12,
}

describe('callEmbedding — chokepoint shape', () => {
  beforeEach(() => {
    callOpenRouterEmbeddingMock.mockReset()
    callOpenAiDirectEmbeddingMock.mockReset()
    callLocalServerEmbeddingMock.mockReset()
    assertWithinBudgetMock.mockReset().mockResolvedValue(undefined)
    recordSpendMock.mockReset().mockResolvedValue(undefined)
    createAdminClientMock.mockReset().mockReturnValue({ __fake: 'admin-client' })
  })

  const unmeteredKeys: DecryptedApiKeys = { openrouter: 'fake-or-key' }
  const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-or-key', userId: 'user-1' }

  it('assertWithinBudget fires BEFORE the provider HTTP call', async () => {
    const order: string[] = []
    assertWithinBudgetMock.mockImplementation(async () => {
      order.push('assertWithinBudget')
    })
    callOpenRouterEmbeddingMock.mockImplementation(async () => {
      order.push('provider-call')
      return FAKE_RESULT
    })

    await callEmbedding(meteredKeys, { texts: ['hello'] })

    expect(order).toEqual(['assertWithinBudget', 'provider-call'])
  })

  it('recordSpend fires AFTER, with the real usage and completionTokens=0', async () => {
    callOpenRouterEmbeddingMock.mockResolvedValue(FAKE_RESULT)

    await callEmbedding(meteredKeys, { texts: ['hello', 'world'] })

    expect(recordSpendMock).toHaveBeenCalledTimes(1)
    expect(recordSpendMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      EMBEDDING_MODEL,
      FAKE_RESULT.promptTokens,
      0
    )
  })

  it('metered flag semantics mirror callLlm: no userId means no budget check and no spend record', async () => {
    callOpenRouterEmbeddingMock.mockResolvedValue(FAKE_RESULT)

    const result = await callEmbedding(unmeteredKeys, { texts: ['hello'] })

    expect(result).toEqual(FAKE_RESULT)
    expect(assertWithinBudgetMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
  })

  it('fallback chain: openrouter fails -> openai-direct is tried next', async () => {
    callOpenRouterEmbeddingMock.mockRejectedValue(new Error('openrouter down'))
    callOpenAiDirectEmbeddingMock.mockResolvedValue(FAKE_RESULT)

    const keys: DecryptedApiKeys = { openrouter: 'k', openai: 'sk-openai', userId: 'user-1' }
    const result = await callEmbedding(keys, { texts: ['hello'] })

    expect(result).toEqual(FAKE_RESULT)
    expect(callOpenRouterEmbeddingMock).toHaveBeenCalledTimes(1)
    expect(callOpenAiDirectEmbeddingMock).toHaveBeenCalledTimes(1)
    // openai-direct is not the openrouter leg — never metered.
    expect(recordSpendMock).not.toHaveBeenCalled()
  })

  it('fallback chain: local-server is tried only when a local embedding model is configured', async () => {
    callOpenRouterEmbeddingMock.mockRejectedValue(new Error('openrouter down'))
    callOpenAiDirectEmbeddingMock.mockRejectedValue(new Error('openai down'))
    callLocalServerEmbeddingMock.mockResolvedValue(FAKE_RESULT)

    const withoutLocalModel: DecryptedApiKeys = { openrouter: 'k', openai: 'sk' }
    await expect(callEmbedding(withoutLocalModel, { texts: ['hello'] })).rejects.toThrow('openai down')
    expect(callLocalServerEmbeddingMock).not.toHaveBeenCalled()

    const withLocalModel: DecryptedApiKeys = {
      openrouter: 'k',
      openai: 'sk',
      provider: {
        active: 'openrouter',
        localCli: 'claude',
        localServerBaseUrl: 'http://localhost:11434/v1',
        localServerModel: '',
        localServerEmbeddingModel: 'nomic-embed-text',
      },
    }
    const result = await callEmbedding(withLocalModel, { texts: ['hello'] })
    expect(result).toEqual(FAKE_RESULT)
    expect(callLocalServerEmbeddingMock).toHaveBeenCalledTimes(1)
  })

  it('throws MissingKeyError when nothing is configured at all', async () => {
    await expect(callEmbedding({}, { texts: ['hello'] })).rejects.toBeInstanceOf(MissingKeyError)
    expect(callOpenRouterEmbeddingMock).not.toHaveBeenCalled()
  })

  it('throws the last error when every configured backend fails', async () => {
    callOpenRouterEmbeddingMock.mockRejectedValue(new Error('rate limited'))

    await expect(callEmbedding({ openrouter: 'k' }, { texts: ['hello'] })).rejects.toThrow('rate limited')
  })

  it('an empty texts array short-circuits without calling any provider', async () => {
    const result = await callEmbedding({ openrouter: 'k', userId: 'user-1' }, { texts: [] })

    expect(result).toEqual({ embeddings: [], model: EMBEDDING_MODEL, promptTokens: 0 })
    expect(callOpenRouterEmbeddingMock).not.toHaveBeenCalled()
    expect(assertWithinBudgetMock).not.toHaveBeenCalled()
  })

  it('a BudgetCapError from the pre-flight check on the openrouter leg falls through to the next backend', async () => {
    // Same "refuse before spending" contract as callLlm, but because this is a
    // FALLBACK CHAIN (not callLlm's single provider pick), a cap hit on the
    // metered leg is not fatal — a self-supplied OpenAI key costs Cello's own
    // ledger nothing, so trying it is strictly better than failing outright.
    class BudgetCapError extends Error {
      constructor() {
        super('over budget')
        this.name = 'BudgetCapError'
      }
    }
    assertWithinBudgetMock.mockRejectedValueOnce(new BudgetCapError())
    callOpenAiDirectEmbeddingMock.mockResolvedValue(FAKE_RESULT)

    const keys: DecryptedApiKeys = { openrouter: 'k', openai: 'sk', userId: 'user-1' }
    const result = await callEmbedding(keys, { texts: ['hello'] })

    expect(result).toEqual(FAKE_RESULT)
    expect(callOpenRouterEmbeddingMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
  })
})

describe('testEmbedding — test-only guard', () => {
  const ORIGINAL_VITEST = process.env.VITEST

  afterEach(() => {
    process.env.VITEST = ORIGINAL_VITEST
  })

  it('works normally inside a vitest run (VITEST is set)', () => {
    const vec = testEmbedding('hello world')
    expect(vec).toHaveLength(EMBEDDING_DIMS)
    expect(vec.every((n) => Number.isFinite(n))).toBe(true)
  })

  it('is deterministic: same text -> identical vector', () => {
    expect(testEmbedding('same text')).toEqual(testEmbedding('same text'))
  })

  it('different text -> a different vector', () => {
    expect(testEmbedding('text a')).not.toEqual(testEmbedding('text b'))
  })

  it('throws when called outside a vitest run', () => {
    delete process.env.VITEST
    expect(() => testEmbedding('hello')).toThrow(/test-only/)
  })
})
