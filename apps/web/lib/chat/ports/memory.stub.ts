// An in-memory MemoryStore for chat's tests, with an `embedderDown` switch the shared fake has no use for.

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
      const item = {
        id: `m${++n}`,
        userId,
        memory: input.fact ?? '',
        createdAt: new Date().toISOString(),
        metadata: { scope: input.scope, ...(input.refs ?? {}) },
      }
      items.unshift(item)
      return item
    },
    async get(userId, id) {
      return mine(userId).find((m) => m.id === id) ?? null
    },
    async update(userId, id, patch) {
      const m = mine(userId).find((x) => x.id === id)
      if (!m) throw new Error(`memory ${id} is not ${userId}'s to change`)
      if (patch.text !== undefined) m.memory = patch.text
      if (patch.metadata) m.metadata = { ...m.metadata, ...patch.metadata }
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
    async getAll(userId, o = {}) {
      const filters = Object.entries(o.filters ?? {})
      return mine(userId).filter((m) => filters.every(([k, v]) => m.metadata?.[k] === v))
    },
    async deleteAll(userId) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].userId === userId) items.splice(i, 1)
    },
    async delete(userId, id) {
      const at = items.findIndex((m) => m.id === id && m.userId === userId)
      if (at >= 0) items.splice(at, 1)
    },
  }
}
