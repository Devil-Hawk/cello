// The answer bank: what is a sensitive or specific question, what matches what, and what the person's
// Confirm does and does not change. A small in-memory client stands in for the table.

import { describe, expect, it } from 'vitest'
import { categorize, isSpecific, workAuthAnswer } from './categories'
import { classify, confirmAnswer, proposeFromChat, resolveFieldValues, saveFromAttempt, type FormField } from './index'
import { findAnswer, type BankRow } from './match'
import { normalizeQuestion, similarity } from './normalize'

type Row = Record<string, any>

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
