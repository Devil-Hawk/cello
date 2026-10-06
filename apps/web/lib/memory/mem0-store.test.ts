// Tests for lib/memory/mem0-store.ts: the construction-time config (telemetry,
// schema scoping, the 384-dimension `learnings` collection, no model reachable),
// `infer: false` on every write, the demo refusal, ownership on every id-addressed
// call, and the no-embedder fallback. mem0ai's Memory class is faked so this file
// never opens a connection.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const embedMock = vi.fn()
vi.mock('./embedder', () => ({
  EMBED384_DIMS: 384,
  embed384: (...args: unknown[]) => embedMock(...args),
}))

const memoryConstructions: unknown[] = []
type Item = { id: string; memory: string; createdAt?: string; metadata?: Record<string, unknown>; user_id?: string }
const fake = {
  add: vi.fn(async (): Promise<{ results: Item[] }> => ({ results: [{ id: 'm1', memory: 'x' }] })),
  search: vi.fn(async (): Promise<{ results: Item[] }> => ({ results: [] })),
  getAll: vi.fn(async (): Promise<{ results: Item[] }> => ({ results: [] })),
  get: vi.fn(async (id: string): Promise<Item | null> => ({ id, memory: 'x', user_id: 'user-abc' })),
  update: vi.fn(async () => ({ message: 'ok' })),
  delete: vi.fn(async () => ({ message: 'ok' })),
  deleteAll: vi.fn(async () => ({ message: 'ok' })),
}
vi.mock('mem0ai/oss', () => ({
  Memory: class {
    constructor(config: unknown) {
      memoryConstructions.push(config)
    }
    add = fake.add
    search = fake.search
    getAll = fake.getAll
    get = fake.get
    update = fake.update
    delete = fake.delete
    deleteAll = fake.deleteAll
  },
}))

process.env.SUPABASE_DB_URL_DIRECT = 'postgresql://user:pass@db.example.com:5432/postgres?sslmode=require'

const { Mem0Store, getMemoryStore } = await import('./mem0-store')
const { DemoMemoryWriteRefusedError, MemoryPersistError } = await import('./types')

const USER = 'user-abc'

beforeEach(() => {
  memoryConstructions.length = 0
  for (const f of Object.values(fake)) f.mockClear()
  fake.get.mockImplementation(async (id: string) => ({ id, memory: 'x', user_id: USER }))
  fake.add.mockImplementation(async () => ({ results: [{ id: 'm1', memory: 'x' }] }))
  embedMock.mockReset()
  embedMock.mockResolvedValue([new Array(384).fill(0.1)])
})

type Config = {
  embedder: { provider: string; config: { model: { embedQuery(t: string): Promise<number[]>; embedDocuments(t: string[]): Promise<number[][]> } } }
  llm: { config: { model: { invoke(): Promise<unknown> } } }
  vectorStore: { provider: string; config: { connectionString: string; embeddingModelDims: number; dimension: number; collectionName: string } }
  disableHistory: boolean
  customInstructions?: string
  graphStore?: unknown
}
async function config(): Promise<Config> {
  await new Mem0Store().getAll(USER)
  return memoryConstructions[0] as Config
}

describe('construction', () => {
  it('forces MEM0_TELEMETRY to "false" at import', () => {
    expect(process.env.MEM0_TELEMETRY).toBe('false')
  })

  it('builds Memory once, lazily, on first real use', async () => {
    const store = new Mem0Store()
    expect(memoryConstructions.length).toBe(0)
    await store.getAll(USER)
    await store.getAll(USER)
    expect(memoryConstructions.length).toBe(1)
  })

  it('uses the 384-dimension `learnings` collection over the direct URL scoped to the mem0 schema', async () => {
    const c = await config()
    expect(c.vectorStore.provider).toBe('pgvector')
    expect(c.vectorStore.config.collectionName).toBe('learnings')
    expect(c.vectorStore.config.embeddingModelDims).toBe(384)
    expect(c.vectorStore.config.dimension).toBe(384)
    expect(c.vectorStore.config.connectionString).toContain('db.example.com:5432')
    // every pg client mem0 opens, including its entity store's, gets the schema from the startup option
    expect(c.vectorStore.config.connectionString).toContain('options=-c%20search_path%3Dmem0%2Cextensions')
    expect(c.vectorStore.config.connectionString).not.toContain('sslmode')
  })

  it('has no way to reach a model and no extraction instructions', async () => {
    const c = await config()
    await expect(c.llm.config.model.invoke()).rejects.toThrow(/may not call a model/)
    expect(c.customInstructions).toBeUndefined()
    expect(c.graphStore).toBeUndefined()
    expect(c.disableHistory).toBe(true)
  })

  it('embeds through the server embedder, and with none gives a zero vector instead of failing', async () => {
    const c = await config()
    expect((await c.embedder.config.model.embedQuery('hello')).length).toBe(384)
    embedMock.mockResolvedValue(null)
    const zero = await c.embedder.config.model.embedQuery('hello')
    expect(zero.length).toBe(384)
    expect(zero.every((v) => v === 0)).toBe(true)
    expect((await c.embedder.config.model.embedDocuments(['a', 'b'])).length).toBe(2)
  })
})

describe('add', () => {
  it('is always infer: false, with the fact as given and the user and scope in metadata', async () => {
    const item = await new Mem0Store().add(USER, { fact: 'Prefers small teams', scope: 'learning', refs: { key: 'k1', status: 'proposed' }, isDemo: false })
    expect(fake.add).toHaveBeenCalledWith('Prefers small teams', { userId: USER, infer: false, metadata: { scope: 'learning', key: 'k1', status: 'proposed' } })
    expect(item.id).toBe('m1')
  })

  it('refuses a demo session before touching mem0', async () => {
    await expect(new Mem0Store().add(USER, { fact: 'x', scope: 's', isDemo: true })).rejects.toThrow(DemoMemoryWriteRefusedError)
    expect(fake.add).not.toHaveBeenCalled()
  })

  it('throws MemoryPersistError when mem0 names an id a real get cannot find', async () => {
    fake.get.mockResolvedValueOnce(null)
    await expect(new Mem0Store().add(USER, { fact: 'x', scope: 's', isDemo: false })).rejects.toThrow(MemoryPersistError)
  })
})

describe('get, update and delete are the owner\'s only', () => {
  it('get returns null for another person\'s memory', async () => {
    fake.get.mockResolvedValueOnce({ id: 'm9', memory: 'theirs', user_id: 'someone-else' })
    expect(await new Mem0Store().get(USER, 'm9')).toBeNull()
  })

  it('update passes text and metadata to mem0 for the owner', async () => {
    await new Mem0Store().update(USER, 'm1', { text: 'new', metadata: { status: 'active' } })
    expect(fake.update).toHaveBeenCalledWith('m1', { text: 'new', metadata: { status: 'active' } })
  })

  it('update and delete throw, and change nothing, for another person\'s memory', async () => {
    fake.get.mockResolvedValue({ id: 'm9', memory: 'theirs', user_id: 'someone-else' })
    const store = new Mem0Store()
    await expect(store.update(USER, 'm9', { text: 'x' })).rejects.toThrow(/not user-abc's/)
    await expect(store.delete(USER, 'm9')).rejects.toThrow(/not user-abc's/)
    expect(fake.update).not.toHaveBeenCalled()
    expect(fake.delete).not.toHaveBeenCalled()
  })

  it('delete removes one memory for the owner', async () => {
    await new Mem0Store().delete(USER, 'm1')
    expect(fake.delete).toHaveBeenCalledWith('m1')
  })
})

describe('getAll and search', () => {
  it('getAll filters on the user and any metadata filter, with a limit above mem0\'s default of 20', async () => {
    await new Mem0Store().getAll(USER, { filters: { status: 'active' } })
    expect(fake.getAll).toHaveBeenCalledWith({ filters: { status: 'active', user_id: USER }, topK: 500 })
  })

  it('a caller cannot widen getAll past the user: user_id in filters is overridden', async () => {
    await new Mem0Store().getAll(USER, { filters: { user_id: 'someone-else' } })
    expect(fake.getAll).toHaveBeenCalledWith(expect.objectContaining({ filters: { user_id: USER } }))
  })

  it('two reads at once both resolve (they queue on mem0\'s one client)', async () => {
    fake.getAll.mockResolvedValue({ results: [{ id: 'a', memory: 'one' }] })
    const store = new Mem0Store()
    const [x, y] = await Promise.all([store.getAll(USER, { filters: { status: 'active' } }), store.getAll(USER, { filters: { status: 'active' } })])
    expect(x).toHaveLength(1)
    expect(y).toHaveLength(1)
  })

  it('search asks mem0 for this user only', async () => {
    await new Mem0Store().search(USER, 'remote jobs', { limit: 4 })
    expect(fake.search).toHaveBeenCalledWith('remote jobs', { topK: 4, filters: { user_id: USER } })
  })

  it('with no embedder, search ranks by shared words over getAll and never asks mem0 to search', async () => {
    embedMock.mockResolvedValue(null)
    fake.getAll.mockResolvedValue({
      results: [
        { id: 'a', memory: 'Prefers remote roles at small teams' },
        { id: 'b', memory: 'Passes on roles that need relocation' },
        { id: 'c', memory: 'Unrelated note about cooking' },
      ],
    })
    const found = await new Mem0Store().search(USER, 'remote roles', { limit: 5 })
    expect(found.map((m) => m.id)).toEqual(['a', 'b'])
    expect(fake.search).not.toHaveBeenCalled()
  })
})

describe('deleteAll and the singleton', () => {
  it('deleteAll takes only the user id', async () => {
    await new Mem0Store().deleteAll(USER)
    expect(fake.deleteAll).toHaveBeenCalledWith({ userId: USER })
  })

  it('getMemoryStore returns one instance', () => {
    expect(getMemoryStore()).toBe(getMemoryStore())
  })
})
