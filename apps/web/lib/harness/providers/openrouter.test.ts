// OpenRouter end-user attribution: the request's `user` field is a stable,
// non-reversible tag, never a raw user id or email. ZERO network: fetch is stubbed
// (ChatOpenRouter talks to OpenRouter with it) and the request body is inspected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../types'
import { callOpenRouter, openRouterUserTag } from './openrouter'

const USER_ID = '5f0c2f4e-8a53-4e0b-9a55-0d4f7a1c2b3d'

const ORIGINAL_FETCH = global.fetch
const fetchMock = vi.fn()

const completion = (usage: Record<string, unknown> = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** The JSON body the first request carried. */
const firstBody = () => JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => completion())
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
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
    const body = firstBody()
    expect(body.user).toBe(openRouterUserTag(USER_ID))
    expect(JSON.stringify(body)).not.toContain(USER_ID)
  })

  it('omits `user` when there is no user id (a keyed call outside a user session)', async () => {
    await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(firstBody()).not.toHaveProperty('user')
  })
})

describe('callOpenRouter provider-reported cost', () => {
  it('returns usage.cost so the ledger settles the real figure', async () => {
    fetchMock.mockImplementation(async () => completion({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00042, is_byok: false }))
    const result = await callOpenRouter({ openrouter: 'or-key', userId: USER_ID } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBe(0.00042)
  })

  it('adds the upstream charge for a bring-your-own-key request', async () => {
    fetchMock.mockImplementation(async () =>
      completion({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.009 } })
    )
    const result = await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBeCloseTo(0.01, 9)
  })

  it('leaves costUsd undefined when the response has no cost, so the price table applies', async () => {
    const result = await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result.costUsd).toBeUndefined()
  })

  it('always sends a max_tokens ceiling', async () => {
    await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(firstBody().max_tokens).toBe(2048)
  })
})

describe('callOpenRouter request shape', () => {
  it('puts a cache breakpoint on the system block, asks for JSON and translates reasoning for Anthropic', async () => {
    await callOpenRouter(
      { openrouter: 'or-key' } as DecryptedApiKeys,
      { system: 'sys', prompt: 'hi', cachePrefix: true, json: true, reasoning: { effort: 'high' }, maxTokens: 20_000 }
    )
    const body = firstBody()
    expect(body.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning).toEqual({ max_tokens: 16384 })
  })

  it('sends the effort verbatim to a model that takes one', async () => {
    await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi', model: 'openai/gpt-5.2', reasoning: { effort: 'low' } })
    expect(firstBody().reasoning).toEqual({ effort: 'low' })
  })

  it('reports tokens and the reasoning trace from the response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok', reasoning: 'thinking' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const result = await callOpenRouter({ openrouter: 'or-key' } as DecryptedApiKeys, { prompt: 'hi' })
    expect(result).toMatchObject({ content: 'ok', promptTokens: 5, completionTokens: 2, tokensUsed: 7, cachedTokens: 3, reasoningTokens: 1, reasoning: 'thinking' })
  })
})

describe('callOpenRouter structured output', () => {
  const keys = { openrouter: 'k' } as DecryptedApiKeys

  it('sends a strict json_schema response format and the response-healing plugin', async () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false }
    await callOpenRouter(keys, { prompt: 'x', json: true, jsonSchema: { name: 'resume', schema } })
    const body = firstBody()
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'resume', strict: true, schema },
    })
    expect(body.plugins).toEqual([{ id: 'response-healing' }])
    // would route away from the user's model, so it must never be set
    expect(body.provider).toBeUndefined()
  })

  it('falls back to a plain JSON object without a schema', async () => {
    await callOpenRouter(keys, { prompt: 'x', json: true })
    const body = firstBody()
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.plugins).toBeUndefined()
  })
})
