// A declared step picks its rung before it runs (blueprint 11.1, 11.3): the pick
// decides the model and the way in, no rung left is the step's own sentence, and a
// free key without credit stops at the day's cap.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memorySlotStore } from '../commands/slots'
import { MissingKeyError } from '../harness/providers'
import type { DecryptedApiKeys, LlmResult } from '../harness/types'
import { defineModelStep } from '../steps/define'
import { FreeCapError } from './caps'
import { BelowRungError } from './ladder'

const callLlmMock = vi.fn()
vi.mock('../harness/llm', () => ({ callLlm: (...args: unknown[]) => callLlmMock(...args) }))

const RESULT: LlmResult = { content: 'ok', tokensUsed: 2, promptTokens: 1, completionTokens: 1, model: 'x' }
const FREE = 'qwen/qwen3.8-27b:free'

const chance = defineModelStep({ id: 'chance', kind: 'step', measure: 'S3', minRung: 'R2', below: 'Roles are ordered by title match and date.' })
const draft = defineModelStep({ id: 'draft-follow-up', kind: 'step', measure: 'S6', minRung: 'R2', below: 'Write my own.' })

// A person (userId) is what the daily caps count; the pick tests without one count nothing.
const free = (extra: Partial<DecryptedApiKeys> = {}): DecryptedApiKeys => ({
  openrouter: 'k',
  models: { ceiling: 'R3', order: ['R3'], creditBought: false },
  ...extra,
})

beforeEach(() => {
  callLlmMock.mockReset()
  callLlmMock.mockResolvedValue(RESULT)
})

describe('the pick before a step runs', () => {
  it('sends the call to the rung it picked: a free model on OpenRouter for R3', async () => {
    const result = await chance.call(free(), { prompt: 'hi', model: 'anthropic/claude-sonnet-5' })
    expect(callLlmMock.mock.calls[0][1]).toMatchObject({ via: 'openrouter', model: FREE, name: 'chance' })
    expect(result.prov.rung).toBe('R3')
  })

  it('keeps a caller\'s own model only on the person\'s paid OpenRouter key', async () => {
    const keys: DecryptedApiKeys = { openrouter: 'k', models: { ceiling: 'R4', order: ['R4'], creditBought: false } }
    const result = await chance.call(keys, { prompt: 'hi', model: 'google/gemini-2.0-flash-001' })
    expect(callLlmMock.mock.calls[0][1]).toMatchObject({ via: 'openrouter', model: 'google/gemini-2.0-flash-001' })
    expect(result.prov.rung).toBe('R4')
  })

  it('throws the step\'s own sentence when no rung is left, as a missing key so callers that expect one still work', async () => {
    const error = await chance.call({ models: { ceiling: 'R0', order: [], creditBought: false } }, { prompt: 'hi' }).catch((e) => e)
    expect(error).toBeInstanceOf(BelowRungError)
    expect(error).toBeInstanceOf(MissingKeyError)
    expect(error.message).toBe('Roles are ordered by title match and date.')
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('leaves a call alone when the keys carry no ceiling', async () => {
    await chance.call({ openrouter: 'k' }, { prompt: 'hi' })
    expect(callLlmMock.mock.calls[0][1]).not.toHaveProperty('via')
  })
})

describe('a free key without credit', () => {
  it('stops at 5 drafts a day with the cap sentence', async () => {
    const slots = memorySlotStore()
    for (let i = 0; i < 5; i++) await draft.call(free({ userId: 'user-1' }), { prompt: 'hi' }, { slots })
    const error = await draft.call(free({ userId: 'user-1' }), { prompt: 'hi' }, { slots }).catch((e) => e)
    expect(error).toBeInstanceOf(FreeCapError)
    expect(error.message).toBe('Free models allow 5 drafts a day. Add credit or choose another way to run.')
    expect(callLlmMock).toHaveBeenCalledTimes(5)
    // Another person has their own day, and a step with no daily cap is not counted.
    await draft.call(free({ userId: 'user-2' }), { prompt: 'hi' }, { slots })
    await defineModelStep({ id: 'inbox.classify', kind: 'step', measure: 'S8', minRung: 'R1', below: 'x' }).call(free({ userId: 'user-1' }), { prompt: 'hi' }, { slots })
  })

  it('has no cap once credit was bought, or on a rung that is not free', async () => {
    const slots = memorySlotStore()
    const credited = free({ userId: 'user-1', models: { ceiling: 'R3', order: ['R3'], creditBought: true } })
    const paid: DecryptedApiKeys = { openrouter: 'k', userId: 'user-1', models: { ceiling: 'R4', order: ['R4'], creditBought: false } }
    for (let i = 0; i < 7; i++) {
      await draft.call(credited, { prompt: 'hi' }, { slots })
      await draft.call(paid, { prompt: 'hi' }, { slots })
    }
    expect(callLlmMock).toHaveBeenCalledTimes(14)
  })
})
