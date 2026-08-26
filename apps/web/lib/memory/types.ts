// The MemoryStore chokepoint — every read or write of a user's cross-session
// memory goes through here, and nowhere else. See lib/memory/mem0-store.ts's
// header for the ONE implementation (mem0ai) and why there is no second one.
//
// WHY userId IS REQUIRED ON EVERY METHOD
//   mem0's own auto-created table carries no user_id column of its own (see
//   supabase/migrations/20260816000006_memories.sql's header) — every scrap
//   of ownership lives in the payload mem0 stores and in the userId filter
//   passed to mem0 on every call. A method that could be called without one
//   would have no way to ever be scoped to anyone, so it is not in this
//   interface.
//
// WHY isDemo IS REQUIRED ON add(), NOT RE-DERIVED HERE
//   Demo sessions get NO memory writes at all — not "capped", not "wiped
//   later", refused outright (Mem0Store.add throws DemoMemoryWriteRefusedError
//   before it does anything else). But this module has no route context and
//   no reason to hold a second copy of demoSessionGate's policy, so it takes
//   the caller's own already-computed guard result as a plain boolean instead
//   of reading profiles itself. The caller (lib/graph/copilot.ts's post-turn
//   write) is the one that already knows whether this session is a demo.
//
// ponytail: one implementation (Mem0Store), no MEMORY_BACKEND env switch —
// this interface is the fallback SEAM, not a live abstraction with two
// callers. A second (Postgres-only) implementation gets built the day mem0
// actually breaks in production, not before (MEM0 DOCTRINE, orchestrator
// ruling, user-confirmed 2026-08-16).

export interface MemoryAddInput {
  /** A user/assistant turn pair — mem0 runs its own fact-extraction LLM call
   *  over these and resolves ADD/UPDATE/DELETE against what it already knows
   *  (mem0's `infer: true` path). */
  messages?: { role: 'user' | 'assistant'; content: string }[]
  /** An already-distilled fact string — stored as-is (`infer: false`), no
   *  extraction LLM call. Alternative to `messages`; exactly one is set. */
  fact?: string
  /** Free-text namespace tag (e.g. 'copilot', 'outreach') carried in mem0's
   *  metadata — informational grouping only, search() does not filter by it. */
  scope: string
  /** Arbitrary caller-supplied refs (companyId, jobId, ...) merged into the
   *  stored memory's metadata alongside `scope`. */
  refs?: Record<string, unknown>
  /** The caller's own already-computed demo-session verdict. true refuses
   *  the write outright — see this file's header. */
  isDemo: boolean
}

export interface MemoryItem {
  id: string
  memory: string
  score?: number
  createdAt?: string
  metadata?: Record<string, unknown>
}

export class DemoMemoryWriteRefusedError extends Error {
  constructor(userId: string) {
    super(`lib/memory: refusing to write a memory for demo session ${userId} — demo sessions get no memory writes.`)
    this.name = 'DemoMemoryWriteRefusedError'
  }
}

/**
 * Thrown by MemoryStore.add() when the underlying store (mem0) claimed a
 * memory was written but a direct re-check found nothing at that id — see
 * lib/memory/mem0-store.ts#Mem0Store.verifyPersisted's header for exactly
 * how mem0ai can resolve add() successfully on a fully-failed write. Callers
 * must treat this the same as any other add() failure (it is one) — never
 * report "saved" on catching it.
 */
export class MemoryPersistError extends Error {
  constructor(memoryId: string) {
    super(`lib/memory: add() reported success but memory ${memoryId} does not exist in the store — the write did not actually land.`)
    this.name = 'MemoryPersistError'
  }
}

export interface MemoryStore {
  /** Throws DemoMemoryWriteRefusedError when `input.isDemo`. Metered — reads
   *  the caller's own apiKeys via loadApiKeys, so it is subject to the same
   *  demo spend/expiry guard and monthly cap every other callLlm caller is. */
  add(userId: string, input: MemoryAddInput): Promise<void>
  /** Semantic search over `userId`'s memories, most relevant first. */
  search(userId: string, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
  /** Every memory `userId` owns, newest first. */
  getAll(userId: string): Promise<MemoryItem[]>
  /** Deletes every memory `userId` owns. Not demo-guarded — this is what the
   *  demo wipe (lib/access/demo-wipe.ts) calls to actually clear them. */
  deleteAll(userId: string): Promise<void>
}
