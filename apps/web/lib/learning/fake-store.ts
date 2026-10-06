// An in-memory MemoryStore for tests. It keeps the rules the real one has: every call is
// scoped to a user, get/update/delete refuse another person's memory, and getAll filters
// on metadata equality. `down` makes every call fail, like an unreachable mem0.

import type { MemoryAddInput, MemoryItem, MemoryListOptions, MemoryPatch, MemoryStore } from '../memory/types'
import { DemoMemoryWriteRefusedError } from '../memory/types'

interface Row {
  id: string
  userId: string
  memory: string
  createdAt: string
  metadata: Record<string, unknown>
}

export class FakeMemoryStore implements MemoryStore {
  rows: Row[] = []
  down = false
  /** Milliseconds every read waits before answering, to test the timeout. */
  delayMs = 0
  reads = 0
  private n = 0

  private guard() {
    if (this.down) throw new Error('mem0 is unreachable')
  }

  private item(r: Row): MemoryItem {
    return { id: r.id, memory: r.memory, createdAt: r.createdAt, metadata: { ...r.metadata } }
  }

  async add(userId: string, input: MemoryAddInput): Promise<MemoryItem> {
    this.guard()
    if (input.isDemo) throw new DemoMemoryWriteRefusedError(userId)
    const row: Row = { id: `m${++this.n}`, userId, memory: input.fact, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, this.n)).toISOString(), metadata: { scope: input.scope, ...(input.refs ?? {}) } }
    this.rows.push(row)
    return this.item(row)
  }

  async get(userId: string, id: string): Promise<MemoryItem | null> {
    this.guard()
    const r = this.rows.find((x) => x.id === id && x.userId === userId)
    return r ? this.item(r) : null
  }

  async update(userId: string, id: string, patch: MemoryPatch): Promise<void> {
    this.guard()
    const r = this.rows.find((x) => x.id === id && x.userId === userId)
    if (!r) throw new Error(`memory ${id} is not ${userId}'s to change`)
    if (patch.text !== undefined) r.memory = patch.text
    if (patch.metadata) r.metadata = { ...r.metadata, ...patch.metadata }
  }

  async delete(userId: string, id: string): Promise<void> {
    this.guard()
    const i = this.rows.findIndex((x) => x.id === id && x.userId === userId)
    if (i < 0) throw new Error(`memory ${id} is not ${userId}'s to delete`)
    this.rows.splice(i, 1)
  }

  async search(userId: string, query: string, opts: { limit?: number } = {}): Promise<MemoryItem[]> {
    this.guard()
    const words = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    return this.rows
      .filter((r) => r.userId === userId)
      .map((r) => ({ r, s: (r.memory.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => words.has(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, opts.limit ?? 6)
      .map((x) => this.item(x.r))
  }

  async getAll(userId: string, opts: MemoryListOptions = {}): Promise<MemoryItem[]> {
    this.reads++
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    this.guard()
    const filters = Object.entries(opts.filters ?? {})
    return this.rows
      .filter((r) => r.userId === userId && filters.every(([k, v]) => r.metadata[k] === v))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.item(r))
  }

  async deleteAll(userId: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.userId !== userId)
  }
}
