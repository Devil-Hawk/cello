// parseEmailWithAI goes through the REAL callLlm, with only its edges faked
// (the OpenRouter provider call, the admin client, and spend's two DB-touching
// functions), so these tests prove the budget check, the spend record and the
// trace span actually happen, not just that a mock was called. ZERO network.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callOpenRouterMock = vi.fn()
vi.mock('../harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

const reserveSpendMock = vi.fn()
const settleSpendMock = vi.fn()
const RESERVATION = { id: 'res-1', userId: 'user-1', model: 'm', estimateUsd: 0.01 }
vi.mock('../harness/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/spend')>()),
  reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
  settleSpend: (...args: unknown[]) => settleSpendMock(...args),
}))

const insertedSpans: Record<string, unknown>[] = []
const fakeAdmin = {
  from: (name: string) => {
    if (name !== 'trace_spans') throw new Error(`unexpected table "${name}"`)
    return {
      insert: async (rows: Record<string, unknown>[]) => {
        insertedSpans.push(...rows)
        return { error: null }
      },
    }
  },
}
vi.mock('../harness/supabase-admin', () => ({ createAdminClient: () => fakeAdmin }))

import { BudgetCapError } from '../harness/spend'
import { MissingKeyError } from '../harness/llm'
import type { DecryptedApiKeys } from '../harness/types'
import { CLASSIFY_MODEL, classifyWithPatterns, parseEmailWithAI } from './classify'

const FROM = 'recruiting@acme.com'
const SUBJECT = 'Thank you for applying to Senior Engineer'
const BODY = 'Thank you for applying. Application received.'
const REF = new Date('2026-10-01T00:00:00Z')

const AI_JSON = JSON.stringify({
  isJobRelated: true,
  employerName: 'Acme',
  employerDomain: 'acme.com',
  jobTitle: 'Senior Engineer',
  status: 'applied',
  careerPageUrl: null,
  interviewDateTime: null,
  confidence: 0.95,
  reasoning: 'direct confirmation',
})

function llmResult(content: string) {
  return { content, tokensUsed: 600, promptTokens: 500, completionTokens: 100, model: CLASSIFY_MODEL }
}

const KEYS: DecryptedApiKeys = { openrouter: 'sk-or-test', userId: 'user-1' }

function fallbackLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[llm:fallback]'))
}

beforeEach(() => {
  callOpenRouterMock.mockReset()
  reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
  settleSpendMock.mockReset().mockResolvedValue(undefined)
  insertedSpans.length = 0
})

describe('parseEmailWithAI is metered and traced through callLlm', () => {
  it('checks the budget, records spend on the cheap classifier model, and emits an llm span', async () => {
    callOpenRouterMock.mockResolvedValue(llmResult(AI_JSON))

    const parsed = await parseEmailWithAI(FROM, SUBJECT, BODY, KEYS, REF)

    expect(parsed).toMatchObject({ companyName: 'Acme', status: 'applied', isJobRelated: true, confidence: 0.95 })
    // The intentional cheap model and the exact request shape survive the move.
    expect(callOpenRouterMock).toHaveBeenCalledTimes(1)
    expect(callOpenRouterMock.mock.calls[0][1]).toMatchObject({
      model: 'google/gemini-2.0-flash-001',
      maxTokens: 350,
      temperature: 0.1,
      reasoning: { effort: 'none' },
    })
    expect(reserveSpendMock).toHaveBeenCalledWith(fakeAdmin, expect.objectContaining({ userId: 'user-1', model: CLASSIFY_MODEL }))
    expect(settleSpendMock).toHaveBeenCalledWith(fakeAdmin, RESERVATION, { model: CLASSIFY_MODEL, promptTokens: 500, completionTokens: 100, costUsd: undefined })
    expect(insertedSpans).toHaveLength(1)
    expect(insertedSpans[0]).toMatchObject({
      user_id: 'user-1',
      kind: 'llm',
      status: 'ok',
      attributes: { model: CLASSIFY_MODEL, promptTokens: 500, completionTokens: 100, metered: true, userId: 'user-1' },
    })
  })

  it('a spent budget refuses BEFORE the provider is called and falls back to patterns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reserveSpendMock.mockRejectedValue(new BudgetCapError(10, 10))

    const parsed = await parseEmailWithAI(FROM, SUBJECT, BODY, KEYS, REF)

    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(settleSpendMock).not.toHaveBeenCalled()
    expect(parsed).toEqual(classifyWithPatterns(FROM, SUBJECT, BODY, REF))
    const lines = fallbackLines(warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"scope":"gmail-classify"')
    expect(lines[0]).toContain('BudgetCapError')
  })
})

describe('parseEmailWithAI fallbacks still degrade to the regex classifier, and say why', () => {
  const expected = () => classifyWithPatterns(FROM, SUBJECT, BODY, REF)

  it('a provider 402 (out of credits) falls back, settles at zero, does not retry, and warns with the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockRejectedValue(Object.assign(new Error('402 Insufficient credits'), { status: 402 }))

    const parsed = await parseEmailWithAI(FROM, SUBJECT, BODY, KEYS, REF)

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1)
    expect(settleSpendMock).toHaveBeenCalledWith(fakeAdmin, RESERVATION, { failed: expect.objectContaining({ status: 402 }) })
    expect(parsed).toEqual(expected())
    const lines = fallbackLines(warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"status":402')
    expect(lines[0]).toContain('"fallback":"regex-patterns"')
  })

  it('a missing key (provider throws MissingKeyError) falls back without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockRejectedValue(new MissingKeyError('No OpenRouter API key configured'))

    const parsed = await parseEmailWithAI(FROM, SUBJECT, BODY, { userId: 'user-1' }, REF)

    expect(parsed).toEqual(expected())
    expect(fallbackLines(warn)[0]).toContain('MissingKeyError')
  })

  it('unparseable model output falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockResolvedValue(llmResult('sorry, I cannot help with that'))

    const parsed = await parseEmailWithAI(FROM, SUBJECT, BODY, KEYS, REF)

    expect(parsed).toEqual(expected())
    expect(fallbackLines(warn)).toHaveLength(1)
  })

  it('the warning never carries the email body or subject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockRejectedValue(new Error('boom'))

    await parseEmailWithAI(FROM, 'secret subject line', 'secret body text', KEYS, REF)

    const line = fallbackLines(warn)[0]
    expect(line).not.toContain('secret subject line')
    expect(line).not.toContain('secret body text')
  })
})
