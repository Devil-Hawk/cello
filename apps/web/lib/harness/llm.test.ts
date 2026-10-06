// Parity tests for callLlm's p-retry wiring. ZERO real LLM calls: the
// provider call (../providers/openrouter's callOpenRouter) is fully mocked,
// and every test that goes through the metered path also mocks
// ./supabase-admin + ./spend so nothing touches a real database either.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callOpenRouterMock = vi.fn()
vi.mock('./providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

const callLocalServerMock = vi.fn()
vi.mock('./providers/local-server', () => ({
  callLocalServer: (...args: unknown[]) => callLocalServerMock(...args),
}))

const reserveSpendMock = vi.fn()
const settleSpendMock = vi.fn()
vi.mock('./spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./spend')>()
  return {
    ...actual,
    reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
    settleSpend: (...args: unknown[]) => settleSpendMock(...args),
  }
})

const RESERVATION = { id: 'res-1', userId: 'user-1', model: 'anthropic/claude-sonnet-5', estimateUsd: 0.02 }

const createAdminClientMock = vi.fn()
vi.mock('./supabase-admin', () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}))

import { callLlm, MissingKeyError } from './llm'
import type { DecryptedApiKeys, LlmResult } from './types'

/** A fake admin whose ONLY table is trace_spans, capturing every row a
 *  flush() inserts — everything else (spend) is mocked away above, so
 *  callLlm's admin client is only ever touched for span flushing here. */
function makeSpanCapturingAdmin() {
  const inserted: Record<string, unknown>[] = []
  const insertCalls: number[] = []
  const admin = {
    from: (name: string) => {
      if (name !== 'trace_spans') throw new Error(`makeSpanCapturingAdmin: unexpected table "${name}"`)
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          insertCalls.push(rows.length)
          inserted.push(...rows)
          return { error: null }
        },
      }
    },
  }
  return { admin, inserted, insertCalls }
}

const FAKE_RESULT: LlmResult = {
  content: 'hello',
  tokensUsed: 30,
  promptTokens: 10,
  completionTokens: 20,
  model: 'anthropic/claude-sonnet-5',
}

/** Minimal shape matching the OpenAI SDK's APIError (status + headers). */
function fakeProviderError(status: number) {
  const err = new Error(`HTTP ${status}`) as Error & { status: number }
  err.status = status
  return err
}

describe('callLlm retry parity (p-retry wired via lib/util/retry classifyError)', () => {
  beforeEach(() => {
    // Full reset + re-establish defaults every test (not just clear call
    // history) so no test's overrides — e.g. mockRejectedValueOnce — can
    // leak into the next one.
    callOpenRouterMock.mockReset()
    reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
    settleSpendMock.mockReset().mockResolvedValue(undefined)
    createAdminClientMock.mockReset().mockReturnValue({ __fake: 'admin-client' })
  })

  // Unmetered (no userId) so the budget/spend/DB path never runs at all.
  const unmeteredKeys: DecryptedApiKeys = { openrouter: 'fake-key' }

  it('a 429 then success succeeds — one retry', async () => {
    callOpenRouterMock.mockRejectedValueOnce(fakeProviderError(429)).mockResolvedValueOnce(FAKE_RESULT)

    const result = await callLlm(unmeteredKeys, { prompt: 'hi' })

    expect(result).toEqual(FAKE_RESULT)
    expect(callOpenRouterMock).toHaveBeenCalledTimes(2)
  })

  it('a 402 (permanent) does NOT retry — surfaces immediately on the first attempt', async () => {
    callOpenRouterMock.mockRejectedValue(fakeProviderError(402))

    await expect(callLlm(unmeteredKeys, { prompt: 'hi' })).rejects.toMatchObject({ status: 402 })
    expect(callOpenRouterMock).toHaveBeenCalledTimes(1)
  })

  it('MissingKeyError does not retry and surfaces unchanged', async () => {
    callOpenRouterMock.mockRejectedValue(new MissingKeyError('No OpenRouter API key configured'))

    await expect(callLlm(unmeteredKeys, { prompt: 'hi' })).rejects.toBeInstanceOf(MissingKeyError)
    expect(callOpenRouterMock).toHaveBeenCalledTimes(1)
  })

  it('an already-aborted signal stops retrying immediately, never calling the provider', async () => {
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    await expect(callLlm(unmeteredKeys, { prompt: 'hi' }, controller.signal)).rejects.toThrow('user cancelled')
    expect(callOpenRouterMock).not.toHaveBeenCalled()
  })

  it('every attempt reserves before the provider call and settles after it, with the provider cost', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    callOpenRouterMock.mockRejectedValueOnce(fakeProviderError(500)).mockResolvedValueOnce({ ...FAKE_RESULT, costUsd: 0.00042 })

    const result = await callLlm(meteredKeys, { prompt: 'hi' })

    expect(result.content).toBe('hello')
    expect(callOpenRouterMock).toHaveBeenCalledTimes(2)
    // Two attempts, two reservations: the first settles at zero (the provider
    // answered 500 and generated nothing), the second at the reported cost.
    expect(reserveSpendMock).toHaveBeenCalledTimes(2)
    expect(settleSpendMock).toHaveBeenCalledTimes(2)
    expect(settleSpendMock.mock.calls[0][2]).toMatchObject({ failed: { status: 500 } })
    expect(settleSpendMock.mock.calls[1][2]).toEqual({
      model: FAKE_RESULT.model,
      promptTokens: FAKE_RESULT.promptTokens,
      completionTokens: FAKE_RESULT.completionTokens,
      costUsd: 0.00042,
    })
    // Order: reserve, provider, settle.
    expect(reserveSpendMock.mock.invocationCallOrder[0]).toBeLessThan(callOpenRouterMock.mock.invocationCallOrder[0])
    expect(callOpenRouterMock.mock.invocationCallOrder[1]).toBeLessThan(settleSpendMock.mock.invocationCallOrder[1])
  })

  it('the reservation is priced from a ceiling the call always carries (default 2048) and the prompt', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    callOpenRouterMock.mockResolvedValue(FAKE_RESULT)

    await callLlm(meteredKeys, { prompt: 'x'.repeat(300), system: 'be brief' })
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({
      userId: 'user-1',
      model: 'anthropic/claude-sonnet-5',
      maxTokens: 2048,
      // (300 + 8) / 3 chars + (2 messages x 8), rounded up.
      promptTokens: Math.ceil(308 / 3) + 16,
    })
    expect(callOpenRouterMock.mock.calls[0][1]).toMatchObject({ maxTokens: 2048 })

    await callLlm(meteredKeys, { prompt: 'hi', maxTokens: 500 })
    expect(reserveSpendMock.mock.calls[1][1]).toMatchObject({ maxTokens: 500 })
  })

  it('a BudgetCapError from the reservation is never retried and the provider is never called', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    class BudgetCapError extends Error {
      constructor() {
        super('over budget')
        this.name = 'BudgetCapError'
      }
    }
    reserveSpendMock.mockRejectedValueOnce(new BudgetCapError())

    await expect(callLlm(meteredKeys, { prompt: 'hi' })).rejects.toThrow('over budget')
    expect(reserveSpendMock).toHaveBeenCalledTimes(1)
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(settleSpendMock).not.toHaveBeenCalled()
  })

  it('a provider call that dies without an HTTP status settles as failed, so the sweeper can charge the estimate', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    callOpenRouterMock.mockRejectedValue(new MissingKeyError('no key'))
    await expect(callLlm(meteredKeys, { prompt: 'hi' })).rejects.toBeInstanceOf(MissingKeyError)
    expect(settleSpendMock).toHaveBeenCalledTimes(1)
    expect(settleSpendMock.mock.calls[0][2]).toHaveProperty('failed')
  })
})

describe('callLlm emits an lib/trace/spans.ts "llm" span (Step 2)', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset()
    callLocalServerMock.mockReset()
    reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
    settleSpendMock.mockReset().mockResolvedValue(undefined)
    createAdminClientMock.mockReset()
  })

  it('a metered (openrouter) call flushes exactly one "ok" span carrying model/tokens/cost/metered/userId', async () => {
    const { admin, inserted, insertCalls } = makeSpanCapturingAdmin()
    createAdminClientMock.mockReturnValue(admin)
    callOpenRouterMock.mockResolvedValueOnce(FAKE_RESULT)

    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    await callLlm(meteredKeys, { prompt: 'hi' })

    expect(insertCalls).toEqual([1]) // exactly one batched insert, one span
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      kind: 'llm',
      name: 'llm',
      status: 'ok',
      parent_span_id: null,
      run_id: null,
      user_id: 'user-1',
      attributes: expect.objectContaining({
        model: FAKE_RESULT.model,
        promptTokens: FAKE_RESULT.promptTokens,
        completionTokens: FAKE_RESULT.completionTokens,
        metered: true,
        userId: 'user-1',
      }),
    })
    expect((inserted[0].attributes as Record<string, unknown>).costUsd).toBeGreaterThan(0)
  })

  it('an unmetered (local-server) call still flushes an "ok" span, with metered:false', async () => {
    const { admin, inserted } = makeSpanCapturingAdmin()
    createAdminClientMock.mockReturnValue(admin)
    callLocalServerMock.mockResolvedValueOnce(FAKE_RESULT)

    const localKeys: DecryptedApiKeys = {
      userId: 'user-1',
      provider: { active: 'local-server', localCli: 'claude', localServerBaseUrl: 'http://localhost:1234', localServerModel: 'x' },
    }
    await callLlm(localKeys, { prompt: 'hi' })

    // A local server is never charged, but its attempt still writes a $0 R2 row.
    expect(reserveSpendMock).toHaveBeenCalledTimes(1)
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ rung: 'R2' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ kind: 'llm', status: 'ok', attributes: expect.objectContaining({ metered: false }) })
  })

  it('a permanent provider failure still flushes an "error" span before rethrowing', async () => {
    const { admin, inserted } = makeSpanCapturingAdmin()
    createAdminClientMock.mockReturnValue(admin)
    callOpenRouterMock.mockRejectedValue(new MissingKeyError('no key configured'))

    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    await expect(callLlm(meteredKeys, { prompt: 'hi' })).rejects.toBeInstanceOf(MissingKeyError)

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      kind: 'llm',
      status: 'error',
      attributes: expect.objectContaining({ error: 'no key configured' }),
    })
  })

  it('no userId at all means no span (nothing honest to attribute it to)', async () => {
    const { admin, inserted } = makeSpanCapturingAdmin()
    createAdminClientMock.mockReturnValue(admin)
    callOpenRouterMock.mockResolvedValueOnce(FAKE_RESULT)

    await callLlm({ openrouter: 'fake-key' }, { prompt: 'hi' })

    expect(createAdminClientMock).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  })
})

describe('callLlm ledger rows for free and local calls', () => {
  const localKeys: DecryptedApiKeys = {
    userId: 'user-1',
    provider: { active: 'local-server', localCli: 'claude', localServerBaseUrl: 'http://localhost:1234', localServerModel: 'llama3.1' },
  }
  const freeKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }

  beforeEach(() => {
    callOpenRouterMock.mockReset()
    callLocalServerMock.mockReset()
    reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
    settleSpendMock.mockReset().mockResolvedValue(undefined)
    createAdminClientMock.mockReset().mockReturnValue({ __fake: 'admin-client' })
  })

  it('a local-server call with a user makes one R2 reserve named for the step, and one settle', async () => {
    callLocalServerMock.mockResolvedValueOnce(FAKE_RESULT)
    await callLlm(localKeys, { prompt: 'hi', name: 'classify-email' })
    expect(reserveSpendMock).toHaveBeenCalledTimes(1)
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ userId: 'user-1', model: 'llama3.1', rung: 'R2', step: 'classify-email' })
    expect(settleSpendMock).toHaveBeenCalledTimes(1)
  })

  it('a free OpenRouter model reserves R3, and an unnamed call uses the step call-llm', async () => {
    callOpenRouterMock.mockResolvedValueOnce(FAKE_RESULT)
    await callLlm(freeKeys, { prompt: 'hi', model: 'google/gemma-4-31b-it:free' })
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ rung: 'R3', step: 'call-llm', model: 'google/gemma-4-31b-it:free' })
  })

  it('a paid model reserves R4', async () => {
    callOpenRouterMock.mockResolvedValueOnce(FAKE_RESULT)
    await callLlm(freeKeys, { prompt: 'hi', model: 'anthropic/claude-haiku-4.5' })
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ rung: 'R4' })
  })

  it('opts.door reaches the reservation', async () => {
    callLocalServerMock.mockResolvedValueOnce(FAKE_RESULT)
    await callLlm(localKeys, { prompt: 'hi', door: 'chat' })
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ door: 'chat' })
  })

  it('two attempts write two rows', async () => {
    callOpenRouterMock.mockRejectedValueOnce(fakeProviderError(429)).mockResolvedValueOnce(FAKE_RESULT)
    await callLlm(freeKeys, { prompt: 'hi', model: 'x/y:free' })
    expect(reserveSpendMock).toHaveBeenCalledTimes(2)
    expect(settleSpendMock.mock.calls[0][2]).toMatchObject({ failed: { status: 429 } })
  })

  it('a ledger outage on a free call still returns the model text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const actual = await vi.importActual<typeof import('./spend')>('./spend')
    reserveSpendMock.mockImplementation((admin: never, input: never) => actual.reserveSpend(admin, input))
    createAdminClientMock.mockReturnValue({ rpc: async () => ({ error: { message: 'connection refused' } }) })
    callLocalServerMock.mockResolvedValueOnce(FAKE_RESULT)
    const out = await callLlm(localKeys, { prompt: 'hi' })
    expect(out.content).toBe('hello')
    spy.mockRestore()
  })

  it('a missing service key on a local call carries on without a ledger', async () => {
    createAdminClientMock.mockImplementation(() => {
      throw new Error('no service key')
    })
    callLocalServerMock.mockResolvedValueOnce(FAKE_RESULT)
    const out = await callLlm(localKeys, { prompt: 'hi' })
    expect(out.content).toBe('hello')
    expect(reserveSpendMock).not.toHaveBeenCalled()
  })
})
