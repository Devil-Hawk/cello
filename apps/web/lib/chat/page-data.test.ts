import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { loadChatPage } from './page-data'
import type { ObjectReader } from './types'

// roleView (behind the card and the reader stub) comes from the scoring module; both are replaced here.
vi.mock('@/lib/agents/scoring-port', () => ({
  roleView: async (_db: unknown, userId: string, id: string) =>
    userId === 'u1' && id === 'r1' ? { jobId: 'r1', title: 'Payments role', company: 'Vantage Loom', companyId: 'c1', location: 'New York', chance: 'strong', salary: '$190,000', postedAt: null } : null,
}))

const get: ObjectReader = async (_db, userId, kind, ref) => (userId === 'u1' && ref.id !== 'gone' ? { kind, id: ref.id, title: `Title of ${ref.id}`, company: null, facts: [], body: null } : null)

const seed = () =>
  makeFakeAdmin({
    chats: [
      { id: 'c1', user_id: 'u1', title: 'Mine' },
      { id: 'c2', user_id: 'u2', title: 'Theirs' },
    ],
    chat_turns: [
      { id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'compare', created_at: '2026-10-05T10:00:00Z', parts: [] },
      {
        id: 't2',
        user_id: 'u1',
        chat_id: 'c1',
        kind: 'cello',
        created_at: '2026-10-05T10:00:05Z',
        parts: [{ card: { kind: 'role', ref: 'r1' } }, { about: [], text: 'Fine.' }, { card: { kind: 'role', ref: 'r1' } }, { card: { kind: 'role', ref: 'unreadable' } }],
      },
    ],
    chat_attachments: [
      { id: 'a1', user_id: 'u1', chat_id: 'c1', position: 1, kind: 'role', ref: { id: 'r1' }, removed_at: null },
      { id: 'a2', user_id: 'u1', chat_id: 'c1', position: 2, kind: 'role', ref: { id: 'gone' }, removed_at: '2026-10-05T11:00:00Z' },
    ],
    agent_tasks: [
      { id: 'w1', user_id: 'u1', chat_id: 'c1', turn_id: 't1', title: 'Research Ramp', status: 'done', command: 'companies.research', reads: [{}], created_at: '2026-10-05T10:00:01Z' },
      { id: 'w2', user_id: 'u2', chat_id: 'c2', turn_id: 'x', title: 'Not mine', status: 'done', command: 'x', reads: [], created_at: '2026-10-05T10:00:01Z' },
    ],
    person_roles: [],
    applications: [],
    companies: [],
  })

describe('loadChatPage', () => {
  it('reads a name for every tile, detached ones too, and says no longer listed for a thing that is gone', async () => {
    const page = await loadChatPage(seed(), 'u1', 'c1', get)
    expect(page?.names).toEqual({ a1: 'Title of r1', a2: null })
  })

  it('reads one card for each subject named, and none for a subject that cannot be read', async () => {
    const page = await loadChatPage(seed(), 'u1', 'c1', get)
    expect(page?.cards.map((c) => c.id)).toEqual(['r1'])
    expect(page?.cards[0]).toMatchObject({ kind: 'role', title: 'Payments role', pay: '$190,000' })
  })

  it('lists the chat\'s workers from their rows so a reload rebuilds the tasks line', async () => {
    const page = await loadChatPage(seed(), 'u1', 'c1', get)
    expect(page?.tasks.map((t) => t.id)).toEqual(['w1'])
  })

  it('is null for another person\'s chat', async () => {
    expect(await loadChatPage(seed(), 'u2', 'c1', get)).toBeNull()
  })

  it('reads a status turn\'s words from its event row, never from the turn', async () => {
    const db = seed()
    db.tables.chat_turns.push({ id: 't3', user_id: 'u1', chat_id: 'c1', kind: 'status', typed: null, answer: 'forged words', event_id: 'e1', created_at: '2026-10-05T10:01:00Z', parts: [] })
    db.tables.pipeline_events = [{ id: 'e1', user_id: 'u1', application_id: 'app1', sentence: 'Sent.', to_state: 'sent', created_at: '2026-10-05T10:01:00Z' }]
    const page = await loadChatPage(db, 'u1', 'c1', get)
    expect(page?.statuses.e1.sentence).toBe('Sent.')
  })
})
