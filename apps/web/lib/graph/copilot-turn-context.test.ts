// Tests for lib/graph/copilot.ts's Step 7 turn-assembly composition:
// assembleTurnContext (rolling summary + last-12 verbatim + memory search)
// and refreshConversationSummary (the post-turn summary refresh). Real
// mem0-store is mocked so this never touches a real Memory instance.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'

const loadApiKeysMock = vi.fn(async (..._args: unknown[]) => ({ userId: 'u1' }) as never)
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

const callLlmMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callLlm: (...args: unknown[]) => callLlmMock(...args) }
})

const searchMock = vi.fn(async (..._args: unknown[]) => [] as { id: string; memory: string }[])
vi.mock('../memory/mem0-store', () => ({
  getMemoryStore: () => ({ search: (...args: unknown[]) => searchMock(...args) }),
}))

const { assembleTurnContext, refreshConversationSummary } = await import('./copilot')

interface MessageRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

/** A fake admin scoped to exactly the two tables/queries this file's
 *  functions touch: copilot_conversations (summary read/write) and
 *  copilot_messages (loadRecentMessages' own query shape). */
function fakeAdmin(opts: { summary?: string | null; summaryThroughId?: string | null; messages: MessageRow[] }): {
  admin: AdminClient
  updates: Record<string, unknown>[]
} {
  const updates: Record<string, unknown>[] = []
  const admin = {
    from: (table: string) => {
      if (table === 'copilot_conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { summary: opts.summary ?? null, summary_through_message_id: opts.summaryThroughId ?? null },
                error: null,
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              updates.push(patch)
              return { data: null, error: null }
            },
          }),
        }
      }
      if (table === 'copilot_messages') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async (n: number) => ({ data: opts.messages.slice(-n).slice().reverse(), error: null }),
              }),
            }),
          }),
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
  } as unknown as AdminClient
  return { admin, updates }
}

const CFG = { userId: 'u1', threadId: 't1', runId: 'r1', conversationId: 'c1' }

beforeEach(() => {
  loadApiKeysMock.mockClear()
  callLlmMock.mockReset()
  searchMock.mockReset()
  searchMock.mockResolvedValue([])
})

describe('assembleTurnContext — all composition pieces present', () => {
  it('carries the rolling summary into summaryBlock', async () => {
    const { admin } = fakeAdmin({ summary: 'User is targeting backend roles in NYC.', messages: [] })
    const { summaryBlock } = await assembleTurnContext(admin, CFG, 'hello')
    expect(summaryBlock).toContain('User is targeting backend roles in NYC.')
  })

  it('is empty when there is no summary yet', async () => {
    const { admin } = fakeAdmin({ summary: null, messages: [] })
    const { summaryBlock } = await assembleTurnContext(admin, CFG, 'hello')
    expect(summaryBlock).toBe('')
  })

  it('returns the last messages verbatim, oldest first, without duplicating the current one', async () => {
    const rows: MessageRow[] = [
      { id: 'm1', role: 'user', content: 'first question', created_at: '2026-01-01T00:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'first answer', created_at: '2026-01-01T00:00:01Z' },
      { id: 'm3', role: 'user', content: 'current message', created_at: '2026-01-01T00:00:02Z' },
    ]
    const { admin } = fakeAdmin({ messages: rows })
    const { recentMessages } = await assembleTurnContext(admin, CFG, 'current message')
    expect(recentMessages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'current message' },
    ])
  })

  it('appends the current message when it was not already persisted (e.g. a persistence failure)', async () => {
    const { admin } = fakeAdmin({ messages: [{ id: 'm1', role: 'user', content: 'older', created_at: '2026-01-01T00:00:00Z' }] })
    const { recentMessages } = await assembleTurnContext(admin, CFG, 'brand new message')
    expect(recentMessages.at(-1)).toEqual({ role: 'user', content: 'brand new message' })
  })

  it('folds MemoryStore.search results into memoryBlock, scoped to this user and query', async () => {
    searchMock.mockResolvedValueOnce([{ id: 'mem1', memory: 'Prefers remote roles' }])
    const { admin } = fakeAdmin({ messages: [] })
    const { memoryBlock } = await assembleTurnContext(admin, CFG, 'find me a job')
    expect(searchMock).toHaveBeenCalledWith('u1', 'find me a job', { limit: 6 })
    expect(memoryBlock).toContain('Prefers remote roles')
  })

  it('degrades gracefully (empty memoryBlock, no throw) when MemoryStore.search fails', async () => {
    searchMock.mockRejectedValueOnce(new Error('mem0 down'))
    const { admin } = fakeAdmin({ messages: [] })
    const { memoryBlock } = await assembleTurnContext(admin, CFG, 'find me a job')
    expect(memoryBlock).toBe('')
  })

  it('skips memory search entirely for an empty current message', async () => {
    const { admin } = fakeAdmin({ messages: [] })
    await assembleTurnContext(admin, CFG, '')
    expect(searchMock).not.toHaveBeenCalled()
  })
})

describe('refreshConversationSummary — post-turn, never blocking the caller with a throw', () => {
  it('does nothing below the 12-message threshold', async () => {
    const rows: MessageRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
      created_at: `2026-01-01T00:00:0${i}Z`,
    }))
    const { admin, updates } = fakeAdmin({ messages: rows })
    await refreshConversationSummary(admin, 'u1', 'c1')
    expect(callLlmMock).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('refreshes once the unsummarized tail reaches 12, via the cheap metered path', async () => {
    const rows: MessageRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
      created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    }))
    callLlmMock.mockResolvedValueOnce({ content: 'Updated rolling summary.', tokensUsed: 10, promptTokens: 8, completionTokens: 2, model: 'x' })
    const { admin, updates } = fakeAdmin({ messages: rows })
    await refreshConversationSummary(admin, 'u1', 'c1')
    expect(loadApiKeysMock).toHaveBeenCalledWith(admin, 'u1')
    expect(callLlmMock).toHaveBeenCalledTimes(1)
    const opts = callLlmMock.mock.calls[0]![1] as { model: string }
    expect(opts.model).toBe('anthropic/claude-haiku-4.5')
    expect(updates).toEqual([{ summary: 'Updated rolling summary.', summary_through_message_id: 'm11' }])
  })

  it('only summarizes the tail AFTER summary_through_message_id, not the whole history again', async () => {
    const rows: MessageRow[] = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
      created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    }))
    callLlmMock.mockResolvedValueOnce({ content: 'v2 summary', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'x' })
    const { admin, updates } = fakeAdmin({ summary: 'v1 summary', summaryThroughId: 'm2', messages: rows })
    await refreshConversationSummary(admin, 'u1', 'c1')
    const prompt = callLlmMock.mock.calls[0]![1] as { prompt: string }
    expect(prompt.prompt).toContain('v1 summary')
    expect(prompt.prompt).not.toContain('msg 0')
    expect(prompt.prompt).toContain('msg 3')
    expect(updates).toEqual([{ summary: 'v2 summary', summary_through_message_id: 'm14' }])
  })

  it('never throws — a callLlm failure just leaves the summary stale', async () => {
    const rows: MessageRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `msg ${i}`,
      created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    }))
    callLlmMock.mockRejectedValueOnce(new Error('budget cap'))
    const { admin, updates } = fakeAdmin({ messages: rows })
    await expect(refreshConversationSummary(admin, 'u1', 'c1')).resolves.toBeUndefined()
    expect(updates).toEqual([])
  })
})
