// The ONE MemoryStore implementation — mem0ai@3.1.6, pgvector-backed, on our
// own Postgres (MEM0 DOCTRINE, orchestrator ruling from the executed spike,
// user-confirmed 2026-08-16). Read lib/memory/types.ts's header first — this
// file is the seam's only tenant.
//
// TELEMETRY: MEM0_TELEMETRY MUST BE 'false' BEFORE Memory IS EVER CONSTRUCTED
//   mem0's Memory class phones home to PostHog on construction unless this
//   env var is set (spike-proven necessity, not a doc-only claim). Setting it
//   here — at module load, unconditionally — is what makes that true no
//   matter which route imports this file first; a `.env` entry would only be
//   true in whichever environment remembered to set it. Construction itself
//   is lazy (see `instance()` below), so this assignment always runs before
//   the only `new Memory(...)` call site in the process.
process.env.MEM0_TELEMETRY = 'false'

import { AsyncLocalStorage } from 'node:async_hooks'
import { Memory, type MemoryConfig } from 'mem0ai/oss'
import type { BaseMessage } from '@langchain/core/messages'
import { callLlm, callEmbedding, EMBEDDING_DIMS } from '../harness/llm'
import { loadApiKeys } from '../harness/keys'
import { createAdminClient } from '../harness/supabase-admin'
import { parseDbUrl } from '../graph/pg'
import type { DecryptedApiKeys } from '../harness/types'
import { DemoMemoryWriteRefusedError, MemoryPersistError, type MemoryAddInput, type MemoryItem, type MemoryStore } from './types'

/** mem0's internal fact-extraction/dedup-judgment calls are structured JSON
 *  reasoning over a handful of short messages, not user-facing prose — the
 *  cheapest chat model on the price table (lib/harness/spend.ts's PRICES)
 *  is the right default, same reasoning as autopilot's background tasks. */
const MEM0_INTERNAL_MODEL = 'anthropic/claude-haiku-4.5'

const MEM0_COLLECTION = 'memories'

// --- Per-call key context ---------------------------------------------------
//
// WHY AN AsyncLocalStorage, NOT A CONSTRUCTOR ARGUMENT
//   mem0's 'langchain' LLM/embedder provider (LangchainLLM/LangchainEmbedder
//   in mem0ai/oss) requires an already-constructed instance with an
//   `.invoke`/`.embedQuery`+`.embedDocuments` method, handed in at Memory
//   CONSTRUCTION time — see node_modules/mem0ai/dist/oss/index.mjs's
//   LangchainLLM/LangchainEmbedder constructors, which throw immediately if
//   `config.model` isn't already such an object. That collides head-on with
//   the makeLlmRunner rule (apiKeys are per-call, never baked into a
//   long-lived construction) — Memory itself is a process-lifetime singleton
//   (see `instance()` below), so anything bound into its config at
//   construction would either go stale or, worse, permanently pin one user's
//   key into a shared instance every other user's call would then spend
//   against.
//
//   The fix the MEM0 DOCTRINE calls for: bind THIN delegate objects at
//   construction that hold no key material at all, and read the CURRENT
//   call's apiKeys from context set for the duration of that one call. An
//   AsyncLocalStorage is the simplest correct mechanism — Node's own
//   per-async-chain context, no new dependency, and it can't leak between
//   concurrent calls the way a module-level mutable variable would.
const apiKeysContext = new AsyncLocalStorage<DecryptedApiKeys>()

function currentApiKeys(): DecryptedApiKeys {
  const apiKeys = apiKeysContext.getStore()
  if (!apiKeys) {
    throw new Error(
      'lib/memory/mem0-store.ts: the langchain delegate was invoked outside an active MemoryStore call — every mem0 Memory call must run inside apiKeysContext.run().'
    )
  }
  return apiKeys
}

function roleOf(message: BaseMessage): 'system' | 'user' | 'assistant' {
  const type = message.getType()
  if (type === 'system') return 'system'
  if (type === 'ai') return 'assistant'
  return 'user'
}

/**
 * The 'langchain' LLM shim's whole contract is `.invoke(messages, options)`
 * returning something with a string `.content` — see this file's
 * apiKeysContext comment for why this holds no key itself. Every mem0-
 * internal LLM call is metered/guarded exactly like any other callLlm call
 * because the caller (Mem0Store's own methods, below) already ran
 * loadApiKeys before entering the context this reads from.
 */
const mem0LlmDelegate = {
  async invoke(messages: BaseMessage[]): Promise<{ content: string }> {
    const apiKeys = currentApiKeys()
    const chatMessages = messages.map((m) => ({
      role: roleOf(m),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    const res = await callLlm(apiKeys, { messages: chatMessages, model: MEM0_INTERNAL_MODEL, maxTokens: 800, temperature: 0 })
    return { content: res.content }
  },
}

/** Same shape as mem0LlmDelegate, for the 'langchain' embedder shim
 *  (`.embedQuery`/`.embedDocuments`) — see EMBEDDING_MODEL/EMBEDDING_DIMS's
 *  own lock comment in lib/harness/providers (ruling 10): callEmbedding's
 *  default model is the one locked embedding model, never overridden here. */
const mem0EmbedderDelegate = {
  async embedQuery(text: string): Promise<number[]> {
    const apiKeys = currentApiKeys()
    const res = await callEmbedding(apiKeys, { texts: [text] })
    const vec = res.embeddings[0]
    if (!vec) throw new Error('lib/memory/mem0-store.ts: callEmbedding returned no vector for a single query embed')
    return vec
  },
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const apiKeys = currentApiKeys()
    const res = await callEmbedding(apiKeys, { texts })
    return res.embeddings
  },
}

/**
 * SUPABASE_DB_URL_DIRECT (falls back to POSTGRES_URL_NON_POOLING) — a
 * DEDICATED DIRECT (port 5432) connection, never the shared pooled
 * SUPABASE_DB_URL every other runtime caller (lib/graph/pg.ts's
 * withCheckpointer, same pool) uses. Same resolution order as
 * scripts/setup-checkpointer.ts's resolveConnectionString — reused via
 * parseDbUrl, not forked.
 *
 * WHY DIRECT, NOT POOLED: PGVectorConfig has NO schema field of its own
 * (spike-proven), so the only lever for scoping mem0's writes to the `mem0`
 * schema is a real `SET search_path` issued on its connection (see
 * scopeMem0SchemaSearchPath below). Live-probed 2026-08-25 against
 * Supabase's Supavisor pooler (throwaway mem0_probe schema, dropped after):
 * a `SET search_path` on one pooled client is backend-level GUC state that
 * OUTLIVES that client's logical session — the next unrelated client
 * Supavisor multiplexes onto the same physical backend inherits it. Over
 * the shared pooled URL, that meant every other pooled consumer in this
 * process (notably lib/graph/pg.ts's checkpointer, same URL, same pool)
 * could land on a backend mem0 had silently re-scoped. A direct connection
 * has no such multiplexing: each `Pool`/`Client` here owns its own
 * dedicated backend for the life of that connection, so `SET search_path`
 * is session-local in the way Postgres actually documents it — it dies
 * with the connection and is never handed to a different logical client.
 * Nothing else on this direct connection's backend exists to leak onto.
 */
function resolveMem0ConnectionString(): string {
  const raw = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.POSTGRES_URL_NON_POOLING
  if (!raw) {
    throw new Error(
      'Set SUPABASE_DB_URL_DIRECT (preferred) or POSTGRES_URL_NON_POOLING to a DIRECT (port 5432, non-pooled) Postgres connection string before using MemoryStore. See apps/web/.env.example.'
    )
  }
  return parseDbUrl(raw)
}

/**
 * mem0ai@3.1.6's PGVector holds exactly ONE pg.Client for its whole process
 * lifetime (node_modules/mem0ai/dist/oss/index.mjs — `this.client = new
 * Client(...)`, never a Pool) and its constructor fires an UNAWAITED
 * `this.initialize().catch(console.error)` that connects it, then issues
 * unqualified DDL (`CREATE EXTENSION`, `CREATE TABLE memory_migrations`,
 * `listCols()`/`createCol()`) — every one of those, and every later
 * insert/search/get, resolves against whatever `search_path` that
 * connection has. With no schema field on PGVectorConfig, the only lever is
 * a real `SET search_path` SQL statement issued AFTER connecting — and this
 * only runs safely because resolveMem0ConnectionString above hands mem0 a
 * DEDICATED DIRECT connection, not the shared pooled one: a direct
 * connection's backend is never multiplexed onto another client, so this
 * SET is genuinely session-local (see that function's header for the
 * live-probed Supavisor leak this replaced).
 *
 * The remaining problem is ordering: mem0ai's own first query must not run
 * before ours does. `vectorStore` and `client` are typed `private` in
 * mem0ai's .d.ts, but are ordinary own properties at runtime — reached here
 * with a narrow cast rather than pretending PGVectorConfig has a hook it
 * doesn't. Node's async functions run synchronously up to their first
 * `await`, and this file sets `dimension` explicitly (skipping mem0's own
 * dimension-probe branch), so by the time `new Memory(...)` returns below,
 * `memory.vectorStore` (PGVector) and its `.client` already exist and
 * `.client.connect()` has already been called — pending, not yet resolved.
 * node-postgres queues `.query()` calls strictly in the order they were
 * CALLED, not awaited, so issuing our SET here, synchronously, in the same
 * tick, wins that queue race deterministically and lands ahead of mem0ai's
 * own first query. Live-probed 2026-08-25 by reproducing this exact
 * unawaited-constructor pattern standalone: the race-winning SET landed a
 * same-tick unqualified CREATE TABLE in the target schema on both
 * connection classes available to test with.
 *
 * `extensions` stays second, not omitted — Supabase installs pgvector's own
 * `vector` type into the `extensions` schema, not `public` (confirmed live:
 * `select extname, nspname from pg_extension join pg_namespace ...`).
 * Dropping it from the path would make PGVector's own `CREATE TABLE ...
 * vector(dims)` fail with "type vector does not exist" the first time it
 * needs to create the collection.
 */
function scopeMem0SchemaSearchPath(memory: Memory): void {
  const client = (memory as unknown as { vectorStore: { client: { query(sql: string): Promise<unknown> } } })
    .vectorStore.client
  client.query('SET search_path TO mem0, extensions').catch((err: unknown) => {
    console.error('lib/memory/mem0-store.ts: failed to scope the mem0 schema search_path — writes may land in public', err)
  })
}

function buildMemoryConfig(): Partial<MemoryConfig> {
  return {
    embedder: { provider: 'langchain', config: { model: mem0EmbedderDelegate } },
    llm: { provider: 'langchain', config: { model: mem0LlmDelegate } },
    vectorStore: {
      provider: 'pgvector',
      config: {
        connectionString: resolveMem0ConnectionString(),
        // Same relaxation as lib/graph/pg.ts, against the same database —
        // see that file's header for why this does not disable encryption,
        // only chain verification against Supabase's self-signed chain.
        ssl: { rejectUnauthorized: false },
        embeddingModelDims: EMBEDDING_DIMS,
        // mem0's own Memory._autoInitialize() checks `dimension`, NOT
        // `embeddingModelDims` (PGVectorConfig's field for the vector
        // column width) — leaving it unset makes every cold Memory()
        // construction fire an unguarded embedder.embed('dimension probe')
        // call OUTSIDE apiKeysContext.run() before the vector store even
        // exists, which throws for callers like deleteAll() that never open
        // that context. Setting it explicitly skips the probe entirely.
        dimension: EMBEDDING_DIMS,
        collectionName: MEM0_COLLECTION,
      },
    },
    // ponytail: no historyStore, disableHistory:true. mem0's default history
    // sink (unset historyStore) is a local sqlite file via the installed
    // better-sqlite3 transitive dep — pointless on Vercel's per-invocation
    // filesystem, and nothing in the MEM0 DOCTRINE asks for an update/delete
    // audit trail. Upgrade path: a real historyStore only if a future
    // feature needs one.
    disableHistory: true,
    // Graph memory (Neo4j) has no field on MemoryConfig in mem0ai@3.1.6 to
    // even turn on — it's a separate opt-in class this file never imports.
    // That IS "graph memory stays OFF": there is nothing here to disable.
  }
}

function toMemoryItem(raw: { id: string; memory: string; score?: number; createdAt?: string; metadata?: Record<string, unknown> }): MemoryItem {
  return { id: raw.id, memory: raw.memory, score: raw.score, createdAt: raw.createdAt, metadata: raw.metadata }
}

export class Mem0Store implements MemoryStore {
  private memory: Memory | undefined

  /** Constructed once per process on first real use — see this file's
   *  telemetry comment for why that is safe. */
  private instance(): Memory {
    if (!this.memory) {
      this.memory = new Memory(buildMemoryConfig())
      scopeMem0SchemaSearchPath(this.memory)
    }
    return this.memory
  }

  async add(userId: string, input: MemoryAddInput): Promise<void> {
    // The demo guard: refused BEFORE loadApiKeys, before any spend, before
    // any DB write. Does not re-derive demo-ness — input.isDemo is the
    // caller's own already-computed guard result (lib/memory/types.ts's
    // header explains why this file does not read profiles itself).
    if (input.isDemo) throw new DemoMemoryWriteRefusedError(userId)

    const admin = createAdminClient()
    const apiKeys = await loadApiKeys(admin, userId)
    const metadata = { scope: input.scope, ...(input.refs ?? {}) }
    await apiKeysContext.run(apiKeys, async () => {
      const result =
        input.fact !== undefined
          ? // Already a distilled fact — store as-is, skip mem0's own
            // extraction LLM call (infer: false).
            await this.instance().add(input.fact, { userId, infer: false, metadata })
          : // A conversation turn — let mem0 run its own fact-extraction LLM
            // call and resolve ADD/UPDATE/DELETE (with hash dedup) against
            // what it already knows about this user.
            await this.instance().add(input.messages ?? [], { userId, infer: true, metadata })
      await this.verifyPersisted(result.results)
    })
  }

  /**
   * mem0ai's own add() can resolve successfully while writing nothing:
   * mem0ai@3.1.6's infer:true path (dist/oss/index.mjs's addToVectorStore)
   * builds its returned {id, memory, ...} list from the records it INTENDS
   * to write, then wraps the actual `vectorStore.insert()` call in a
   * try/catch that only console.error()s on failure — never rethrows, never
   * changes the return value. A fully-failed write still comes back looking
   * like a successful ADD (proven live, 2026-08-25 throwaway-schema probe:
   * a broken collection table produced a clean-looking add() result with
   * zero rows ever landing). Every id add() claims to have written gets one
   * real per-row existence check (Memory.get(), a single indexed lookup —
   * the "cheap ... returning check" this store owes its callers) before
   * add() is allowed to resolve. Refuse-over-guess: a memory add either
   * verifiably landed or this throws MemoryPersistError, same discipline as
   * every other chokepoint in this codebase that reports success.
   */
  private async verifyPersisted(results: MemoryItem[]): Promise<void> {
    for (const r of results) {
      const found = await this.instance().get(r.id)
      if (!found) throw new MemoryPersistError(r.id)
    }
  }

  async search(userId: string, query: string, opts: { limit?: number } = {}): Promise<MemoryItem[]> {
    const admin = createAdminClient()
    const apiKeys = await loadApiKeys(admin, userId)
    const result = await apiKeysContext.run(apiKeys, () =>
      this.instance().search(query, { topK: opts.limit ?? 6, filters: { user_id: userId } })
    )
    return result.results.map(toMemoryItem)
  }

  async getAll(userId: string): Promise<MemoryItem[]> {
    const admin = createAdminClient()
    const apiKeys = await loadApiKeys(admin, userId)
    const result = await apiKeysContext.run(apiKeys, () => this.instance().getAll({ filters: { user_id: userId } }))
    return result.results.map(toMemoryItem)
  }

  async deleteAll(userId: string): Promise<void> {
    // A vector-store delete only — no LLM/embedder call, so no apiKeys and
    // no context needed. This is what lib/access/demo-wipe.ts calls; it is
    // deliberately NOT demo-guarded (the wipe's entire job is deleting a
    // demo's data).
    await this.instance().deleteAll({ userId })
  }
}

let singleton: Mem0Store | undefined

/** The single MemoryStore instance for this process — see lib/memory/
 *  types.ts's header for why there is no second implementation and no env
 *  switch between them. */
export function getMemoryStore(): MemoryStore {
  if (!singleton) singleton = new Mem0Store()
  return singleton
}
