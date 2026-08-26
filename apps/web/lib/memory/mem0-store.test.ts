// Tests for lib/memory/mem0-store.ts — construction-time config shape
// (telemetry, search_path scoping, no baked-in keys), the demo write
// refusal, and that every method scopes through the userId it was given.
// mem0ai's Memory class is mocked so this file never opens a real
// connection — same fake-dependency style as lib/graph/unit.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../harness/types'

// --- mocks -------------------------------------------------------------------

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => ({ __fakeAdmin: true }),
}))

const callLlmMock = vi.fn()
const callEmbeddingMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return {
    ...actual,
    callLlm: (...args: unknown[]) => callLlmMock(...args),
    callEmbedding: (...args: unknown[]) => callEmbeddingMock(...args),
  }
})

/** Captures every Memory(config) construction and hands back a controllable
 *  fake instance — the same shape mem0ai/oss's real Memory exposes for the
 *  four methods MemoryStore calls. */
const memoryConstructions: unknown[] = []
type FakeMemoryItem = { id: string; memory: string; metadata?: Record<string, unknown> }
const fakeMemoryInstance = {
  add: vi.fn(async (): Promise<{ results: FakeMemoryItem[] }> => ({ results: [] })),
  search: vi.fn(async (): Promise<{ results: FakeMemoryItem[] }> => ({ results: [] })),
  getAll: vi.fn(async (): Promise<{ results: FakeMemoryItem[] }> => ({ results: [] })),
  deleteAll: vi.fn(async () => ({ message: 'ok' })),
  // Defaults to "every id add() claims to have written really exists" — the
  // honest case. Tests for the silent-failure path override this to return
  // null, reproducing mem0ai's own proven bug (see mem0-store.ts's
  // verifyPersisted header): add() resolves with a result list built BEFORE
  // its insert ever runs, so a fully-failed write still names ids that a
  // real get() never finds.
  get: vi.fn(async (id: string): Promise<FakeMemoryItem | null> => ({ id, memory: 'stub', metadata: {} })),
}
// Stands in for mem0ai's own PGVector.client (a raw pg.Client) — real
// mem0-store.ts reaches into `memory.vectorStore.client` synchronously,
// right after construction, to fire the search_path-scoping SET query (see
// scopeMem0SchemaSearchPath's header). This is what that reach lands on.
const vectorStoreClientQueryMock = vi.fn(async () => ({ rows: [] }))
vi.mock('mem0ai/oss', () => ({
  Memory: class {
    vectorStore = { client: { query: vectorStoreClientQueryMock } }
    constructor(config: unknown) {
      memoryConstructions.push(config)
    }
    add = fakeMemoryInstance.add
    search = fakeMemoryInstance.search
    getAll = fakeMemoryInstance.getAll
    deleteAll = fakeMemoryInstance.deleteAll
    get = fakeMemoryInstance.get
  },
}))

process.env.SUPABASE_DB_URL_DIRECT = 'postgresql://user:pass@db.example.com:5432/postgres?sslmode=require'

const { Mem0Store, getMemoryStore } = await import('./mem0-store')
const { DemoMemoryWriteRefusedError, MemoryPersistError } = await import('./types')

const USER_ID = 'user-abc'
const API_KEYS: DecryptedApiKeys = { openrouter: 'sk-or-test', userId: USER_ID }

beforeEach(() => {
  memoryConstructions.length = 0
  loadApiKeysMock.mockReset()
  loadApiKeysMock.mockResolvedValue(API_KEYS)
  callLlmMock.mockReset()
  callEmbeddingMock.mockReset()
  fakeMemoryInstance.add.mockClear()
  fakeMemoryInstance.search.mockClear()
  fakeMemoryInstance.getAll.mockClear()
  fakeMemoryInstance.deleteAll.mockClear()
  fakeMemoryInstance.get.mockReset()
  fakeMemoryInstance.get.mockImplementation(async (id: string) => ({ id, memory: 'stub', metadata: {} }))
  vectorStoreClientQueryMock.mockClear()
})

// --- telemetry ---------------------------------------------------------------

describe('MEM0_TELEMETRY', () => {
  it('is forced to the string "false" by importing this module, before any Memory is constructed', () => {
    // Importing mem0-store.ts (done once, above, before any test body runs)
    // must already have set this — not merely "will set it when a store is
    // built". A construction-time-only assignment would leave a window where
    // some other code path could construct a real mem0ai Memory before this
    // module ever ran.
    expect(process.env.MEM0_TELEMETRY).toBe('false')
  })
})

// --- construction-time config shape -------------------------------------------

describe('Mem0Store construction', () => {
  it('builds Memory exactly once, lazily, on first real use', async () => {
    const store = new Mem0Store()
    expect(memoryConstructions.length).toBe(0)
    await store.getAll(USER_ID)
    expect(memoryConstructions.length).toBe(1)
    await store.getAll(USER_ID)
    expect(memoryConstructions.length).toBe(1)
  })

  it('does not rely on a startup search_path option — Supavisor drops it (live-probed 2026-08-25)', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as {
      vectorStore: { provider: string; config: { connectionString: string; embeddingModelDims: number } }
    }
    expect(config.vectorStore.provider).toBe('pgvector')
    expect(config.vectorStore.config.connectionString).not.toContain('options=')
    // Locked embedding model's dimension count (ruling 10) — never a
    // provider-negotiated or guessed value.
    expect(config.vectorStore.config.embeddingModelDims).toBe(1536)
  })

  // MUTATION CHECK (executed, not left to trust): temporarily made
  // resolveMem0ConnectionString read SUPABASE_DB_URL (the shared pooled var)
  // instead of SUPABASE_DB_URL_DIRECT and re-ran the whole file — 19 of 22
  // tests went red (this test file only sets SUPABASE_DB_URL_DIRECT, so
  // resolution threw "Set SUPABASE_DB_URL_DIRECT ..." instead of returning a
  // connection string). Reverted immediately.
  it('connects mem0 over the DEDICATED DIRECT URL (SUPABASE_DB_URL_DIRECT), never the shared pooled one', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as { vectorStore: { config: { connectionString: string } } }
    // parseDbUrl round-trips through URL, so assert on host:port, not the
    // exact literal string.
    expect(config.vectorStore.config.connectionString).toContain('db.example.com:5432')
  })

  it('scopes the vector store to mem0,extensions with a real SET, issued synchronously right after construction', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    // scopeMem0SchemaSearchPath's whole reason to exist: this must be the
    // FIRST query on the vector store's client — mem0ai's own unawaited
    // init queries (CREATE EXTENSION, CREATE TABLE, ...) queue behind it iff
    // this runs synchronously, same tick, right after `new Memory()`.
    // Regression pin for that ordering (see mem0-store.ts's
    // scopeMem0SchemaSearchPath header for the live-probed proof).
    expect(vectorStoreClientQueryMock).toHaveBeenNthCalledWith(1, 'SET search_path TO mem0, extensions')
  })

  it('does not let a failed search_path SET crash MemoryStore construction', async () => {
    vectorStoreClientQueryMock.mockRejectedValueOnce(new Error('connection reset'))
    const store = new Mem0Store()
    await expect(store.getAll(USER_ID)).resolves.toEqual([])
  })

  it('sets vectorStore.config.dimension explicitly, not just embeddingModelDims', async () => {
    // mem0's own Memory._autoInitialize() branches on `dimension`, not
    // `embeddingModelDims` — leaving it unset fires an unguarded
    // embedder.embed('dimension probe') call outside apiKeysContext.run()
    // on every cold Memory() construction, which throws for callers (like
    // deleteAll(), below) that never open that context. This assertion is
    // the regression pin for that gap.
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as { vectorStore: { config: { dimension: number } } }
    expect(config.vectorStore.config.dimension).toBe(1536)
  })

  it('injects the LLM and embedder through the langchain shim, never a real provider client', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as {
      llm: { provider: string; config: { model: unknown } }
      embedder: { provider: string; config: { model: unknown } }
    }
    expect(config.llm.provider).toBe('langchain')
    expect(typeof (config.llm.config.model as { invoke?: unknown }).invoke).toBe('function')
    expect(config.embedder.provider).toBe('langchain')
    expect(typeof (config.embedder.config.model as { embedQuery?: unknown }).embedQuery).toBe('function')
    expect(typeof (config.embedder.config.model as { embedDocuments?: unknown }).embedDocuments).toBe('function')
  })

  it('has no graphStore field — graph memory is off by construction, not by a flag', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as Record<string, unknown>
    expect(config.graphStore).toBeUndefined()
  })
})

// --- per-call keys, never construction-time ------------------------------------

describe('apiKeys are per-call, not baked into Memory at construction', () => {
  it('the langchain LLM delegate reads the CURRENT call\'s apiKeys, not a fixed one', async () => {
    callLlmMock.mockResolvedValue({ content: 'ok', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'x' })
    const store = new Mem0Store()

    const firstKeys: DecryptedApiKeys = { openrouter: 'sk-first', userId: 'user-a' }
    const secondKeys: DecryptedApiKeys = { openrouter: 'sk-second', userId: 'user-b' }
    loadApiKeysMock.mockResolvedValueOnce(firstKeys).mockResolvedValueOnce(secondKeys)

    await store.add('user-a', { messages: [{ role: 'user', content: 'hi' }], scope: 'copilot', isDemo: false })
    await store.add('user-b', { messages: [{ role: 'user', content: 'hi' }], scope: 'copilot', isDemo: false })

    // The delegate itself never appears in memoryConstructions carrying a key
    // — the only thing that varied between the two calls is loadApiKeys'
    // resolved value, proving the delegate reads context, not a closed-over
    // constant.
    expect(loadApiKeysMock).toHaveBeenNthCalledWith(1, expect.anything(), 'user-a')
    expect(loadApiKeysMock).toHaveBeenNthCalledWith(2, expect.anything(), 'user-b')
  })

  it('the LLM delegate throws when invoked outside a MemoryStore call\'s context', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    const config = memoryConstructions[0] as { llm: { config: { model: { invoke: (m: unknown[]) => Promise<unknown> } } } }
    await expect(config.llm.config.model.invoke([])).rejects.toThrow(/outside an active MemoryStore call/)
  })
})

// --- userId scoping ------------------------------------------------------------

describe('every method scopes through the userId it was given', () => {
  it('add() passes userId through to mem0 and to loadApiKeys', async () => {
    callLlmMock.mockResolvedValue({ content: 'ok', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'x' })
    const store = new Mem0Store()
    await store.add(USER_ID, { messages: [{ role: 'user', content: 'hi' }], scope: 'copilot', isDemo: false })
    expect(loadApiKeysMock).toHaveBeenCalledWith(expect.anything(), USER_ID)
    expect(fakeMemoryInstance.add).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      expect.objectContaining({ userId: USER_ID, infer: true })
    )
  })

  it('add() with a fact string skips extraction (infer: false)', async () => {
    const store = new Mem0Store()
    await store.add(USER_ID, { fact: 'prefers remote roles', scope: 'copilot', isDemo: false })
    expect(fakeMemoryInstance.add).toHaveBeenCalledWith('prefers remote roles', expect.objectContaining({ userId: USER_ID, infer: false }))
  })

  it('search() filters by user_id, not a global query', async () => {
    const store = new Mem0Store()
    await store.search(USER_ID, 'remote jobs', { limit: 6 })
    expect(fakeMemoryInstance.search).toHaveBeenCalledWith(
      'remote jobs',
      expect.objectContaining({ topK: 6, filters: { user_id: USER_ID } })
    )
  })

  it('getAll() filters by user_id', async () => {
    const store = new Mem0Store()
    await store.getAll(USER_ID)
    expect(fakeMemoryInstance.getAll).toHaveBeenCalledWith(expect.objectContaining({ filters: { user_id: USER_ID } }))
  })

  it('deleteAll() takes userId and needs no apiKeys at all', async () => {
    const store = new Mem0Store()
    await store.deleteAll(USER_ID)
    expect(fakeMemoryInstance.deleteAll).toHaveBeenCalledWith({ userId: USER_ID })
    expect(loadApiKeysMock).not.toHaveBeenCalled()
  })
})

// --- add() verifies persistence instead of trusting mem0's return value --------
//
// Reproduces mem0ai@3.1.6's proven bug (live-probed 2026-08-25, see
// mem0-store.ts#Mem0Store.verifyPersisted's header): its infer:true add()
// path can resolve with a result list naming ids that were never actually
// written, because the vectorStore.insert() failure that caused that is
// caught and only console.error()d internally, never rethrown. add() must
// not be fooled by that — it re-checks every claimed id with a real get().

describe('add() verifies every claimed write actually landed', () => {
  it('throws MemoryPersistError when mem0 reports an id that a real get() cannot find', async () => {
    callLlmMock.mockResolvedValue({ content: 'ok', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'x' })
    fakeMemoryInstance.add.mockResolvedValueOnce({ results: [{ id: 'ghost-id', memory: 'never actually written' }] })
    fakeMemoryInstance.get.mockResolvedValueOnce(null) // the silent-failure reproduction

    const store = new Mem0Store()
    await expect(store.add(USER_ID, { messages: [{ role: 'user', content: 'hi' }], scope: 'copilot', isDemo: false })).rejects.toThrow(
      MemoryPersistError
    )
    expect(fakeMemoryInstance.get).toHaveBeenCalledWith('ghost-id')
  })

  it('resolves cleanly when every id mem0 reports is confirmed by get()', async () => {
    fakeMemoryInstance.add.mockResolvedValueOnce({ results: [{ id: 'real-id', memory: 'prefers remote roles' }] })
    // beforeEach's default get() implementation echoes the id back — a real find.

    const store = new Mem0Store()
    await expect(store.add(USER_ID, { fact: 'prefers remote roles', scope: 'copilot', isDemo: false })).resolves.toBeUndefined()
    expect(fakeMemoryInstance.get).toHaveBeenCalledWith('real-id')
  })

  it('needs no get() call at all when mem0 reports zero results (nothing new extracted — a real, non-failure outcome)', async () => {
    callLlmMock.mockResolvedValue({ content: 'ok', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'x' })
    fakeMemoryInstance.add.mockResolvedValueOnce({ results: [] })

    const store = new Mem0Store()
    await store.add(USER_ID, { messages: [{ role: 'user', content: 'hi' }], scope: 'copilot', isDemo: false })
    expect(fakeMemoryInstance.get).not.toHaveBeenCalled()
  })
})

// --- demo write refusal ---------------------------------------------------------

describe('demo sessions get no memory writes', () => {
  // MUTATION CHECK (executed, not left to trust): deleted the
  // `if (input.isDemo) throw new DemoMemoryWriteRefusedError(userId)` line
  // from Mem0Store#add and re-ran this test alone — it went red exactly as
  // shown below ("promise resolved undefined instead of rejecting").
  // Reverted immediately.
  it('add() throws DemoMemoryWriteRefusedError before touching loadApiKeys or mem0 at all', async () => {
    const store = new Mem0Store()
    await expect(
      store.add(USER_ID, { fact: 'anything', scope: 'copilot', isDemo: true })
    ).rejects.toThrow(DemoMemoryWriteRefusedError)
    expect(loadApiKeysMock).not.toHaveBeenCalled()
    expect(fakeMemoryInstance.add).not.toHaveBeenCalled()
  })

  it('search/getAll/deleteAll are unaffected by isDemo — only add() is guarded', async () => {
    const store = new Mem0Store()
    await expect(store.search(USER_ID, 'q')).resolves.toEqual([])
    await expect(store.getAll(USER_ID)).resolves.toEqual([])
    await expect(store.deleteAll(USER_ID)).resolves.toBeUndefined()
  })
})

describe('getMemoryStore', () => {
  it('returns the same instance across calls', () => {
    expect(getMemoryStore()).toBe(getMemoryStore())
  })
})
