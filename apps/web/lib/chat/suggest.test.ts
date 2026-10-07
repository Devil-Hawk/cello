import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { suggestCandidates } from './extend'
import { greeting, suggest } from './suggest'

const NOW = new Date('2026-10-06T02:30:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const reaction = (n: number, over: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  job_id: `j${n}`,
  reaction: 'interested',
  job_title: `Role ${n}`,
  company_name: `Company ${n}`,
  created_at: daysAgo(n / 10),
  ...over,
})

afterEach(() => {
  suggestCandidates.length = 0
})

describe('greeting', () => {
  it('is the person\'s first name and the time of day in their zone, or a plain question with no name', () => {
    expect(greeting('Ankit Punjabi', NOW, 'America/Los_Angeles')).toBe('Evening, Ankit.')
    expect(greeting('Ankit', NOW, 'Asia/Kolkata')).toBe('Morning, Ankit.')
    expect(greeting('Ankit', new Date('2026-10-06T20:00:00Z'), 'UTC')).toBe('Evening, Ankit.')
    expect(greeting('Ankit', new Date('2026-10-06T14:00:00Z'), 'UTC')).toBe('Afternoon, Ankit.')
    expect(greeting(null, NOW, 'UTC')).toBe('What are we working on?')
    expect(greeting('  ', NOW, 'UTC')).toBe('What are we working on?')
    expect(greeting('Ankit', NOW, 'Not/AZone')).toBe('Morning, Ankit.')
  })
})

describe('suggest', () => {
  it('offers an apply, a compare and a find, in 4.13\'s order, with the things as tiles', async () => {
    const db = makeFakeAdmin({
      role_reactions: [1, 2, 3, 4, 5, 6].map((n) => reaction(n)),
      applications: [{ user_id: 'u1', job_id: 'j1' }],
    })
    const out = await suggest(db, 'u1', { name: 'Ankit', timeZone: 'UTC', now: NOW })
    expect(out.greeting).toBe('Morning, Ankit.')
    // j1 already has an application, so the apply is for the next one.
    expect(out.suggestions.map((s) => s.text)).toEqual(['Apply to the Company 2 role', 'Compare my six', 'Find new roles'])
    expect(out.suggestions[0].objects).toEqual([{ kind: 'role', ref: 'j2' }])
    expect(out.suggestions[1].objects).toHaveLength(6)
  })

  it('ignores reactions older than a week, other reactions, and other people', async () => {
    const db = makeFakeAdmin({
      role_reactions: [reaction(1, { created_at: daysAgo(9) }), reaction(2, { reaction: 'not_for_me' }), reaction(3, { user_id: 'u2' })],
      applications: [],
    })
    const out = await suggest(db, 'u1', { now: NOW })
    expect(out.suggestions.map((s) => s.text)).toEqual(['Find new roles', 'Tailor my resume for a role'])
  })

  it('caps a compare at 12 and cuts a long name at 40 characters', async () => {
    const db = makeFakeAdmin({
      role_reactions: Array.from({ length: 15 }, (_, i) => reaction(i + 1, i === 0 ? { company_name: 'A Very Long Company Name Incorporated Worldwide' } : {})),
      applications: [],
    })
    const out = await suggest(db, 'u1', { now: NOW })
    expect(out.suggestions[0].text.length).toBeLessThanOrEqual(40)
    expect(out.suggestions[0].text.endsWith('…')).toBe(true)
    expect(out.suggestions[1]).toMatchObject({ text: 'Compare my twelve' })
    expect(out.suggestions[1].objects).toHaveLength(12)
  })

  it('shows what is working only from five applications', async () => {
    const few = makeFakeAdmin({ role_reactions: [], applications: [1, 2, 3, 4].map((n) => ({ user_id: 'u1', job_id: `a${n}` })) })
    expect((await suggest(few, 'u1', { now: NOW })).suggestions.map((s) => s.text)).toEqual(['Find new roles', 'Tailor my resume for a role'])
    const many = makeFakeAdmin({ role_reactions: [], applications: [1, 2, 3, 4, 5].map((n) => ({ user_id: 'u1', job_id: `a${n}` })) })
    expect((await suggest(many, 'u1', { now: NOW })).suggestions.map((s) => s.text)).toEqual(['Find new roles', 'Tailor my resume for a role', 'What is working in my search?'])
  })

  it('puts another lane\'s candidates in their place, one per kind and never two about one object', async () => {
    suggestCandidates.push(
      { kind: 'reply', text: 'Reply to Priya at Datadog', priority: 100 },
      { kind: 'reply', text: 'Reply to someone else', priority: 99 },
      { kind: 'apply', text: 'Apply to the Company 1 role', priority: 85, objects: [{ kind: 'role', ref: 'j1' }] }
    )
    const db = makeFakeAdmin({ role_reactions: [reaction(1)], applications: [] })
    const out = await suggest(db, 'u1', { now: NOW })
    // The extra apply (85) outranks the code's (80); the code's is the same kind and is dropped; the second reply is the same kind.
    expect(out.suggestions.map((s) => s.text)).toEqual(['Reply to Priya at Datadog', 'Apply to the Company 1 role', 'Find new roles'])
  })
})
