// lane-stub: K15 store
// An in-memory stand-in for the memory store, until the learning lane's mem0 store carries `infer: false`
// and per-item delete. It implements the type main already has (lib/memory/types.ts) plus the one method
// chat needs from K15, delete(id). Deleted at integration step 18; callers pass the store in, so nothing else changes.

import { DemoMemoryWriteRefusedError, type MemoryAddInput, type MemoryItem } from '@/lib/memory/types'
import type { ChatMemoryStore } from '../memory'

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])

export function inMemoryStore(opts: { embedderDown?: boolean } = {}): ChatMemoryStore & { items: (MemoryItem & { userId: string })[] } {
  const items: (MemoryItem & { userId: string })[] = []
  let n = 0
  const mine = (userId: string) => items.filter((m) => m.userId === userId)
  return {
    items,
    async add(userId: string, input: MemoryAddInput) {
      if (input.isDemo) throw new DemoMemoryWriteRefusedError(userId)
      items.unshift({
        id: `m${++n}`,
        userId,
        memory: input.fact ?? '',
        createdAt: new Date().toISOString(),
        metadata: { scope: input.scope, ...(input.refs ?? {}) },
      })
    },
    async search(userId, query, o = {}) {
      if (opts.embedderDown) throw new Error('no embedder')
      const q = words(query)
      return mine(userId)
        .map((m) => ({ ...m, score: [...words(m.memory)].filter((w) => q.has(w)).length / Math.max(q.size, 1) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, o.limit ?? 6)
    },
    async getAll(userId) {
      return mine(userId)
    },
    async deleteAll(userId) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].userId === userId) items.splice(i, 1)
    },
    async delete(id) {
      const at = items.findIndex((m) => m.id === id)
      if (at >= 0) items.splice(at, 1)
    },
  }
}
