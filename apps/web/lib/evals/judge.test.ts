// meteredJudgeClient's own contract: the fetch wrapper reserves BEFORE the
// real request and settles AFTER it, and a null judge score
// reaches logHarnessError rather than surfacing silently. ZERO real network
// calls or database writes — lib/harness/spend is fully mocked (same idiom
// as lib/harness/llm.test.ts) and every HTTP response is a hand-built
// Response, same idiom as lib/ats/greenhouse.test.ts.
//
// The "both judges share one client" test below is also the mutation-check
// evidence app/api/outreach/judge/route.ts's comment points at: it is what
// let that route drop its own manual spend call without double-billing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'
import { runInTraceContext, SpanBuffer, type SpanRecord } from '../trace/spans'

const reserveSpendMock = vi.fn()
const settleSpendMock = vi.fn()
const RESERVATION = { id: 'res-1', userId: 'user-1', model: 'm', estimateUsd: 0.01 }
vi.mock('../harness/spend', async (importOriginal) => ({
  // estimateCostUsd stays real: the span's costUsd is asserted below.
  ...(await importOriginal<typeof import('../harness/spend')>()),
  reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
  settleSpend: (...args: unknown[]) => settleSpendMock(...args),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('../observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

import { MissingKeyError } from '../harness/llm'
import { meteredJudgeClient, toEvalResult, JUDGE_MODEL } from './judge'

/** Captures every trace_spans row a flush() inserts; every other table is unexpected. */
const insertedSpans: Record<string, unknown>[] = []
const FAKE_ADMIN = {
  from: (name: string) => {
    if (name !== 'trace_spans') throw new Error(`FAKE_ADMIN: unexpected table "${name}"`)
    return {
      insert: async (rows: Record<string, unknown>[]) => {
        insertedSpans.push(...rows)
        return { error: null }
      },
    }
  },
} as unknown as AdminClient
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
  insertedSpans.length = 0
  reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
  settleSpendMock.mockReset().mockResolvedValue(undefined)
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

  it('reserves before the request and settles real usage only after the response', async () => {
    const order: string[] = []
    reserveSpendMock.mockImplementation(async () => {
      order.push('reserve')
      return RESERVATION
    })
    settleSpendMock.mockImplementation(async () => {
      order.push('settle')
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
      max_tokens: 300,
    })

    expect(order).toEqual(['reserve', 'fetch', 'settle'])
    expect(reserveSpendMock).toHaveBeenCalledWith(
      FAKE_ADMIN,
      expect.objectContaining({ userId: 'user-1', model: JUDGE_MODEL, maxTokens: 2000, traceId: expect.any(String) })
    )
    expect(settleSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, RESERVATION, {
      model: JUDGE_MODEL,
      promptTokens: 111,
      completionTokens: 22,
      costUsd: undefined,
    })
  })

  it('a :free judge model reserves rung R3 and a paid one R4, both under the step judge', async () => {
    globalThis.fetch = vi.fn(async () => chatCompletion({ prompt_tokens: 1, completion_tokens: 1 })) as unknown as typeof fetch
    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    const body = { messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 100 }

    await client.chat.completions.create({ ...body, model: 'google/gemma-4-31b-it:free' })
    expect(reserveSpendMock.mock.calls[0][1]).toMatchObject({ rung: 'R3', step: 'judge' })

    await client.chat.completions.create({ ...body, model: JUDGE_MODEL })
    expect(reserveSpendMock.mock.calls[1][1]).toMatchObject({ rung: 'R4', step: 'judge' })
  })

  it('settles the provider-reported cost when the response carries usage.cost', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        id: 'c',
        model: JUDGE_MODEL,
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.000321 },
      })
    ) as unknown as typeof fetch
    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    expect(settleSpendMock.mock.calls[0][2]).toMatchObject({ costUsd: 0.000321 })
    expect(insertedSpans[0]).toMatchObject({ attributes: { costUsd: 0.000321 } })
  })

  it('never reaches fetch or settle when the reservation refuses', async () => {
    // The reservation rejects on every attempt (the OpenAI SDK retries a
    // thrown fetch a few times before giving up and wrapping the original
    // error as APIConnectionError('Connection error.', {cause}); the point
    // this test pins is that `fetch` and settle are never reached, not the
    // SDK's own retry/wrapping behavior).
    reserveSpendMock.mockRejectedValue(new Error('cap hit'))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await expect(
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(settleSpendMock).not.toHaveBeenCalled()
  })

  it('falls back to the conservative estimate when the response carries no usage field', async () => {
    globalThis.fetch = vi.fn(async () => chatCompletion()) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })

    expect(settleSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, RESERVATION, {
      model: JUDGE_MODEL,
      promptTokens: 2000,
      completionTokens: 300,
    })
  })

  it('emits one llm span per request with model, tokens, cost and user, flushed to trace_spans', async () => {
    globalThis.fetch = vi.fn(async () =>
      chatCompletion({ prompt_tokens: 1000, completion_tokens: 200 })
    ) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })

    expect(insertedSpans).toHaveLength(1)
    expect(insertedSpans[0]).toMatchObject({
      user_id: 'user-1',
      kind: 'llm',
      name: 'llm',
      status: 'ok',
      attributes: {
        model: JUDGE_MODEL,
        promptTokens: 1000,
        completionTokens: 200,
        tokensUsed: 1200,
        // haiku-4.5: $1 in, $5 out per M tokens
        costUsd: 0.002,
        metered: true,
        userId: 'user-1',
        source: 'judge',
      },
    })
  })

  it('a 402 is an error span, a visible warning, and still reaches the SDK as a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'Insufficient credits' } }, 402)
    ) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await expect(
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ status: 402 })

    expect(insertedSpans).toHaveLength(1)
    expect(insertedSpans[0]).toMatchObject({ status: 'error', attributes: { model: JUDGE_MODEL, error: expect.stringContaining('402') } })
    expect(settleSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, RESERVATION, { failed: { status: 402 } })
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[llm:fallback]'))
    expect(line).toBeDefined()
    expect(line).toContain('"scope":"judge"')
    expect(line).toContain('"status":402')
    expect(line).toContain('Insufficient credits')
  })

  it('settles a non-ok response at zero, never at the estimate', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400)) as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await expect(
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow()

    expect(settleSpendMock).toHaveBeenCalledTimes(1)
    expect(settleSpendMock).toHaveBeenCalledWith(FAKE_ADMIN, RESERVATION, { failed: { status: 400 } })
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

  it('SETS max_tokens when the request carries none, so every judge call has a ceiling to reserve against', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => chatCompletion({ prompt_tokens: 10, completion_tokens: 5 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }] })

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens).toBe(2000)
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

describe('judge requests in Langfuse', () => {
  const classifier = (text: string): Response => {
    const isClosedQA = text.includes('Criterion')
    const args = isClosedQA ? { choice: 'Y', reasons: 'specific enough' } : { choice: 'C', reasons: 'fully grounded' }
    return jsonResponse({
      model: JUDGE_MODEL,
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'select_choice', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    })
  }
  const configure = () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    vi.stubEnv('LANGFUSE_CONTENT_USER_IDS', 'u1,u,me,user-1')
  }
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('the generation carries the sampling parameters the request actually sent (max_tokens after the clamp)', async () => {
    configure()
    globalThis.fetch = vi.fn(async () => classifier('Criterion')) as unknown as typeof fetch
    const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false })
    const client = meteredJudgeClient(FAKE_ADMIN, 'user-1', { openrouter: 'sk-or-test' })
    await runInTraceContext({ buffer, parentSpanId: 'root', runId: null }, () =>
      client.chat.completions.create({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64000, temperature: 0 })
    )
    const [row] = (buffer as unknown as { pending: SpanRecord[] }).pending
    expect(row.lf?.modelParameters).toEqual({ temperature: 0, max_tokens: 2000 })
  })
})
