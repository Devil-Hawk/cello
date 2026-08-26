// meteredJudgeClient's own contract: the fetch wrapper metres BEFORE the
// real request and records AFTER a successful one, and a null judge score
// reaches logHarnessError rather than surfacing silently. ZERO real network
// calls or database writes — lib/harness/spend is fully mocked (same idiom
// as lib/harness/llm.test.ts) and every HTTP response is a hand-built
// Response, same idiom as lib/ats/greenhouse.test.ts.
//
// The "both judges share one client" test below is also the mutation-check
// evidence app/api/outreach/judge/route.ts's comment points at: it is what
// let that route drop its own manual recordSpend without double-billing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'

const assertWithinBudgetMock = vi.fn()
const recordSpendMock = vi.fn()
vi.mock('../harness/spend', () => ({
  assertWithinBudget: (...args: unknown[]) => assertWithinBudgetMock(...args),
  recordSpend: (...args: unknown[]) => recordSpendMock(...args),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('../observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

import { MissingKeyError } from '../harness/llm'
import { meteredJudgeClient, judgeGroundedness, judgeSpecificity, toEvalResult, JUDGE_MODEL } from './judge'

const FAKE_ADMIN = {} as AdminClient
const realFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A minimal-but-valid non-streaming chat completion for a raw client call —
 *  no tool_calls, since these tests exercise the fetch wrapper, not autoevals'
 *  own response parsing (that's the "shares one client" test below). */
function chatCompletion(usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return jsonResponse({
    id: 'chatcmpl-1',
    model: JUDGE_MODEL,
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  })
}

beforeEach(() => {
  assertWithinBudgetMock.mockReset().mockResolvedValue(undefined)
  recordSpendMock.mockReset().mockResolvedValue(undefined)
  logHarnessErrorMock.mockReset()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('meteredJudgeClient', () => {
  it('throws MissingKeyError when apiKeys.openrouter is not configured', () => {
    expect(() => meteredJudgeClient(FAKE_ADMIN, 'user-1', {})).toThrow(MissingKeyError)
  })

  it('checks budget before the request and records real usage only after a successful response', async () => {
    const order: string[] = []
    assertWithinBudgetMock.mockImplementation(async () => {
      order.push('assert')
    })
    recordSpendMock.mockImplementation(async () => {
      order.push('record')
    })
    const fetchMock = vi.fn(async () => {
      order.push('fetch')
      return chatCompletion({ prompt_tokens: 111, completion_tokens: 22 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(order).toEqual(['assert', 'fetch', 'record'])
    expect(assertWithinBudgetMock).toHaveBeenCalledWith(FAKE_ADMIN, 'user-1')
    expect(recordSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, 'user-1', JUDGE_MODEL, 111, 22)
  })

  it('never reaches fetch or recordSpend when assertWithinBudget refuses', async () => {
    // assertWithinBudget rejects on every attempt (the OpenAI SDK retries a
    // thrown fetch a few times before giving up and wrapping the original
    // error as APIConnectionError('Connection error.', {cause}) — the point
    // this test pins is that `fetch` and `recordSpend` are never reached,
    // not the SDK's own retry/wrapping behavior).
    assertWithinBudgetMock.mockRejectedValue(new Error('cap hit'))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await expect(
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
  })

  it('falls back to the conservative estimate when the response carries no usage field', async () => {
    globalThis.fetch = vi.fn(async () => chatCompletion()) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })

    expect(recordSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, 'user-1', JUDGE_MODEL, 2000, 300)
  })

  it('does not record spend for a non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400)) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await expect(
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow()

    expect(recordSpendMock).not.toHaveBeenCalled()
  })

  it('clamps an outgoing max_tokens above the ceiling before the request is sent', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => chatCompletion({ prompt_tokens: 10, completion_tokens: 5 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64000,
    })

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { max_tokens: number }
    expect(sentBody.max_tokens).toBe(2000)
  })

  it('leaves max_tokens under the ceiling untouched', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => chatCompletion({ prompt_tokens: 10, completion_tokens: 5 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 500,
    })

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { max_tokens: number }
    expect(sentBody.max_tokens).toBe(500)
  })

  // MUTATION CHECK (executed, not left to trust): commented out the
  // `clampJudgeMaxTokens(init)` call in meteredFetch (passed `init` straight
  // to `fetch` instead) — this test went red (`expected 64000 to be 2000`).
  // Reverted immediately.
})

describe('judgeGroundedness + judgeSpecificity share one meteredJudgeClient', () => {
  // Real autoevals (Factuality/ClosedQA), fake OpenRouter underneath — proves
  // the ROUTE can rely on the client alone for both budget checkpoints
  // (assert + record) across BOTH of its judge calls, without its own
  // separate recordSpend. Discriminates which template rendered by the
  // "[Criterion]:" marker ClosedQA's prompt carries and Factuality's doesn't.
  function classifierResponse(text: string): Response {
    const isClosedQA = text.includes('Criterion')
    const args = isClosedQA ? { choice: 'Y', reasons: 'specific enough' } : { choice: 'C', reasons: 'fully grounded' }
    return jsonResponse({
      model: JUDGE_MODEL,
      usage: { prompt_tokens: 50, completion_tokens: 10 },
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'select_choice', arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
  }

  it('meters both calls (2 asserts, 2 records) and both verdicts come back pass', async () => {
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return classifierResponse(JSON.stringify(body.messages))
    }) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    const [groundedness, specificity] = await Promise.all([
      judgeGroundedness(client, { draft: 'I led the migration.', sourceFacts: 'Led the migration.' }),
      judgeSpecificity(client, { draft: 'About Acme.', companyAndRole: 'Acme, Engineer' }),
    ])

    expect(groundedness.verdict).toBe('pass')
    expect(specificity.verdict).toBe('pass')
    expect(assertWithinBudgetMock).toHaveBeenCalledTimes(2)
    expect(recordSpendMock).toHaveBeenCalledTimes(2)
  })
})

describe('toEvalResult — score:null', () => {
  it('reports insufficient-data and logs via logHarnessError, attributing the given userId', () => {
    const result = toEvalResult('outreach groundedness', { score: null }, 0.5, 'user-42')

    expect(result.verdict).toBe('insufficient-data')
    expect(result.score).toBeNull()
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>]
    expect(ctx).toMatchObject({ agentType: 'judge', phase: 'judge', userId: 'user-42' })
  })

  it('still logs (without a userId) when the caller has none to attribute', () => {
    toEvalResult('outreach specificity', { score: null }, 0.6)
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>]
    expect(ctx.userId).toBeUndefined()
  })

  it('does not log for a real score', () => {
    const result = toEvalResult('outreach groundedness', { score: 0.9 }, 0.5, 'user-42')
    expect(result.verdict).toBe('pass')
    expect(logHarnessErrorMock).not.toHaveBeenCalled()
  })
})
