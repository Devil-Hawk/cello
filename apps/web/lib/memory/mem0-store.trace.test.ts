// How a memory write and a memory search look in Langfuse: the REAL callLlm /
// callEmbedding / observe chain under Mem0Store, with only mem0's Memory class,
// the providers and the spend ledger faked. Pins that a write is ONE
// `save-memory` observation with the fact extraction nested under it, that
// query embeddings fold into their parent instead of becoming observations of
// their own, and that "no embedding provider" is a normal fallback that never
// shows up as an ERROR.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { DecryptedApiKeys } from '../harness/types'

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({ loadApiKeys: (...a: unknown[]) => loadApiKeysMock(...a) }))
vi.mock('../harness/supabase-admin', () => ({ createAdminClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }))
vi.mock('../harness/spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/spend')>()
  return { ...actual, reserveSpend: async () => ({ id: 'res-1', userId: 'user-1', model: 'm', estimateUsd: 0.01 }), settleSpend: async () => undefined }
})
vi.mock('../harness/providers/openrouter', () => ({
  callOpenRouter: async () => ({ content: '{"facts":[]}', tokensUsed: 30, promptTokens: 20, completionTokens: 10, model: 'anthropic/claude-sonnet-5', finishReason: 'stop' }),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))
vi.mock('../harness/providers/local-cli', () => ({
  callLocalCli: async () => ({ content: '{"facts":[]}', tokensUsed: 30, promptTokens: 20, completionTokens: 10, model: 'claude-cli', finishReason: 'stop' }),
}))
vi.mock('../harness/providers/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/providers/embeddings')>()
  return { ...actual, callOpenRouterEmbedding: async () => ({ embeddings: [[0.1]], model: 'openai/text-embedding-3-small', promptTokens: 500 }) }
})

// Stands in for mem0ai's Memory: drives the same delegates real mem0 would
// (the extraction LLM, then an embedding), so the Langfuse tree is the real one.
type Delegates = {
  llm: { config: { model: { invoke(m: unknown[]): Promise<unknown> } } }
  embedder: { config: { model: { embedQuery(t: string): Promise<number[]> } } }
}
let delegates: Delegates
vi.mock('mem0ai/oss', () => ({
  Memory: class {
    vectorStore = { client: { query: async () => ({ rows: [] }) } }
    constructor(config: unknown) {
      delegates = config as Delegates
    }
    add = async () => {
      await delegates.llm.config.model.invoke([{ getType: () => 'human', content: 'I like Rust' }])
      await delegates.embedder.config.model.embedQuery('I like Rust')
      return { results: [{ id: 'm1', memory: 'Likes Rust' }] }
    }
    search = async () => {
      await delegates.embedder.config.model.embedQuery('rust')
      return { results: [{ id: 'm1', memory: 'Likes Rust', score: 0.9 }] }
    }
    get = async (id: string) => ({ id, memory: 'x' })
  },
}))

process.env.SUPABASE_DB_URL_DIRECT = 'postgresql://user:pass@db.example.com:5432/postgres?sslmode=require'

import { __setLangfuseForTest } from '../observability/langfuse'
import { SpanBuffer, runInTraceContext, withSpan } from '../trace/spans'
const { Mem0Store } = await import('./mem0-store')

const WITH_KEY = { openrouter: 'or-key', userId: 'user-1', isDemo: false } as unknown as DecryptedApiKeys
// A self-hosted user on a subscription CLI: chat works, no embedding provider.
const NO_EMBEDDER = { userId: 'user-1', isDemo: false, provider: { active: 'local-cli' } } as unknown as DecryptedApiKeys

let exporter: InMemorySpanExporter
const spans = (): ReadableSpan[] => exporter.getFinishedSpans()
const named = (n: string) => spans().find((s) => s.name === n)
const attr = (s: ReadableSpan | undefined, k: string) => s?.attributes[k]

/** Run `fn` inside a copilot-turn-like root, then flush like the graph owner does. */
async function inTurn(fn: () => Promise<unknown>) {
  const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false })
  const admin = { from: () => ({ insert: async () => ({ error: null }) }) } as never
  try {
    await withSpan(buffer, { parentSpanId: null, runId: null, kind: 'graph', name: 'copilot' }, (rootId) =>
      runInTraceContext({ buffer, parentSpanId: rootId, runId: null }, fn)
    )
  } finally {
    await buffer.flush(admin)
  }
}

beforeEach(() => {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
  exporter = new InMemorySpanExporter()
  __setLangfuseForTest({ exporter })
  loadApiKeysMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('memory write', () => {
  it('is one save-memory observation: extraction nests under it, embeddings fold into its metadata', async () => {
    loadApiKeysMock.mockResolvedValue(WITH_KEY)
    await inTurn(() => new Mem0Store().add('user-1', { messages: [{ role: 'user', content: 'I like Rust' }], scope: 'copilot', isDemo: false }))

    const save = named('save-memory')!
    expect(attr(save, 'langfuse.observation.type')).toBe('chain')
    expect(save.parentSpanContext?.spanId).toBe(named('copilot')!.spanContext().spanId)
    const extract = named('extract-memories')!
    expect(attr(extract, 'langfuse.observation.type')).toBe('generation')
    expect(extract.parentSpanContext?.spanId).toBe(save.spanContext().spanId)
    // no bare embedding observation anywhere: its usage is on the parent
    expect(spans().filter((s) => attr(s, 'langfuse.observation.type') === 'embedding')).toHaveLength(0)
    expect(attr(save, 'langfuse.observation.metadata.embedding_calls')).toBe('1')
    expect(attr(save, 'langfuse.observation.metadata.embedding_tokens')).toBe('500')
    expect(Number(attr(save, 'langfuse.observation.metadata.embedding_cost'))).toBeCloseTo((500 / 1e6) * 0.02, 10)
    expect(attr(save, 'langfuse.observation.metadata.memories')).toBe('1')
  })

  it('without an embedding provider the write is skipped quietly: no ERROR level anywhere', async () => {
    loadApiKeysMock.mockResolvedValue(NO_EMBEDDER)
    await expect(
      inTurn(() => new Mem0Store().add('user-1', { messages: [{ role: 'user', content: 'I like Rust' }], scope: 'copilot', isDemo: false }))
    ).rejects.toThrow(/No embedding provider/)

    const save = named('save-memory')!
    expect(attr(save, 'langfuse.observation.metadata.fallback')).toBe('no-embedding')
    expect(attr(save, 'langfuse.observation.level')).toBeUndefined()
    expect(attr(save, 'langfuse.observation.status_message')).toBeUndefined()
    // the extraction call still ran and is recorded; nothing is an embedding or an error
    expect(named('extract-memories')).toBeDefined()
    expect(spans().filter((s) => attr(s, 'langfuse.observation.type') === 'embedding')).toHaveLength(0)
    // only the test's own root carries the rethrown error (copilot catches it and stays clean)
    expect(spans().filter((s) => attr(s, 'langfuse.observation.level') === 'ERROR').map((s) => s.name)).toEqual(['copilot'])
  })
})

describe('memory search', () => {
  it('folds the query embedding into search-memory instead of a child observation', async () => {
    loadApiKeysMock.mockResolvedValue(WITH_KEY)
    await inTurn(() => new Mem0Store().search('user-1', 'rust'))
    const search = named('search-memory')!
    expect(attr(search, 'langfuse.observation.type')).toBe('retriever')
    expect(spans().map((s) => s.name).sort()).toEqual(['copilot', 'search-memory'])
    expect(attr(search, 'langfuse.observation.metadata.embedding_tokens')).toBe('500')
    expect(attr(search, 'langfuse.observation.level')).toBeUndefined()
  })

  it('without an embedding provider search-memory is DEFAULT level with fallback metadata and has no embedding child', async () => {
    loadApiKeysMock.mockResolvedValue(NO_EMBEDDER)
    await expect(inTurn(() => new Mem0Store().search('user-1', 'rust'))).rejects.toThrow(/No embedding provider/)
    const search = named('search-memory')!
    expect(attr(search, 'langfuse.observation.level')).toBeUndefined()
    expect(attr(search, 'langfuse.observation.status_message')).toBeUndefined()
    expect(attr(search, 'langfuse.observation.metadata.fallback')).toBe('no-embedding')
    expect(spans().filter((s) => attr(s, 'langfuse.observation.type') === 'embedding')).toHaveLength(0)
    // the turn itself carries the thrown error only because this test rethrows it;
    // in copilot the caller catches it and the root stays clean.
    expect(spans().filter((s) => attr(s, 'langfuse.observation.level') === 'ERROR').map((s) => s.name)).toEqual(['copilot'])
  })
})
