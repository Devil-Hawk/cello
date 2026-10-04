// End-to-end for prompt monitoring: the REAL callLlm -> SpanBuffer.flush ->
// Langfuse mirror chain, with only the provider, the spend ledger, the admin
// client and the `langfuse` package faked. Pins the three promises that
// matter: every llm call becomes a generation with model/usage/cost, the
// prompt and completion reach Langfuse (redacted) and NEVER Postgres, and
// LANGFUSE_CAPTURE_CONTENT=0 keeps them out of Langfuse too.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from './types'

const insertCalls: Record<string, unknown>[][] = []
vi.mock('./supabase-admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'trace_spans') throw new Error(`unexpected table ${table}`)
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          insertCalls.push(rows)
          return { error: null }
        },
      }
    },
  }),
}))

vi.mock('./spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./spend')>()
  return { ...actual, assertWithinBudget: async () => undefined, recordSpend: async () => undefined }
})

const callOpenRouterMock = vi.fn()
vi.mock('./providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

const generationMock = vi.fn()
const LangfuseCtor = vi.fn().mockImplementation(() => ({
  trace: vi.fn(),
  span: vi.fn(),
  generation: generationMock,
  flushAsync: async () => undefined,
}))
vi.mock('langfuse', () => ({ Langfuse: LangfuseCtor }))

import { callLlm } from './llm'

const keys = { openrouter: 'or-key', userId: 'user-1' } as unknown as DecryptedApiKeys
const PROMPT = 'Tailor my CV. Contact: jane.doe@example.com, key sk-or-v1-abcdefghijklmnopqrstuv'
const COMPLETION = 'Done. I wrote to jane.doe@example.com.'

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

beforeEach(() => {
  insertCalls.length = 0
  generationMock.mockClear()
  LangfuseCtor.mockClear()
  callOpenRouterMock.mockReset()
  callOpenRouterMock.mockResolvedValue({
    content: COMPLETION,
    tokensUsed: 150,
    promptTokens: 100,
    completionTokens: 50,
    model: 'anthropic/claude-sonnet-5',
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('callLlm -> trace_spans + Langfuse', () => {
  it('a call produces one generation with model, usage and cost; the prompt text never reaches Postgres', async () => {
    configure()
    await callLlm(keys, { system: 'You are a CV editor.', prompt: PROMPT })

    // Postgres: one llm row, metrics only.
    expect(insertCalls).toHaveLength(1)
    const stored = JSON.stringify(insertCalls)
    expect(stored).not.toContain('Tailor my CV')
    expect(stored).not.toContain('Done. I wrote')
    expect(stored).not.toContain('CV editor')
    expect(insertCalls[0][0]).not.toHaveProperty('content')
    expect(insertCalls[0][0]).toMatchObject({ kind: 'llm', attributes: { model: 'anthropic/claude-sonnet-5', promptTokens: 100 } })

    // Langfuse: a generation with the full picture.
    expect(generationMock).toHaveBeenCalledTimes(1)
    const gen = generationMock.mock.calls[0][0]
    expect(gen.model).toBe('anthropic/claude-sonnet-5')
    expect(gen.usageDetails).toEqual({ input: 100, output: 50, total: 150 })
    expect(gen.costDetails.total).toBeGreaterThan(0)
    expect(gen.input.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
    expect(gen.input[0].content).toBe('You are a CV editor.')
    expect(gen.input[1].content).toContain('Tailor my CV')
    expect(gen.output).toContain('Done. I wrote')
    // ...redacted.
    const sent = JSON.stringify([gen.input, gen.output])
    expect(sent).not.toContain('jane.doe@example.com')
    expect(sent).not.toContain('sk-or-v1-abcdefghijklmnopqrstuv')
  })

  it('messages[] takes the place of prompt, exactly as the provider builds the request', async () => {
    configure()
    await callLlm(keys, {
      system: 'sys',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      prompt: 'ignored when messages are given',
    })
    const gen = generationMock.mock.calls[0][0]
    expect(gen.input.map((m: { content: string }) => m.content)).toEqual(['sys', 'first', 'second'])
  })

  it('LANGFUSE_CAPTURE_CONTENT=0: generation still has metrics but no prompt or completion', async () => {
    configure()
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    await callLlm(keys, { prompt: PROMPT })
    const gen = generationMock.mock.calls[0][0]
    expect(gen.input).toBeUndefined()
    expect(gen.output).toBeUndefined()
    expect(gen.usageDetails.total).toBe(150)
  })

  it('a failing call is an ERROR generation that still carries the (redacted) prompt', async () => {
    configure()
    callOpenRouterMock.mockRejectedValue(Object.assign(new Error('bad request for Bearer abc.def.ghi'), { status: 400 }))
    await expect(callLlm(keys, { prompt: PROMPT })).rejects.toThrow()
    const gen = generationMock.mock.calls[0][0]
    expect(gen.level).toBe('ERROR')
    expect(gen.statusMessage).not.toContain('abc.def.ghi')
    expect(gen.input[0].content).toContain('Tailor my CV')
    expect(gen.output).toBeUndefined()
  })

  it('unconfigured: no client, nothing captured, Postgres row unchanged', async () => {
    await callLlm(keys, { prompt: PROMPT })
    expect(LangfuseCtor).not.toHaveBeenCalled()
    expect(insertCalls).toHaveLength(1)
  })
})
