import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import type { Thing } from './things'
import { checkNote, fallbackSentences, NO_SENTENCE_LINE, noteText, RANKING_WORDS, routedAgent, routeIntent } from './route'

describe('routeIntent', () => {
  it('reads a find with a type, a place and a count', () => {
    expect(routeIntent('Find me data engineer roles in San Francisco')).toEqual({ kind: 'find', type: 'data engineer', place: 'San Francisco', company: null, limit: 5 })
    expect(routeIntent('Find me 3 FDE roles in SF')).toMatchObject({ type: 'FDE', place: 'SF', limit: 3 })
    expect(routeIntent('show me remote roles at Stripe')).toMatchObject({ type: null, place: 'remote', company: 'Stripe' })
  })
  it('reads a compare of the top few', () => {
    expect(routeIntent('Compare my top three')).toEqual({ kind: 'compare', n: 3 })
    expect(routeIntent('compare my top 4 roles')).toEqual({ kind: 'compare', n: 4 })
  })
  it('reads a draft only for a company the person holds', () => {
    const typed = 'Draft a short note to the Retell AI recruiter asking about the timeline'
    expect(routeIntent(typed, ['Linear', 'Retell AI'])).toEqual({ kind: 'draft', company: 'Retell AI', ask: 'the timeline' })
    expect(routeIntent(typed, ['Linear'])).toBeNull()
  })
  it('leaves everything else to the loop', () => {
    expect(routeIntent('What should I focus on this week?')).toBeNull()
  })
})

describe('checkNote', () => {
  const input = { company: 'Retell AI', title: 'Deployment Strategist', ask: 'the timeline', evidence: ['Eight years building data services.'] }
  const good = 'Subject: Deployment Strategist at Retell AI\n\nHello,\n\nI am writing about the Deployment Strategist role at Retell AI. I have eight years building data services. The work looks close to what I do best. Could you share the timeline for next steps?\n\nThank you,\nRiley Marsh'
  it('accepts a short note that names the company and role and asks the one thing', () => {
    expect(checkNote(good, input)?.subject).toBe('Deployment Strategist at Retell AI')
  })
  it('refuses placeholders, a missing ask, a wrong length and invented numbers', () => {
    expect(checkNote(good.replace('Hello,', 'Hi [Name],'), input)).toBeNull()
    expect(checkNote(good.replace('timeline', 'plans'), input)).toBeNull()
    expect(checkNote(good.replace(' The work looks close to what I do best.', ''), input)).toBeNull()
    expect(checkNote(good.replace('eight years', '12 years'), input)).toBeNull()
  })
  it('refuses a claim about what the company does and a hint of earlier contact', () => {
    const said = (sentence: string) => checkNote(good.replace(' The work looks close to what I do best.', ` ${sentence}`), input)
    expect(said('The work looks close to what I do best.')).not.toBeNull()
    expect(said("I am particularly drawn to Retell AI's focus on scalable infrastructure and real-time data processing.")).toBeNull()
    expect(said('Retell AI builds voice agents for call centers.')).toBeNull()
    expect(said('I remain keen, with continued interest in the role.')).toBeNull()
  })
})

describe('the Compare sentences', () => {
  const role = (title: string, company: string, posted: string, over: Partial<Thing> = {}): Thing => ({ kind: 'role', id: title, title, company, place: 'Remote, US', pay: null, chance: null, posted, notes: [], ...over })
  // The first run of chat 6b7864ff: Solutions Architect AI was posted 2026-10-08, the same day as the Deployment Strategist.
  const roles = [role('Solutions Architect, AI', 'Stripe', '2026-10-08'), role('Deployment Strategist', 'Retell AI', '2026-10-08'), role('Machine Learning Engineer, Radar', 'Stripe', '2026-10-07')]

  it('refuses a model sentence that ranks one role over the others', () => {
    expect(RANKING_WORDS.test('Look at the Machine Learning Engineer, Radar role next, making it the most recently listed role after the Deployment Strategist.')).toBe(true)
    expect(RANKING_WORDS.test('Look at the Machine Learning Engineer, Radar role at Stripe next, which was posted on 2026-10-07.')).toBe(false)
  })
  it('says "the newest" only when the dates prove it', () => {
    const text = fallbackSentences(roles)
    expect(text).not.toMatch(/newest/)
    expect(fallbackSentences([role('A', 'X', '2026-10-09'), role('B', 'Y', '2026-10-08')])).toMatch(/posted 2026-10-09, the newest of these 2/)
  })
  it('puts the role with a stated chance and pay first, and says why from the rows', () => {
    const text = fallbackSentences([role('A', 'X', '2026-10-09'), role('B', 'Y', '2026-10-01', { chance: 'strong', pay: '$150k to $190k' })])
    expect(text).toMatch(/^Apply to B at Y first, because you have a strong chance there and it states its pay, \$150k to \$190k/)
    expect(text).not.toMatch(/[\u2014\u2013!]/)
  })
})

describe('noteText', () => {
  it('signs a note once', () => {
    const text = noteText({ title: 'Deployment Strategist', company: 'Retell AI', strength: 'I have eight years building data services.', askLine: 'Could you tell me about the timeline?', name: 'Riley Marsh' })
    expect(text.split('\n').filter((l) => /thank/i.test(l))).toHaveLength(1)
    expect(text.endsWith('Thank you,\nRiley Marsh')).toBe(true)
    expect(checkNote(text, { company: 'Retell AI', title: 'Deployment Strategist', ask: 'the timeline', evidence: ['Eight years building data services.'] })).not.toBeNull()
  })
})

const ROLE = { kind: 'role' as const, id: 'j1', title: 'Product Solutions Architect', company: 'Datadog', place: 'New York', pay: null, chance: null, posted: '2026-10-01', notes: [] }
vi.mock('@/lib/models/ask', () => ({ askModel: async () => null }))
vi.mock('@/lib/commands', async (orig) => ({ ...(await orig<typeof import('@/lib/commands')>()), runCommand: async () => ({ sentence: 'Found 1 role.', things: [ROLE] }) }))

describe('the routed draft when no model sentence passes the checks', () => {
  it('ends the worker row failed with a plain reason, makes nothing, and says that reason', async () => {
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', full_name: 'Riley Marsh', resume_text: 'Led FinOps at Acme for three years and cut cloud spend by a third.' }], agent_tasks: [], artifacts: [] })
    const deps = { db, userId: 'u1', keys: { userId: 'u1' } as DecryptedApiKeys, ran: { rung: 'R3' as const, model: 'x:free', effort: 'low' as const } }
    const agent = routedAgent(deps, async () => { throw new Error('the loop must not run') }, async () => ['Datadog'])
    const out = await agent({ chatId: 'c1', turnId: 't1', screen: null, typed: 'Draft a short note to Datadog asking about the timeline', feedback: null, returned: new Set() })
    expect(out.answer.parts.map((p) => p.text)).toEqual([NO_SENTENCE_LINE])
    expect(out.made).toEqual([])
    expect(db.tables.artifacts).toHaveLength(0)
    expect(db.tables.agent_tasks).toHaveLength(1)
    expect(db.tables.agent_tasks[0]).toMatchObject({ command: 'documents.draft', title: 'Writing a message', status: 'failed', summary: NO_SENTENCE_LINE })
  })
})

describe('the route each answer reports', () => {
  const mk = (fallback = async () => ({ answer: { parts: [{ about: [], text: 'From the loop.' }] }, results: [] })) => {
    const db = makeFakeAdmin({ profiles: [], person_roles: [], llm_spend: [], agent_tasks: [], artifacts: [] })
    const deps = { db, userId: 'u1', keys: { userId: 'u1' } as DecryptedApiKeys, ran: { rung: 'R3' as const, model: 'x:free', effort: 'low' as const } }
    return routedAgent(deps, fallback, async () => ['Datadog'])
  }
  const ask = (typed: string, extra: { screen?: string | null } = {}) => ({ chatId: 'c1', turnId: 't1', screen: extra.screen ?? null, typed, feedback: null, returned: new Set<string>() })

  it('says find, compare and draft for the code paths', async () => {
    expect((await mk()(ask('Find me data engineer roles in New York'))).route).toBe('find')
    expect((await mk()(ask('Compare my top three'))).route).toBe('compare')
    expect((await mk()(ask('Draft a short note to Datadog asking about the timeline'))).route).toBe('draft')
  })

  it('says loop, with the fallback answer intact, for tiles on the screen and for a line with no intent', async () => {
    const onScreen = await mk()(ask('Find me data engineer roles in New York', { screen: '<untrusted_data source="screen">x</untrusted_data>' }))
    expect(onScreen.route).toBe('loop')
    expect(onScreen.answer.parts[0].text).toBe('From the loop.')
    const none = await mk()(ask('What should I focus on this week?'))
    expect(none.route).toBe('loop')
    expect(none.answer.parts[0].text).toBe('From the loop.')
  })
})
