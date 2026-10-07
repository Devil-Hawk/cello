// The people commands refuse what the rule and the person's own rows forbid, before anything is written.

import { describe, expect, it, vi } from 'vitest'
import { conversationsPaste, networkSetRule, peopleAdd, peopleEdit, peopleImport } from './people'
import type { CommandContext } from '../define'

vi.mock('@/lib/measures/owner', () => ({ isOwner: () => false }))

describe('network.set_rule', () => {
  const ok = (rule: unknown) => networkSetRule.input.safeParse({ rule }).success
  it('refuses 0 and 31 business days and 15 days after their reply', () => {
    expect(ok({ after_yours_bd: 0 })).toBe(false)
    expect(ok({ after_yours_bd: 31 })).toBe(false)
    expect(ok({ after_theirs_d: 15 })).toBe(false)
    expect(ok({ after_yours_bd: 5, after_theirs_d: 2 })).toBe(true)
  })
  it('takes a snooze date, an off switch and a return to the default, and no other key', () => {
    expect(ok({ snooze_until: '2026-03-20' })).toBe(true)
    expect(ok({ snooze_until: 'next week' })).toBe(false)
    expect(ok({ off: true })).toBe(true)
    expect(ok(null)).toBe(true)
    expect(ok({ turbo: 1 })).toBe(false)
  })
})

describe('people input', () => {
  it('a person needs a name, and an email must look like one', () => {
    expect(peopleAdd.input.safeParse({ name: '' }).success).toBe(false)
    expect(peopleAdd.input.safeParse({ name: 'Dana Lee', email: 'not an email' }).success).toBe(false)
    expect(peopleAdd.input.safeParse({ name: 'Dana Lee', email: 'DANA@ramp.com' }).data?.email).toBe('dana@ramp.com')
  })
  it('refuses a forged owner and an unknown field', () => {
    expect(peopleEdit.input.safeParse({ id: 'c1', user_id: 'someone-else' }).success).toBe(false)
    expect(peopleImport.input.safeParse({ rows: [] }).success).toBe(false)
  })
})

describe('conversations.paste', () => {
  it('needs the email’s text, and refuses a forged owner', () => {
    expect(conversationsPaste.input.safeParse({ subject: 'Hi', body: '' }).success).toBe(false)
    expect(conversationsPaste.input.safeParse({ subject: 'Hi', body: 'Can you talk?', user_id: 'x' }).success).toBe(false)
    expect(conversationsPaste.input.safeParse({ from: 'M@Petrichor.ai', subject: 'Hi', body: 'Can you talk?' }).data?.from).toBe('m@petrichor.ai')
  })
  it('stores the first lines as the person’s own mail, tied to a known contact, never the whole body', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }))
    const chain: Record<string, unknown> = {}
    for (const k of ['select', 'eq', 'ilike', 'limit']) chain[k] = () => chain
    chain.maybeSingle = async () => ({ data: { id: 'c1' } })
    const ctx = { userId: 'u1', supabase: { from: () => chain }, admin: () => ({ from: () => ({ insert }) }) } as unknown as CommandContext
    const body = Array.from({ length: 12 }, (_, n) => `line ${n}`).join('\n')
    const out = await conversationsPaste.run(ctx, { from: 'marcus@petrichor.ai', subject: 'Tuesday', body })
    expect(out).toEqual({ ok: true, matched: true })
    const row = insert.mock.calls[0][0]
    expect(row).toMatchObject({ user_id: 'u1', contact_id: 'c1', direction: 'in', kind: 'reply', origin: 'person', trust: 'person', from_domain: 'petrichor.ai' })
    expect(String(row.gmail_message_id)).toMatch(/^paste:/)
    expect(String(row.excerpt).split('\n')).toHaveLength(6)
  })
})
