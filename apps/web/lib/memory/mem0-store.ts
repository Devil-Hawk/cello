// The ONE MemoryStore implementation: mem0ai 3.3.1, pgvector on our own Postgres
// (the `mem0` schema), one collection named `learnings` at 384 dimensions.
// Read lib/memory/types.ts's header first, this file is the seam's only tenant.
//
// WHAT CHANGED FROM 3.1.6
//   - `add` is `infer: false` and nothing else. mem0 never reads a conversation and
//     decides what to remember: Cello's code writes a statement, a person keeps it.
//     The LLM delegate and the extraction prompt are gone, so mem0 cannot reach a model.
//   - The embedder is the server's own 384-dimension model (lib/memory/embedder.ts),
//     no key and no spend. With no embedder (spike SP3 failed, no network) a memory
//     is still stored, with a zero vector, and search falls back to words.
//   - The old 1536-dimension `memories` collection is left where it is. Its rows are
//     re-added once, as proposals, by scripts/learning-move.ts.
//
// TELEMETRY: MEM0_TELEMETRY MUST BE 'false' BEFORE Memory IS EVER CONSTRUCTED
//   mem0's Memory class phones home to PostHog on construction unless this env var is
//   set. Setting it at module load makes that true whichever route imports this first.
process.env.MEM0_TELEMETRY = 'false'

import { Memory, type MemoryConfig } from 'mem0ai/oss'
import { parseDbUrl, sslFor } from '../graph/pg'
import { embed384, EMBED384_DIMS } from './embedder'
import {
  DemoMemoryWriteRefusedError,
  MemoryPersistError,
  type MemoryAddInput,
  type MemoryItem,
  type MemoryListOptions,
  type MemoryPatch,
  type MemoryStore,
} from './types'

const MEM0_COLLECTION = 'learnings'

// ponytail: a zero vector when there is no embedder. A memory stored this way is found
// by words (search below falls back over getAll) and gets its real vector the next
// time it is updated once an embedder exists.
const ZERO_VECTOR = new Array<number>(EMBED384_DIMS).fill(0)

/** mem0's 'langchain' embedder shim: `.embedQuery` and `.embedDocuments`, no key held. */
const mem0EmbedderDelegate = {
  async embedQuery(text: string): Promise<number[]> {
    return (await embed384([text]))?.[0] ?? ZERO_VECTOR
  },
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return (await embed384(texts)) ?? texts.map(() => ZERO_VECTOR)
  },
}

/** mem0 insists on an LLM at construction. With `infer: false` it is never called, and
 *  this one refuses if something tries: Cello never lets mem0 call a model. */
const mem0NoLlm = {
  async invoke(): Promise<never> {
    throw new Error('lib/memory/mem0-store.ts: mem0 may not call a model; memories are written with infer: false only.')
  },
}

/**
 * SUPABASE_DB_URL_DIRECT (falls back to POSTGRES_URL_NON_POOLING): a DEDICATED DIRECT
 * (port 5432) connection, never the shared pooled one. mem0 creates its tables with
 * unqualified names, so every client it opens must run with `search_path` = mem0.
 *
 * mem0ai 3.3.1 opens its pg clients later than 3.1.6 did (its vector store connects
 * after an awaited dynamic import, and a second client serves its entity store), so the
 * old same-tick `SET search_path` on one client cannot reach them. The startup option in
 * the connection string reaches every client, and a direct connection honours it.
 * (Supavisor does not, which is why this must stay the direct URL.)
 * `extensions` stays second: Supabase installs pgvector's `vector` type there.
 */
function resolveMem0ConnectionString(): string {
  const raw = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.POSTGRES_URL_NON_POOLING
  if (!raw) {
    throw new Error(
      'Set SUPABASE_DB_URL_DIRECT (preferred) or POSTGRES_URL_NON_POOLING to a DIRECT (port 5432, non-pooled) Postgres connection string before using MemoryStore. See apps/web/.env.example.'
    )
  }
  const base = parseDbUrl(raw)
  return base + (base.includes('?') ? '&' : '?') + 'options=-c%20search_path%3Dmem0%2Cextensions'
}

function buildMemoryConfig(): Partial<MemoryConfig> {
  const connectionString = resolveMem0ConnectionString()
  return {
    embedder: { provider: 'langchain', config: { model: mem0EmbedderDelegate } },
    llm: { provider: 'langchain', config: { model: mem0NoLlm } },
    vectorStore: {
      provider: 'pgvector',
      config: {
        connectionString,
        // Verified against the pinned Supabase root CA, same as lib/graph/pg.ts.
        ssl: sslFor(connectionString),
        embeddingModelDims: EMBED384_DIMS,
        // mem0's Memory._autoInitialize() checks `dimension`, not `embeddingModelDims`;
        // leaving it unset makes every cold construction fire a dimension-probe embed.
        dimension: EMBED384_DIMS,
        collectionName: MEM0_COLLECTION,
      },
    },
    // ponytail: no history store. mem0's default is a local sqlite file, pointless on
    // Vercel's per-invocation filesystem. Add one only if a feature needs an audit trail.
    disableHistory: true,
  }
}

type RawItem = { id: string; memory: string; score?: number; createdAt?: string; metadata?: Record<string, unknown>; user_id?: string }

function toMemoryItem(raw: RawItem): MemoryItem {
  return { id: raw.id, memory: raw.memory, score: raw.score, createdAt: raw.createdAt, metadata: raw.metadata }
}

/** Words of three letters or more, lower case: the no-embedder search. */
const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []

export class Mem0Store implements MemoryStore {
  private memory: Memory | undefined

  /** Constructed once per process on first real use. */
  private instance(): Memory {
    this.memory ??= new Memory(buildMemoryConfig())
    return this.memory
  }

  /** The memory when it is `userId`'s, else null. Every id-addressed call goes through here. */
  private async owned(userId: string, id: string): Promise<RawItem | null> {
    const found = (await this.instance().get(id)) as unknown as RawItem | null
    return found && found.user_id === userId ? found : null
  }

  async add(userId: string, input: MemoryAddInput): Promise<MemoryItem> {
    // The demo guard: refused before anything else. input.isDemo is the caller's own
    // already-computed guard result (types.ts explains why this file does not read profiles).
    if (input.isDemo) throw new DemoMemoryWriteRefusedError(userId)
    const result = await this.instance().add(input.fact, {
      userId,
      infer: false,
      metadata: { scope: input.scope, ...(input.refs ?? {}) },
    })
    const first = result.results[0]
    if (!first) throw new MemoryPersistError('(none)')
    await this.verifyPersisted(result.results)
    return toMemoryItem(first)
  }

  /**
   * mem0's add can resolve while writing nothing (its insert failure is caught and only
   * logged). Every id it claims gets one real lookup before add() may resolve: a memory
   * either verifiably landed or this throws MemoryPersistError.
   */
  private async verifyPersisted(results: MemoryItem[]): Promise<void> {
    for (const r of results) {
      const found = await this.instance().get(r.id)
      if (!found) throw new MemoryPersistError(r.id)
    }
  }

  async get(userId: string, id: string): Promise<MemoryItem | null> {
    const found = await this.owned(userId, id)
    return found ? toMemoryItem(found) : null
  }

  async update(userId: string, id: string, patch: MemoryPatch): Promise<void> {
    if (!(await this.owned(userId, id))) throw new Error(`lib/memory: memory ${id} is not ${userId}'s to change.`)
    await this.instance().update(id, { ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.metadata ? { metadata: patch.metadata } : {}) })
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.owned(userId, id))) throw new Error(`lib/memory: memory ${id} is not ${userId}'s to delete.`)
    await this.instance().delete(id)
  }

  async search(userId: string, query: string, opts: { limit?: number } = {}): Promise<MemoryItem[]> {
    const limit = opts.limit ?? 6
    // With no embedder a vector search means nothing: rank by shared words instead.
    if (!(await embed384([query]))) {
      const q = new Set(words(query))
      const scored = (await this.getAll(userId, { limit: 500 }))
        .map((m) => ({ m, score: words(m.memory).filter((w) => q.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map((x) => ({ ...x.m, score: x.score }))
    }
    const result = await this.instance().search(query, { topK: limit, filters: { user_id: userId } })
    return result.results.map(toMemoryItem)
  }

  async getAll(userId: string, opts: MemoryListOptions = {}): Promise<MemoryItem[]> {
    const result = await this.instance().getAll({ filters: { ...(opts.filters ?? {}), user_id: userId }, topK: opts.limit ?? 500 })
    return result.results.map(toMemoryItem).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  }

  async deleteAll(userId: string): Promise<void> {
    // Not demo-guarded: the wipe's whole job is deleting a demo's data.
    await this.instance().deleteAll({ userId })
  }
}

let singleton: Mem0Store | undefined

/** The single MemoryStore for this process. */
export function getMemoryStore(): MemoryStore {
  singleton ??= new Mem0Store()
  return singleton
}
