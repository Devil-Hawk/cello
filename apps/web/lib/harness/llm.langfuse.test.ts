// End-to-end for prompt monitoring: the REAL callLlm / callEmbedding ->
// SpanBuffer.flush -> Langfuse replay chain, with only the provider, the spend
// ledger and the admin client faked and the OTLP exporter swapped for an
// InMemorySpanExporter. Pins what matters: every llm call becomes a generation
// with model, usage and OUR cost, the prompt and completion reach Langfuse
// (redacted) and NEVER Postgres, an unmetered call costs zero, embeddings are
// observations that never touch trace_spans, and the kill switch keeps the
// text out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
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
const callLocalServerMock = vi.fn()
vi.mock('./providers/local-server', () => ({
  callLocalServer: (...args: unknown[]) => callLocalServerMock(...args),
}))
const embedMock = vi.fn()
vi.mock('./providers/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/embeddings')>()
  return { ...actual, callOpenRouterEmbedding: (...args: unknown[]) => embedMock(...args) }
})

import { __setLangfuseForTest } from '../observability/langfuse'
import { callEmbedding, callLlm } from './llm'

const keys = { openrouter: 'or-key', userId: 'user-1', isDemo: false } as unknown as DecryptedApiKeys
const PROMPT = 'Tailor my CV. Contact: jane.doe@example.com, key sk-or-v1-abcdefghijklmnopqrstuv'
const COMPLETION = 'Done. I wrote to jane.doe@example.com.'

let exporter: InMemorySpanExporter
const spans = (): ReadableSpan[] => exporter.getFinishedSpans()
const gen = () => {
  const s = spans().find((x) => x.attributes['langfuse.observation.type'] === 'generation')
  if (!s) throw new Error(`no generation among ${spans().map((x) => x.name).join(',')}`)
  return s
}
const attr = (s: ReadableSpan, k: string) => s.attributes[k]

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

beforeEach(() => {
  insertCalls.length = 0
  exporter = new InMemorySpanExporter()
  __setLangfuseForTest({ exporter })
  callOpenRouterMock.mockReset()
  callOpenRouterMock.mockResolvedValue({
    content: COMPLETION,
    tokensUsed: 150,
    promptTokens: 100,
    completionTokens: 50,
    model: 'anthropic/claude-sonnet-5',
    finishReason: 'stop',
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('callLlm -> trace_spans + Langfuse generation', () => {
  it('a prompt document is the generation version (its content hash) plus prompt_name and prompt_hash metadata', async () => {
    configure()
    await callLlm(keys, { name: 'tailor-cv', prompt: 'x', promptRef: { name: 'cv_tailor', hash: 'a1b2c3d4' } })
    const g = gen()
    expect(attr(g, 'langfuse.version')).toBe('a1b2c3d4')
    expect(attr(g, 'langfuse.observation.metadata.prompt_name')).toBe('cv_tailor')
    expect(attr(g, 'langfuse.observation.metadata.prompt_hash')).toBe('a1b2c3d4')
    // metadata only: nothing about the prompt text rides along, and Postgres never sees it
    expect(JSON.stringify(insertCalls)).not.toContain('a1b2c3d4')
  })

  it('an inline prompt has no version (the release stands in) and no prompt metadata', async () => {
    configure()
    await callLlm(keys, { name: 'plan-copilot-step', prompt: 'x' })
    const g = gen()
    expect(attr(g, 'langfuse.version')).toBeUndefined()
    expect(attr(g, 'langfuse.observation.metadata.prompt_name')).toBeUndefined()
  })

  it('one generation with name, model, usage and OUR price table cost; the prompt never reaches Postgres', async () => {
    configure()
    await callLlm(keys, { name: 'tailor-cv', system: 'You are a CV editor.', prompt: PROMPT, maxTokens: 800, temperature: 0.2, json: true })

    // Postgres: one llm row, metrics only, nothing from the prompt.
    expect(insertCalls).toHaveLength(1)
    const stored = JSON.stringify(insertCalls)
    for (const leak of ['Tailor my CV', 'Done. I wrote', 'CV editor', 'lf', 'persist']) expect(stored).not.toContain(leak)
    expect(insertCalls[0][0]).toMatchObject({ kind: 'llm', name: 'llm', attributes: { model: 'anthropic/claude-sonnet-5', promptTokens: 100 } })

    // Langfuse: a generation with the full picture.
    expect(spans()).toHaveLength(1)
    const g = gen()
    expect(g.name).toBe('tailor-cv')
    expect(attr(g, 'langfuse.observation.model.name')).toBe('anthropic/claude-sonnet-5')
    expect(JSON.parse(String(attr(g, 'langfuse.observation.usage_details')))).toEqual({ input: 100, output: 50, total: 150 })
    // sonnet-5 is 2 / 10 USD per million tokens in lib/harness/spend.ts
    const cost = JSON.parse(String(attr(g, 'langfuse.observation.cost_details')))
    expect(cost.input).toBeCloseTo((100 / 1e6) * 2, 10)
    expect(cost.output).toBeCloseTo((50 / 1e6) * 10, 10)
    expect(JSON.parse(String(attr(g, 'langfuse.observation.model.parameters')))).toEqual({ max_tokens: 800, temperature: 0.2, json: 'true' })
    expect(attr(g, 'langfuse.observation.metadata.provider')).toBe('openrouter')
    expect(attr(g, 'langfuse.observation.metadata.metered')).toBe('true')
    expect(attr(g, 'langfuse.observation.metadata.finish_reason')).toBe('stop')
    expect(attr(g, 'langfuse.observation.metadata.cost_estimated')).toBeUndefined()
    expect(attr(g, 'user.id')).toBe('user-1')
    expect(attr(g, 'langfuse.trace.name')).toBe('tailor-cv') // a standalone call is its own root
    expect(attr(g, 'langfuse.trace.tags')).toEqual(['feature:tailor-cv', 'owner'])

    // Readable messages, secrets and emails masked.
    const input = JSON.parse(String(attr(g, 'langfuse.observation.input')))
    expect(input.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
    expect(input[0].content).toBe('You are a CV editor.')
    expect(input[1].content).toContain('Tailor my CV')
    const output = JSON.parse(String(attr(g, 'langfuse.observation.output')))
    expect(output).toMatchObject({ role: 'assistant' })
    expect(output.content).toContain('Done. I wrote')
    const sent = JSON.stringify(spans().map((s) => s.attributes))
    expect(sent).not.toContain('jane.doe@example.com')
    expect(sent).not.toContain('sk-or-v1-abcdefghijklmnopqrstuv')
  })

  it('with no name the generation is call-llm; messages[] replaces prompt like the provider does', async () => {
    configure()
    await callLlm(keys, { system: 'sys', messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }], prompt: 'ignored' })
    const input = JSON.parse(String(attr(gen(), 'langfuse.observation.input')))
    expect(gen().name).toBe('call-llm')
    expect(input.map((m: { content: string }) => m.content)).toEqual(['sys', 'first', 'second'])
  })

  it('an unmetered backend (local server) has explicit zero cost so Langfuse infers none', async () => {
    configure()
    callLocalServerMock.mockResolvedValue({ content: 'hi', tokensUsed: 30, promptTokens: 20, completionTokens: 10, model: 'llama3' })
    const local = { userId: 'user-1', isDemo: false, provider: { active: 'local-server', localServerBaseUrl: 'http://localhost:1234' } } as unknown as DecryptedApiKeys
    await callLlm(local, { prompt: 'hello', name: 'draft-follow-up' })
    const g = gen()
    expect(JSON.parse(String(attr(g, 'langfuse.observation.cost_details')))).toEqual({ input: 0, output: 0 })
    expect(JSON.parse(String(attr(g, 'langfuse.observation.usage_details')))).toEqual({ input: 20, output: 10, total: 30 })
    expect(attr(g, 'langfuse.observation.metadata.metered')).toBe('false')
    expect(attr(g, 'langfuse.observation.metadata.provider')).toBe('local-server')
  })

  it('an unlisted model is priced with the fallback and flagged cost_estimated', async () => {
    configure()
    callOpenRouterMock.mockResolvedValue({ content: 'x', tokensUsed: 10, promptTokens: 6, completionTokens: 4, model: 'some/new-model' })
    await callLlm(keys, { prompt: 'hello' })
    expect(attr(gen(), 'langfuse.observation.metadata.cost_estimated')).toBe('true')
  })

  it('a truncated reply is a WARNING with the code, not an error', async () => {
    configure()
    callOpenRouterMock.mockResolvedValue({ content: 'cut', tokensUsed: 10, promptTokens: 6, completionTokens: 4, model: 'anthropic/claude-sonnet-5', finishReason: 'length' })
    await callLlm(keys, { prompt: 'hello' })
    expect(attr(gen(), 'langfuse.observation.level')).toBe('WARNING')
    expect(attr(gen(), 'langfuse.observation.status_message')).toBe('truncated')
  })

  it('LANGFUSE_CAPTURE_CONTENT=0: metrics and cost still go, no prompt or completion anywhere', async () => {
    configure()
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    await callLlm(keys, { prompt: PROMPT, system: 'secret system prompt' })
    const g = gen()
    expect(attr(g, 'langfuse.observation.input')).toBeUndefined()
    expect(attr(g, 'langfuse.observation.output')).toBeUndefined()
    expect(JSON.parse(String(attr(g, 'langfuse.observation.usage_details'))).total).toBe(150)
    const sent = JSON.stringify(spans().map((s) => ({ a: s.attributes, s: s.status })))
    for (const leak of ['Tailor my CV', 'secret system prompt', 'Done. I wrote']) expect(sent).not.toContain(leak)
  })

  it('a demo workspace sends no text by default (isDemo from the key loader) and an unknown flag counts as demo', async () => {
    configure()
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
    for (const isDemo of [true, undefined]) {
      exporter.reset()
      await callLlm({ ...keys, isDemo } as DecryptedApiKeys, { prompt: PROMPT })
      expect(attr(gen(), 'langfuse.observation.input')).toBeUndefined()
      expect(attr(gen(), 'langfuse.trace.tags')).toEqual(['feature:call-llm', 'demo'])
    }
  })

  it('a failing call is an ERROR generation: code only in the status, no message, still the redacted prompt', async () => {
    configure()
    callOpenRouterMock.mockRejectedValue(Object.assign(new Error('bad request for Bearer abc.def.ghi'), { status: 400 }))
    await expect(callLlm(keys, { prompt: PROMPT })).rejects.toThrow()
    const g = gen()
    expect(attr(g, 'langfuse.observation.level')).toBe('ERROR')
    expect(String(attr(g, 'langfuse.observation.status_message'))).toContain('http_400')
    expect(JSON.stringify(g.attributes)).not.toContain('abc.def.ghi')
    expect(g.status.message ?? '').toBe('')
    expect(JSON.parse(String(attr(g, 'langfuse.observation.input')))[0].content).toContain('Tailor my CV')
    expect(attr(g, 'langfuse.observation.output')).toBeUndefined()
    expect(insertCalls[0][0]).toMatchObject({ status: 'error' })
  })

  it('unconfigured: nothing exported, Postgres row unchanged', async () => {
    await callLlm(keys, { prompt: PROMPT })
    expect(spans()).toHaveLength(0)
    expect(insertCalls).toHaveLength(1)
  })
})

describe('callEmbedding -> Langfuse embedding observation', () => {
  const texts = ['resume text that is private', 'another private chunk']

  beforeEach(() => {
    embedMock.mockReset()
    embedMock.mockResolvedValue({ embeddings: [[0.1], [0.2]], model: 'openai/text-embedding-3-small', promptTokens: 1000 })
  })

  it('one embedding observation with model, usage, cost, counts only; never a trace_spans row', async () => {
    configure()
    const out = await callEmbedding(keys, { texts, name: 'embed-chunks' })
    expect(out.embeddings).toHaveLength(2)
    expect(insertCalls).toHaveLength(0) // Langfuse-only: no Postgres insert at all
    expect(spans()).toHaveLength(1)
    const e = spans()[0]
    expect(e.name).toBe('embed-chunks')
    expect(attr(e, 'langfuse.observation.type')).toBe('embedding')
    expect(attr(e, 'langfuse.observation.model.name')).toBe('openai/text-embedding-3-small')
    expect(JSON.parse(String(attr(e, 'langfuse.observation.usage_details')))).toEqual({ input: 1000 })
    expect(JSON.parse(String(attr(e, 'langfuse.observation.cost_details'))).input).toBeCloseTo((1000 / 1e6) * 0.02, 10)
    expect(JSON.parse(String(attr(e, 'langfuse.observation.input')))).toEqual({ count: 2, chars: texts[0].length + texts[1].length })
    expect(JSON.stringify(spans().map((s) => s.attributes))).not.toContain('private')
  })

  it('nested under a graph buffer the embedding joins the trace as a child and the buffer owner flushes', async () => {
    configure()
    const { SpanBuffer, runInTraceContext, withSpan } = await import('../trace/spans')
    const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false })
    await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'graph', name: 'copilot' }, (rootId) =>
      runInTraceContext({ buffer, parentSpanId: rootId, runId: null }, () => callEmbedding(keys, { texts, name: 'embed-query' }))
    )
    expect(spans()).toHaveLength(0) // not flushed yet: the owner flushes
    await buffer.flush({ from: () => ({ insert: async (r: unknown[]) => (insertCalls.push(r as never), { error: null }) }) } as never)
    expect(spans()).toHaveLength(2)
    const root = spans().find((s) => s.name === 'copilot')!
    const emb = spans().find((s) => s.name === 'embed-query')!
    expect(emb.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(insertCalls[0]).toHaveLength(1) // only the graph row
  })

  it('unconfigured: no observation, no insert, same result', async () => {
    const out = await callEmbedding(keys, { texts })
    expect(out.embeddings).toHaveLength(2)
    expect(spans()).toHaveLength(0)
    expect(insertCalls).toHaveLength(0)
  })

  it('a failing embedding call is an ERROR observation with a code and rethrows', async () => {
    configure()
    embedMock.mockRejectedValue(Object.assign(new Error('upstream said no: sk-or-v1-abcdefghijklmnopqrstuv'), { status: 502 }))
    await expect(callEmbedding(keys, { texts })).rejects.toThrow()
    const e = spans()[0]
    expect(attr(e, 'langfuse.observation.level')).toBe('ERROR')
    expect(JSON.stringify(e.attributes)).not.toContain('sk-or-v1')
  })
})
