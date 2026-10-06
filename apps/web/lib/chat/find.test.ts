import { describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { findThings } from './find'

// The fake admin has no ilike, so this stands in for the database: it records what each read asked for and answers per table.
function db(tables: Record<string, unknown[]>) {
  const asked: { table: string; user: unknown; pattern: unknown }[] = []
  const client = {
    from: (table: string) => {
      const ask: { user?: unknown; pattern?: unknown } = {}
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = (_c: string, v: unknown) => ((ask.user = v), q)
      q.ilike = (_c: string, v: unknown) => ((ask.pattern = v), q)
      q.limit = () => (asked.push({ table, user: ask.user, pattern: ask.pattern }), Promise.resolve({ data: tables[table] ?? [] }))
      return q
    },
  }
  return { client: client as unknown as AdminClient, asked }
}

describe('findThings', () => {
  it('finds each kind by name, scoped to the person, with the company beside a role', async () => {
    const { client, asked } = db({
      person_roles: [{ job_id: 'j1', jobs: { title: 'Staff Engineer', companies: { name: 'Ramp' } } }],
      companies: [{ id: 'c1', name: 'Ramp' }],
      contacts: [{ id: 'p1', name: 'Rae Ramos', title: 'Recruiter' }],
      chats: [{ id: 'k1', title: '' }],
      artifacts: [{ id: 'm1', title: 'Ramp resume', type: 'cover_letter' }],
    })
    const out = await findThings(client, 'u1', 'ra')
    expect(out).toEqual([
      { kind: 'role', id: 'j1', name: 'Staff Engineer', detail: 'Ramp' },
      { kind: 'company', id: 'c1', name: 'Ramp', detail: null },
      { kind: 'person', id: 'p1', name: 'Rae Ramos', detail: 'Recruiter' },
      { kind: 'chat', id: 'k1', name: 'New chat', detail: null },
      { kind: 'made', id: 'm1', name: 'Ramp resume', detail: 'cover letter' },
    ])
    expect(asked).toHaveLength(6)
    expect(asked.every((a) => a.user === 'u1' && a.pattern === '%ra%')).toBe(true)
  })

  it('treats pattern marks as plain text and reads nothing for empty words', async () => {
    const { client, asked } = db({})
    expect(await findThings(client, 'u1', '  ')).toEqual([])
    expect(asked).toHaveLength(0)
    await findThings(client, 'u1', '100%_off')
    expect(asked[0].pattern).toBe('%100 off%')
  })
})
