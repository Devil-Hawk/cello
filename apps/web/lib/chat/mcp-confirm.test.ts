import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { ApplyRefusal } from './proposals'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agents/user-mcp', () => ({ callUserMcpTool: call }))

import { mcpTargets } from './mcp-confirm'

const payload = { server: 'notes', tool: 'search', args: { q: 'rent' } }
const room = () => makeFakeAdmin({ chats: [{ id: 'c1', user_id: 'u1', last_turn_at: null }], chat_turns: [] })

beforeEach(() => call.mockReset())

describe('mcpTargets', () => {
  it('calls the server as the person and stores one code turn with the answer in a text block', async () => {
    call.mockResolvedValue({ ok: true, text: 'one `two` ![x](http://e.co/i.png)', isError: false })
    const db = room()
    await mcpTargets({ chatId: 'c1', isDemo: false }).mcp!(db, 'u1', payload, 'p1')
    expect(call).toHaveBeenCalledWith({ admin: db, userId: 'u1', isDemo: false }, 'notes', 'search', { q: 'rent' })
    expect(db.tables.chat_turns).toHaveLength(1)
    expect(db.tables.chat_turns[0]).toMatchObject({
      user_id: 'u1',
      chat_id: 'c1',
      kind: 'cello',
      origin: 'code',
      parts: [],
      links: [],
      prov: { step: 'mcp', proposal_id: 'p1' },
      answer: 'Ran "search" on notes. It answered:\n\n```text\none \'two\' ![x](http://e.co/i.png)\n```',
    })
    expect(db.tables.chats[0].last_turn_at).toBeTruthy()
  })

  it('cuts the text to 1,500 characters and says when the server answered with an error', async () => {
    call.mockResolvedValue({ ok: true, text: 'a'.repeat(2000), isError: true })
    const db = room()
    await mcpTargets({ chatId: 'c1', isDemo: false }).mcp!(db, 'u1', payload)
    const answer = db.tables.chat_turns[0].answer as string
    expect(answer.startsWith('"search" on notes answered with an error:\n\n```text\n')).toBe(true)
    expect(answer).toContain('a'.repeat(1500))
    expect(answer).not.toContain('a'.repeat(1501))
  })

  it('throws the refusal in its words and stores nothing', async () => {
    call.mockResolvedValue({ ok: false, reason: 'Could not reach notes.', fix: 'Try Confirm again.' })
    const db = room()
    const run = mcpTargets({ chatId: 'c1', isDemo: false }).mcp!(db, 'u1', payload)
    await expect(run).rejects.toBeInstanceOf(ApplyRefusal)
    await expect(run).rejects.toMatchObject({ message: 'Could not reach notes.', fix: 'Try Confirm again.' })
    expect(db.tables.chat_turns).toHaveLength(0)
  })

  it('stores one turn saying the call may or may not have gone through, and does not throw', async () => {
    call.mockResolvedValue({ ok: false, unsure: true, reason: 'Cello did not get an answer from notes.', fix: 'The call may or may not have gone through. Check on the server before you try again.' })
    const db = room()
    await mcpTargets({ chatId: 'c1', isDemo: false }).mcp!(db, 'u1', payload, 'p1')
    expect(db.tables.chat_turns).toHaveLength(1)
    expect(db.tables.chat_turns[0]).toMatchObject({
      kind: 'cello',
      origin: 'code',
      prov: { step: 'mcp', proposal_id: 'p1' },
      answer: 'Asked "search" on notes. No answer came back, so the call may or may not have gone through. Check on the server before you try again.',
    })
    expect(db.tables.chats[0].last_turn_at).toBeTruthy()
  })
})
