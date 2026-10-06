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
  /** The text to keep, stored as given (mem0 `infer: false`, no extraction
   *  call). Cello never lets mem0 decide what a conversation meant. */
  fact: string
  /** Free-text namespace tag (e.g. 'copilot', 'outreach') carried in mem0's
   *  metadata, informational grouping only. */
  scope: string
  /** Caller-supplied fields (key, status, kind, ...) merged into the stored
   *  memory's metadata alongside `scope`. Filterable in getAll. */
  refs?: Record<string, unknown>
  /** The caller's own already-computed demo-session verdict. true refuses
   *  the write outright, see this file's header. */
  isDemo: boolean
}

export interface MemoryPatch {
  /** New text. Omit to change only the metadata. */
  text?: string
  /** Merged into the stored metadata. */
  metadata?: Record<string, unknown>
}

export interface MemoryListOptions {
  /** Metadata equality filters, e.g. { status: 'active' }. user_id is always added. */
  filters?: Record<string, unknown>
  limit?: number
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
  /** Throws DemoMemoryWriteRefusedError when `input.isDemo`. Returns the stored memory. */
  add(userId: string, input: MemoryAddInput): Promise<MemoryItem>
  /** One memory, or null when it does not exist or belongs to someone else. */
  get(userId: string, id: string): Promise<MemoryItem | null>
  /** Changes text and/or metadata. Throws when the memory is not `userId`'s. */
  update(userId: string, id: string, patch: MemoryPatch): Promise<void>
  /** Deletes one memory. Throws when the memory is not `userId`'s. */
  delete(userId: string, id: string): Promise<void>
  /** Words-and-vectors search over `userId`'s memories, most relevant first. */
  search(userId: string, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
  /** `userId`'s memories, newest first, optionally narrowed by metadata equality. */
  getAll(userId: string, opts?: MemoryListOptions): Promise<MemoryItem[]>
  /** Deletes every memory `userId` owns. Not demo-guarded: this is what the
   *  demo wipe (lib/access/demo-wipe.ts) calls to actually clear them. */
  deleteAll(userId: string): Promise<void>
}
