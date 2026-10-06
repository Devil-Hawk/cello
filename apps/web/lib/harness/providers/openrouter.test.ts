// OpenRouter end-user attribution: the request's `user` field is a stable,
// non-reversible tag, never a raw user id or email. ZERO network: the OpenAI
// SDK is mocked and the request body it receives is inspected.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../types'

const createMock = vi.fn()
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } }
  },
}))

import { callOpenRouter, openRouterUserTag } from './openrouter'

const USER_ID = '5f0c2f4e-8a53-4e0b-9a55-0d4f7a1c2b3d'

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
})

describe('openRouterUserTag', () => {
  it('is stable, not the raw id, and differs per user', () => {
    const tag = openRouterUserTag(USER_ID)
    expect(openRouterUserTag(USER_ID)).toBe(tag)
    expect(tag).toMatch(/^cello_[0-9a-f]{32}$/)
    expect(tag).not.toContain(USER_ID)
    expect(tag).not.toContain(USER_ID.slice(0, 8))
    expect(openRouterUserTag('another-user')).not.toBe(tag)
  })
})

describe('callOpenRouter request body', () => {
  it('sends the hashed tag as `user`, never the raw user id', async () => {
    await callOpenRouter({ openrouter: 'or-key', userId: USER_ID } as DecryptedApiKeys, { prompt: 'hi' })
    const body = createMock.mock.calls[0][0]
    expect(body.user).toBe(openRouterUserTag(USER_ID))
    expect(JSON.stringify(body)).not.toContain(USER_ID)
  })

  it('omits `user` when there is no user id (a keyed call outside a user session)', async () => {
    await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(createMock.mock.calls[0][0]).not.toHaveProperty('user')
  })
})

describe('callOpenRouter provider-reported cost', () => {
  it('returns usage.cost so the ledger settles the real figure', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00042, is_byok: false },
    })
    const result = await callOpenRouter({ openrouter: 'or-key', userId: USER_ID } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBe(0.00042)
  })

  it('adds the upstream charge for a bring-your-own-key request', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.009 } },
    })
    const result = await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBeCloseTo(0.01, 9)
  })

  it('leaves costUsd undefined when the response has no cost, so the price table applies', async () => {
    const result = await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBeUndefined()
  })

  it('always sends a max_tokens ceiling', async () => {
    await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(createMock.mock.calls[0][0].max_tokens).toBe(2048)
  })
})
