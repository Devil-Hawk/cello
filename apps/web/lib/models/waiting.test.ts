// What happens when the free models run out (blueprint 11.3): the daily-limit 429 is
// one provider call and no retry, work waits in a fixed order, the reset is shown in
// the person's zone, and a negative balance has its own sentence.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineModelStep } from '../steps/define'
import type { DecryptedApiKeys } from '../harness/types'
import { FreeLimitReachedError, NegativeBalanceError, WAIT_ORDER, limitSentence, nextUtcMidnight, orderWaiting } from './waiting'

const ORIGINAL_FETCH = global.fetch
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
})

const step = defineModelStep({ id: 'chance', kind: 'step', measure: 'S3', minRung: 'R2', below: 'Roles are ordered by title match and date.' })
const keys: DecryptedApiKeys = { openrouter: 'k', models: { ceiling: 'R3', order: ['R3'], creditBought: false } }

const answer = (status: number, message: string) =>
  vi.fn(async () => new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'content-type': 'application/json' } }))

describe('the free model limit and a negative balance', () => {
  it('stops on the daily-limit 429 after one provider call, with the next UTC midnight as the reset', async () => {
    const fetchMock = answer(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day')
    global.fetch = fetchMock as unknown as typeof fetch

    const error = await step.call(keys, { prompt: 'hi' }).catch((e) => e)

    expect(error).toBeInstanceOf(FreeLimitReachedError)
    expect((error as FreeLimitReachedError).resetAt).toEqual(nextUtcMidnight())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives a 402 the balance sentence, and does not retry it', async () => {
    const fetchMock = answer(402, 'Insufficient credits')
    global.fetch = fetchMock as unknown as typeof fetch

    const error = await step.call(keys, { prompt: 'hi' }).catch((e) => e)

    expect(error).toBeInstanceOf(NegativeBalanceError)
    expect((error as Error).message).toBe('Your OpenRouter balance is below zero, which blocks free models too. Add credit or choose another way to run.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('work that waits for the reset', () => {
  it('resumes mail first, then asked drafts, started applications, the morning pick and rule preparation, oldest first within a kind', () => {
    const queue = [
      { id: 'rule', kind: 'rule_preparation', askedAt: '2026-10-06T07:00:00Z' },
      { id: 'pick', kind: 'morning_pick', askedAt: '2026-10-06T06:00:00Z' },
      { id: 'draft-late', kind: 'asked_draft', askedAt: '2026-10-06T10:00:00Z' },
      { id: 'application', kind: 'started_application', askedAt: '2026-10-06T09:00:00Z' },
      { id: 'mail', kind: 'mail', askedAt: '2026-10-06T11:00:00Z' },
      { id: 'draft-early', kind: 'asked_draft', askedAt: '2026-10-06T08:00:00Z' },
    ] as const

    expect(orderWaiting(queue).map((i) => i.id)).toEqual(['mail', 'draft-early', 'draft-late', 'application', 'pick', 'rule'])
    expect(WAIT_ORDER).toEqual(['mail', 'asked_draft', 'started_application', 'morning_pick', 'rule_preparation'])
  })

  it('says when the limit was reached and when work continues, in the person\'s own zone', () => {
    const reached = new Date('2026-10-06T18:10:00Z')
    expect(limitSentence(reached, nextUtcMidnight(reached), 'America/New_York')).toBe(
      "Cello reached today's free model limit at 14:10. Drafting and preparing continue at 20:00 your time."
    )
    expect(limitSentence(reached, nextUtcMidnight(reached), 'UTC')).toContain('continue at 00:00 your time')
  })
})
