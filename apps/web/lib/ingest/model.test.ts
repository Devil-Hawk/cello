import { beforeEach, describe, expect, it, vi } from 'vitest'

const callLlm = vi.fn()
vi.mock('../harness/llm', () => ({ callLlm: (...a: unknown[]) => callLlm(...a) }))

import { BudgetCapError } from '../harness/spend'
import { MODEL_LIMIT, freeModelKeys, makeIngestModelCall, newModelBudget } from './model'

const req = { system: 's', prompt: 'p', name: 'x', maxTokens: 10 }

beforeEach(() => callLlm.mockReset())

describe('makeIngestModelCall', () => {
  it('makes no call without a key', async () => {
    expect(await makeIngestModelCall({ userId: 'u' })(req)).toBeNull()
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('only ever asks a free model, as the user whose company it is', async () => {
    callLlm.mockResolvedValue({ content: 'ok' })
    expect(await makeIngestModelCall({ userId: 'user-1', openrouter: 'key' })(req)).toBe('ok')
    const [keys, opts] = callLlm.mock.calls[0]
    expect(keys).toMatchObject({ openrouter: 'key', userId: 'user-1' })
    expect(opts.model.endsWith(':free')).toBe(true)
  })

  it('falls through to the next free model when the first fails', async () => {
    callLlm.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({ content: 'second' })
    expect(await makeIngestModelCall({ userId: 'u', openrouter: 'key' })(req)).toBe('second')
    expect(callLlm).toHaveBeenCalledTimes(2)
  })

  it('returns null when every free model fails', async () => {
    callLlm.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    const budget = newModelBudget(5)
    expect(await makeIngestModelCall({ userId: 'u', openrouter: 'key' }, { budget })(req)).toBeNull()
    expect(budget.failed).toBe(1)
  })

  it('writes nothing to the log when a model fails: the log is public', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    callLlm.mockRejectedValueOnce(new Error('429 for https://secret.example/careers')).mockRejectedValueOnce(new Error('down'))
    await makeIngestModelCall({ userId: 'u', openrouter: 'key' })(req)
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true)
    spies.forEach((s) => s.mockRestore())
  })

  it('refuses with the limit once the allowance is spent, and remembers it', async () => {
    callLlm.mockResolvedValue({ content: 'ok' })
    const budget = newModelBudget(1)
    const call = makeIngestModelCall({ userId: 'u', openrouter: 'key' }, { budget })
    expect(await call(req)).toBe('ok')
    expect(await call(req)).toBe(MODEL_LIMIT)
    expect(budget.hit).toBe(true)
    expect(callLlm).toHaveBeenCalledTimes(1)
  })

  it("treats the user's spend cap as the limit for everything after it", async () => {
    callLlm.mockRejectedValueOnce(new BudgetCapError(5, 5))
    const budget = newModelBudget(10)
    const call = makeIngestModelCall({ userId: 'u', openrouter: 'key' }, { budget })
    expect(await call(req)).toBe(MODEL_LIMIT)
    expect(budget).toEqual({ n: 0, hit: true, failed: 0 })
    expect(await call(req)).toBe(MODEL_LIMIT)
    expect(callLlm).toHaveBeenCalledTimes(1)
  })

  it('keeps the account and demo standing, and nothing else of the user keys, when the platform key is used', () => {
    const guarded = { userId: 'u', isDemo: true, openai: 'sk-x', anthropic: 'sk-y', provider: 'local-cli' } as never
    expect(freeModelKeys(guarded, 'platform')).toEqual({ userId: 'u', isDemo: true, openrouter: 'platform' })
    expect(freeModelKeys({ userId: 'u' }, undefined)).toEqual({ userId: 'u' })
  })
})
