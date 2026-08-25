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

import { callLlm, MissingKeyError } from './llm'
import type { DecryptedApiKeys, LlmResult } from './types'

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
    assertWithinBudgetMock.mockReset().mockResolvedValue(undefined)
    recordSpendMock.mockReset().mockResolvedValue(undefined)
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

  it('spend is metered exactly once, only on the attempt that actually completed', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    callOpenRouterMock.mockRejectedValueOnce(fakeProviderError(500)).mockResolvedValueOnce(FAKE_RESULT)

    const result = await callLlm(meteredKeys, { prompt: 'hi' })

    expect(result).toEqual(FAKE_RESULT)
    expect(callOpenRouterMock).toHaveBeenCalledTimes(2)
    // Budget checked once up front (before any attempt), spend recorded once
    // for the attempt that actually completed — never once per attempt.
    expect(assertWithinBudgetMock).toHaveBeenCalledTimes(1)
    expect(recordSpendMock).toHaveBeenCalledTimes(1)
    expect(recordSpendMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      FAKE_RESULT.model,
      FAKE_RESULT.promptTokens,
      FAKE_RESULT.completionTokens
    )
  })

  it('a BudgetCapError from the pre-flight check is never retried (it never even reaches p-retry)', async () => {
    const meteredKeys: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'user-1' }
    class BudgetCapError extends Error {
      constructor() {
        super('over budget')
        this.name = 'BudgetCapError'
      }
    }
    assertWithinBudgetMock.mockRejectedValueOnce(new BudgetCapError())

    await expect(callLlm(meteredKeys, { prompt: 'hi' })).rejects.toThrow('over budget')
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
  })
})
