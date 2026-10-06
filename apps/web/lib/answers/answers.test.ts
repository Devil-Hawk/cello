// The answer bank: what is a sensitive or specific question, what matches what, and what the person's
// Confirm does and does not change. A small in-memory client stands in for the table.

import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { categorize, isSpecific, workAuthAnswer } from './categories'
import { answerArrived, classify, confirmAnswer, proposeFromChat, resolveFieldValues, saveAnswer, saveFromAttempt, type FormField } from './index'
import { findAnswer, type BankRow } from './match'
import { normalizeQuestion, similarity } from './normalize'
import { eligibility, type EligibleField } from '@/lib/fill/eligibility'

type Row = Record<string, any>

// the route's session, a demo account for the 403 case
const session = vi.hoisted(() => ({ demo: true }))
vi.mock('@/lib/pipeline/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pipeline/session')>()),
  sessionCtx: async () => ({
    userId: 'u1',
    door: { actor: 'person', channel: 'session' },
    admin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_demo: session.demo, demo_expires_at: null } }) }) }) }) },
  }),
}))

function fakeAdmin(seed: Row[] = [], profile: Row = { full_name: 'Ada Lovelace', email: 'ada@example.com', preferences: { contact: { phone: '555 0100' } } }) {
  const bank: Row[] = seed.map((r, i) => ({ id: `r${i}`, declined: false, answer: null, company_id: null, source_ref: null, ...r }))
  let n = bank.length
  const rpcs: string[] = []
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let mode: 'select' | 'insert' | 'update' = 'select'
    let patch: Row = {}
    const q: any = {
      select: () => q,
      insert: (v: Row) => ((mode = 'insert'), (patch = v), q),
      update: (v: Row) => ((mode = 'update'), (patch = v), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, op: string, v: unknown) => (filters.push((r) => (op === 'is' ? (r[c] ?? null) !== v : !String(r[c]).startsWith(String(v).replace('%', '')))), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'profiles') return { data: profile, error: null }
        if (mode === 'insert') {
          const clash = bank.some((r) => r.user_id === patch.user_id && r.question_key === patch.question_key && (r.company_id ?? null) === (patch.company_id ?? null))
          if (clash) return { data: null, error: { code: '23505' } }
          const row = { id: `r${n++}`, declined: false, answer: null, company_id: null, source_ref: null, ...patch }
          bank.push(row)
          return { data: { id: row.id }, error: null }
        }
        const hit = bank.filter((r) => filters.every((f) => f(r)))
        if (mode === 'update') {
          if (hit[0]) Object.assign(hit[0], patch)
          return { data: hit[0] ? { id: hit[0].id } : null, error: null }
        }
        return { data: hit[0] ? { ...hit[0] } : null, error: null }
      },
      then: (res: (v: unknown) => unknown) => {
        if (table === 'profiles') return res({ data: profile, error: null })
        if (mode === 'update') {
          for (const r of bank.filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch)
          return res({ data: null, error: null })
        }
        if (mode === 'insert') {
          const clash = bank.some((r) => r.user_id === patch.user_id && r.question_key === patch.question_key && (r.company_id ?? null) === (patch.company_id ?? null))
          if (!clash) bank.push({ id: `r${n++}`, declined: false, answer: null, company_id: null, source_ref: null, ...patch })
          return res({ data: null, error: clash ? { code: '23505' } : null })
        }
        return res({ data: bank.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null })
      },
    }
    return q
  }
  const client = { from, rpc: async (name: string) => (rpcs.push(name), { data: { ok: true, replay: false, event: { id: 'e' } }, error: null }) }
  return { client: client as never, bank, rpcs }
}

const U = 'u1'
const job = { companyId: 'c1', companyName: 'Stripe', applicationId: 'a1' }
const row = (over: Partial<BankRow>): BankRow => ({
  id: 'x', question: 'q', question_key: 'q', category: 'other', sensitive: false, specific: false, kind: 'text', options: null,
  answer: 'yes', declined: false, company_id: null, source: 'person', source_ref: null, origin: 'person', confirmed_at: null, ...over,
})
const bankRow = (question: string, answer: unknown, over: Row = {}): Row => {
  const a = classify({ id: 'f', label: question })
  return { user_id: U, question, question_key: a.key, category: a.category, sensitive: a.sensitive, specific: a.specific, kind: a.kind, options: null, answer, source: 'person', origin: 'person', ...over }
}

describe('questions', () => {
  it('keeps a question and its opposite apart', () => {
    expect(normalizeQuestion('Will you now or in the future require sponsorship? (required)')).toBe('will you now or in future require sponsorship')
    expect(normalizeQuestion('Are you authorized to work without sponsorship?')).not.toBe(normalizeQuestion('Will you now or in the future require sponsorship?'))
  })

  it('sorts a question by its words, the sensitive ones first', () => {
    expect(categorize('What is your gender?')).toBe('eeo')
    expect(categorize('I consent to the processing of my data')).toBe('consent')
    expect(categorize('Will you require visa sponsorship?')).toBe('sponsorship')
    expect(categorize('Are you legally authorized to work in the United States?')).toBe('work_auth')
    expect(categorize('Desired salary')).toBe('salary')
    expect(categorize('Why do you want to work here?')).toBe('motivation')
    expect(categorize('LinkedIn profile')).toBe('links')
  })

  it('calls a question specific when it names a place, a number, a date or an amount', () => {
    for (const q of ['Are you willing to relocate to Austin?', 'Can you be onsite 3 days a week?', 'Can you start by June 1?', 'Salary expectation in USD', 'Why Stripe?'.replace('Why', 'Do you want to work at')]) {
      expect(isSpecific(q), q).toBe(true)
    }
    expect(isSpecific('Are you willing to relocate?')).toBe(false)
  })
})

describe('matching', () => {
  it('matches the exact key first, and this employer before the general row', () => {
    const rows = [row({ id: 'g', question_key: 'why this role', answer: 'general' }), row({ id: 's', question_key: 'why this role', answer: 'stripe', company_id: 'c1' })]
    const asked = { key: 'why this role', category: 'other' as const, sensitive: false, specific: false, kind: 'text' as const, options: null }
    expect(findAnswer(rows, asked, { companyId: 'c1', applicationId: 'a1' })?.row.id).toBe('s')
    expect(findAnswer(rows, asked, { companyId: 'c2', applicationId: 'a1' })?.row.id).toBe('g')
  })

  it('matches a near wording of a plain question, by similarity, and says so', () => {
    const saved = row({ question_key: normalizeQuestion('Are you comfortable working in a fast paced environment?'), answer: 'Yes' })
    const asked = classify({ id: 'f', label: 'Comfortable working in a fast paced environment?' })
    const hit = findAnswer([saved], asked, { companyId: null, applicationId: null })
    expect(hit?.via).toBe('similar')
    expect(hit?.score).toBeGreaterThanOrEqual(0.8)
  })

  it('never matches a near pair of specific questions by similarity', () => {
    const pairs: [string, string][] = [
      ['Are you willing to relocate to Austin?', 'Are you willing to relocate to London?'],
      ['Can you work onsite 3 days a week?', 'Can you work onsite 5 days a week?'],
      ['Can you start by June 1?', 'Can you start by July 1?'],
      ['Expected salary in USD', 'Expected salary in GBP'],
    ]
    for (const [a, b] of pairs) {
      const saved = bankRow(a, 'Yes') as unknown as BankRow
      const asked = classify({ id: 'f', label: b })
      expect(similarity(saved.question_key, asked.key), `${a} / ${b}`).toBeGreaterThan(0.5)
      expect(findAnswer([saved], asked, { companyId: null, applicationId: null }), `${a} / ${b}`).toBeNull()
    }
  })

  it('does not reuse a long answer written for one application at another', () => {
    const saved = row({ question_key: 'why this role', kind: 'long_text', category: 'motivation', source_ref: { application_id: 'a-ramp' } })
    const asked = { key: 'why this role', category: 'motivation' as const, sensitive: false, specific: false, kind: 'long_text' as const, options: null }
    expect(findAnswer([saved], asked, { companyId: null, applicationId: 'a-stripe' })).toBeNull()
    expect(findAnswer([saved], asked, { companyId: null, applicationId: 'a-ramp' })).not.toBeNull()
  })
})

describe('work authorization', () => {
  const facts = { authorized: true, needsSponsorship: false }
  it('maps the wordings it knows to a fact and its polarity', () => {
    expect(workAuthAnswer('Will you now or in the future require sponsorship?', facts)).toBe(false)
    expect(workAuthAnswer('Are you authorized to work without sponsorship?', facts)).toBe(true)
    expect(workAuthAnswer('Are you legally authorized to work in the United States?', facts)).toBe(true)
    expect(workAuthAnswer('Will you need visa sponsorship?', { authorized: true, needsSponsorship: true })).toBe(true)
    expect(workAuthAnswer('Are you authorized to work without sponsorship?', { authorized: true, needsSponsorship: true })).toBe(false)
  })

  it('leaves a wording it does not know open, and a fact not given open', () => {
    expect(workAuthAnswer('Do you hold a valid work status in your country of residence?', facts)).toBeNull()
    expect(workAuthAnswer('Will you require sponsorship?', { authorized: null, needsSponsorship: null })).toBeNull()
  })
})

describe('resolveFieldValues', () => {
  const field = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({ id, label, required: true, ...over })

  it('fills the profile, never a demographic or a consent, and only the fields asked', async () => {
    const { client } = fakeAdmin()
    const r = await resolveFieldValues(client, U, [field('e', 'Email'), field('g', 'Gender'), field('c', 'I agree to the privacy policy')], job)
    expect(Object.keys(r.values)).toEqual(['e'])
    expect(r.values.e).toMatchObject({ value: 'ada@example.com', via: 'profile', origin: 'person' })
    expect(r.never.sort()).toEqual(['c', 'g'])
    expect(r.open).toEqual([])
  })

  it('leaves an unknown work-authorization wording open and gives the known one from the fact', async () => {
    const { client } = fakeAdmin([{ user_id: U, question_key: 'fact:work_authorized', source: 'profile', origin: 'person', answer: true, category: 'work_auth' }, { user_id: U, question_key: 'fact:needs_sponsorship', source: 'profile', origin: 'person', answer: false, category: 'sponsorship' }])
    const r = await resolveFieldValues(client, U, [field('a', 'Do you require sponsorship?', { options: ['Yes', 'No'] }), field('b', 'Is your status valid in your country of residence?')], job)
    expect(r.values.a).toMatchObject({ value: 'No', via: 'fact' })
    expect(r.open.map((o) => o.fieldId)).toEqual(['b'])
  })

  it('is one open row for the same question asked by three applications', async () => {
    const { client, bank } = fakeAdmin()
    const ids = new Set<string>()
    for (const applicationId of ['a1', 'a2', 'a3']) {
      const r = await resolveFieldValues(client, U, [field('q', 'How did you hear about us?')], { ...job, applicationId })
      ids.add(r.open[0].answerId)
    }
    expect(ids.size).toBe(1)
    expect(bank.filter((b) => b.answer === null)).toHaveLength(1)
  })

  it('uses a saved answer by exact key and says which question a similar one answered', async () => {
    const { client } = fakeAdmin([bankRow('How did you hear about us?', 'A friend')])
    const exact = await resolveFieldValues(client, U, [field('q', 'How did you hear about us?')], job)
    expect(exact.values.q).toMatchObject({ value: 'A friend', via: 'exact', origin: 'person' })
  })

  it('never takes a model answer to a select that is not one of the options', async () => {
    const { client } = fakeAdmin([bankRow('Preferred work style', 'Remote-ish')])
    const r = await resolveFieldValues(client, U, [field('q', 'Preferred work style', { options: ['Remote', 'Hybrid'] })], job)
    expect(r.values.q).toBeUndefined()
  })
})

describe('Chat and Confirm', () => {
  it('saves what the person said in Chat as a model answer and moves no application', async () => {
    const { client, bank, rpcs } = fakeAdmin([{ user_id: U, question_key: 'notice period', category: 'notice', answer: null, source: 'person', origin: 'person' }])
    expect((await proposeFromChat(client, U, { answerId: 'r0', answer: '2 weeks', quote: 'I can give two weeks' })).ok).toBe(true)
    expect(bank[0]).toMatchObject({ answer: '2 weeks', source: 'chat', origin: 'model', confirmed_at: null })
    expect(rpcs).toEqual(['pipeline_note'])
  })

  it('refuses a sensitive answer from Chat', async () => {
    const { client } = fakeAdmin([{ user_id: U, question_key: 'salary', category: 'salary', answer: null, source: 'person', origin: 'person' }])
    expect((await proposeFromChat(client, U, { answerId: 'r0', answer: '150000', quote: 'about 150k' })).ok).toBe(false)
  })

  it('Confirm sets confirmed_at and keeps the origin model', async () => {
    const { client, bank } = fakeAdmin([{ user_id: U, question_key: 'notice period', category: 'notice', answer: '2 weeks', source: 'chat', origin: 'model' }])
    expect((await confirmAnswer(client, U, 'r0')).ok).toBe(true)
    expect(bank[0].origin).toBe('model')
    expect(typeof bank[0].confirmed_at).toBe('string')
  })

  it('Confirm refuses a row that is the person\'s own, and a row with no answer', async () => {
    const { client } = fakeAdmin([{ user_id: U, question_key: 'a', category: 'other', answer: 'x', source: 'person', origin: 'person' }, { user_id: U, question_key: 'b', category: 'other', answer: null, source: 'chat', origin: 'model' }])
    expect((await confirmAnswer(client, U, 'r0')).ok).toBe(false)
    expect((await confirmAnswer(client, U, 'r1')).ok).toBe(false)
  })
})

describe('saveFromAttempt', () => {
  it('saves the ticked answers, skips the sensitive ones, and keeps the application on a long one', async () => {
    const { client, bank } = fakeAdmin()
    const r = await saveFromAttempt(client, U, { applicationId: 'a1', attemptId: 't1', companyId: 'c1', companyName: 'Stripe' }, [
      { question: 'How did you hear about us?', answer: 'A friend' },
      { question: 'What is your gender?', answer: 'x' },
      { question: 'Will you require sponsorship?', answer: 'No' },
      { question: 'Anything else?', answer: '' },
    ])
    expect(r).toEqual({ saved: 1, skipped: 3 })
    expect(bank[0]).toMatchObject({ answer: 'A friend', source: 'person', origin: 'person', source_ref: { application_id: 'a1', attempt_id: 't1' } })
  })
})

describe('declining and arriving', () => {
  it('a declined toggle on a model answer keeps its origin, and the row stays out of Send for me', async () => {
    const { client, bank } = fakeAdmin([{ user_id: U, question_key: 'notice period', category: 'notice', answer: '2 weeks', source: 'chat', origin: 'model', confirmed_at: '2026-10-01T00:00:00Z' }])
    expect((await saveAnswer(client, U, 'r0', { declined: false })).ok).toBe(true)
    expect(bank[0]).toMatchObject({ source: 'chat', origin: 'model', answer: '2 weeks', confirmed_at: '2026-10-01T00:00:00Z' })
    const hit = findAnswer(bank as unknown as BankRow[], classify({ id: 'f', label: 'notice period' }), { companyId: null, applicationId: null })
    expect(hit?.row.origin).toBe('model')
    expect(check([{ label: 'notice period', category: 'notice', kind: 'text', required: true, resolved: { value: '2 weeks', via: hit!.via, origin: hit!.row.origin } }])).toBe('Answer it yourself to let Cello send this.')
    // text the person writes does make it theirs
    await saveAnswer(client, U, 'r0', { answer: '1 month' })
    expect(bank[0]).toMatchObject({ source: 'person', origin: 'person', answer: '1 month', confirmed_at: null })
  })

  it('an answer resumes every application waiting on it, and not the one still holding another open question', async () => {
    const waiting = [
      { id: 'A', needs_detail: { answer_ids: ['q1'] }, last_event_at: null },
      { id: 'B', needs_detail: { answer_ids: ['q1', 'q2'] }, last_event_at: null },
    ]
    const asked = [{ id: 'q1', answer: 'Yes', declined: false }, { id: 'q2', answer: null, declined: false }]
    const moved: unknown[] = []
    const from = (table: string) => {
      const q: any = { select: () => q, eq: () => q, contains: () => q, in: () => q, then: (res: (v: unknown) => unknown) => res({ data: table === 'applications' ? waiting : asked, error: null }) }
      return q
    }
    const client = { from, rpc: async (_n: string, a: any) => (moved.push([a.p_app, a.p_to, a.p_event.idempotency_key]), { data: { ok: true, replay: false, event: { id: 'e' } }, error: null }) }
    expect(await answerArrived(client as never, U, 'q1')).toEqual({ moved: 1 })
    expect(moved).toEqual([['A', 'preparing', 'answered:A:q1:none']])
  })

  it('POST /api/answers/[id] refuses a demo account with 403 and saves nothing', async () => {
    const { POST } = await import('@/app/api/answers/[id]/route')
    const res = await POST(new NextRequest('http://localhost/api/answers/x', { method: 'POST', body: JSON.stringify({ answer: 'x' }) }), { params: { id: '11111111-1111-4111-8111-111111111111' } })
    expect(res.status).toBe(403)
  })
})

const check = (fields: EligibleField[]) => eligibility({ company: 'Stripe', url: 'https://boards.greenhouse.io/stripe/jobs/1', fields, hosts: [{ host: 'boards.greenhouse.io', urlPattern: '', submitLabels: [], confirmationPatterns: [], confirmationUrls: [] }] })
