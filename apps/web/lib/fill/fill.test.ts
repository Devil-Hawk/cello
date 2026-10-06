// What may be sent without a click, and what the extension's routes refuse.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { findAnswer, classify, type BankRow } from '@/lib/answers/match'
import { AUTO_HOSTS, type AutoHost } from './auto-hosts'
import { eligibility, type EligibleField } from './eligibility'
import { portalOf } from './portals'
import { cleanFields } from './session'

const calls: any[] = []
const state = { app: null as any, events: [] as any[] }
vi.mock('./auth', () => ({
  fillAuth: vi.fn(async () => ({ admin: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: state.events[0] ?? null }) }) }) }) }) }) }) }, userId: 'u1', tokenId: 't1' })),
  isFillAuth: (v: unknown) => !(v instanceof NextResponse),
}))
vi.mock('./session', async (importOriginal) => ({ ...(await importOriginal<typeof import('./session')>()), loadFillApp: vi.fn(async () => state.app) }))
vi.mock('@/lib/pipeline/transition', () => ({
  transition: vi.fn(async (_a: unknown, m: any) => (calls.push(m), { ok: true, replay: false, event: { id: 'e' } })),
  note: vi.fn(async (_a: unknown, _u: string, _id: string, e: any) => (calls.push({ note: e }), { ok: true, replay: false, event: { id: 'e' } })),
  pause: vi.fn(),
}))

const HOST: AutoHost = { host: 'boards.greenhouse.io', submitLabels: ['Submit application'], confirmation: [/thank you/i] }
const URL_OK = 'https://boards.greenhouse.io/stripe/jobs/123'

const field = (over: Partial<EligibleField> = {}): EligibleField => ({
  label: 'How did you hear about us?', category: 'other', kind: 'text', required: true, resolved: { value: 'A friend', via: 'exact', origin: 'person' }, ...over,
})
const check = (fields: EligibleField[], url = URL_OK, hosts: readonly AutoHost[] = [HOST]) => eligibility({ company: 'Stripe', url, fields, hosts })

describe('eligibility', () => {
  it('allows what the person gave: profile facts and their own answers, on a listed host', () => {
    expect(check([field(), field({ category: 'contact', resolved: { value: 'ada@example.com', via: 'profile', origin: 'person' } }), field({ category: 'work_auth', resolved: { value: true, via: 'fact', origin: 'person' } })])).toBeNull()
  })

  it('refuses an approved model-drafted answer, a Chat answer the person confirmed, and a value read from the resume', () => {
    expect(check([field({ resolved: { value: 'I love Stripe', via: 'exact', origin: 'model' } })])).toBe('Answer it yourself to let Cello send this.')
    expect(check([field({ resolved: { value: 'No', via: 'exact', origin: 'model', answerId: 'a1' } })])).toBe('Answer it yourself to let Cello send this.')
    expect(check([field({ resolved: { value: '7', via: 'exact', origin: 'code' } })])).toContain('resume')
  })

  it('refuses a similar saved answer, a missing answer, a consent and a demographic', () => {
    expect(check([field({ resolved: { value: 'Yes', via: 'similar', origin: 'person' } })])).toContain('similar saved answer')
    expect(check([field({ resolved: undefined })])).toBe('A required question has no answer yet.')
    expect(check([field({ category: 'consent', resolved: undefined })])).toBe("Stripe's form asks you to agree to something. Send this one yourself.")
    expect(check([field({ category: 'eeo', resolved: undefined })])).toContain('for you to answer')
    // an optional demographic is left blank and does not stop a send
    expect(check([field({ category: 'eeo', required: false, resolved: undefined })])).toBeNull()
  })

  it('refuses a select whose answer is not exactly one of the form\'s choices', () => {
    expect(check([field({ kind: 'select', options: ['Yes', 'No'], resolved: { value: 'Maybe', via: 'exact', origin: 'person' } })])).toContain('choices')
    expect(check([field({ kind: 'select', options: ['Yes', 'No'], resolved: { value: 'yes', via: 'exact', origin: 'person' } })])).toBeNull()
  })

  it('does not take an answer written for another employer: the bank gives none, so it is open', () => {
    const ramp: BankRow = { id: 'x', question: 'Why us?', question_key: 'why us', category: 'motivation', sensitive: false, specific: false, kind: 'long_text', options: null, answer: 'Ramp is great', declined: false, company_id: 'ramp', source: 'person', source_ref: null, origin: 'person', confirmed_at: null }
    expect(findAnswer([ramp], classify({ id: 'f', label: 'Why us?', kind: 'long_text' }), { companyId: 'stripe', applicationId: 'a1' })).toBeNull()
  })

  it('says it cannot send on this site yet when no site is listed, and sends on none today', () => {
    expect(AUTO_HOSTS).toEqual([])
    expect(eligibility({ company: 'Stripe', url: URL_OK, fields: [field()] })).toBe('Cello cannot send on this site yet. Open it and click Fill.')
    expect(check([field()], 'https://jobs.lever.co/stripe/abc')).toBe('Cello cannot send on this site yet. Open it and click Fill.')
    expect(check([field()], 'not a url')).toBe('Cello cannot send on this site yet. Open it and click Fill.')
  })
})

describe('portals and fields', () => {
  it('says an account portal needs an account, and a hosted form does not', () => {
    expect(portalOf('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')?.sentence).toBe('This site needs an account.')
    expect(portalOf('https://boards.greenhouse.io/stripe/jobs/1')).toBeNull()
    expect(portalOf(null)).toBeNull()
  })

  it('takes only well-formed fields from the extension, a bounded number', () => {
    expect(cleanFields([{ id: 'a', label: 'Email', required: true }])).toEqual([{ id: 'a', label: 'Email', required: true, kind: undefined, options: undefined }])
    expect(cleanFields([{ id: 'a' }])).toBeNull()
    expect(cleanFields('x')).toBeNull()
    expect(cleanFields(Array.from({ length: 201 }, (_, i) => ({ id: `${i}`, label: 'l' })))).toBeNull()
  })
})

describe('POST /api/fill/report', () => {
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/fill/report/route')
    return POST(new NextRequest('http://localhost/api/fill/report', { method: 'POST', body: JSON.stringify(body) }))
  }
  const ID = '11111111-1111-4111-8111-111111111111'
  beforeEach(() => {
    calls.length = 0
    state.events = []
    state.app = { id: ID, user_id: 'u1', state: 'applying', posting_url_hash: 'h', auto_attempted_at: null, lease_holder: null, last_event_at: '2026-10-14T00:00:00Z', form_fields: null, job_id: 'j1', jobs: { url: 'https://boards.greenhouse.io/stripe/jobs/123', title: 'Engineer', company_id: 'c1', companies: { name: 'Stripe' } } }
  })

  it('moves a stop to Needs you with its cause, and refuses a cause it does not know', async () => {
    expect((await post({ applicationId: ID, outcome: 'blocked', cause: 'site_check', host: 'boards.greenhouse.io' })).status).toBe(200)
    expect(calls[0]).toMatchObject({ to: 'needs_you', reason: 'your_turn', detail: { cause: 'site_check' } })
    expect((await post({ applicationId: ID, outcome: 'blocked', cause: 'because' })).status).toBe(400)
  })

  it('never records an unconfirmed send as a confirmed one', async () => {
    await post({ applicationId: ID, outcome: 'submitted', confirmed: false })
    expect(calls[0].event).toMatchObject({ kind: 'submission.unconfirmed', trust: 'unconfirmed' })
    calls.length = 0
    await post({ applicationId: ID, outcome: 'submitted', confirmed: true })
    expect(calls[0].event).toMatchObject({ kind: 'submission.sent', trust: 'proven' })
  })

  it('refuses an automatic submit that Send for me never asked to make, and an unconfirmed automatic one is Did you send it?', async () => {
    state.app.auto_attempted_at = '2026-10-14T00:00:00Z'
    expect((await post({ applicationId: ID, outcome: 'submitted', confirmed: true })).status).toBe(409)
    expect(calls).toHaveLength(0)
    state.events = [{ id: 'sending' }]
    await post({ applicationId: ID, outcome: 'submitted', confirmed: false })
    expect(calls[0]).toMatchObject({ to: 'needs_you', reason: 'check_sent' })
  })

  it('matches an employer confirmation by job id only', async () => {
    state.app.state = 'sent'
    expect((await post({ applicationId: ID, outcome: 'confirmation', jobId: '999' })).status).toBe(409)
    expect(calls).toHaveLength(0)
    expect((await post({ applicationId: ID, outcome: 'confirmation', jobId: '123' })).status).toBe(200)
    expect(calls[0]).toMatchObject({ to: 'confirmed' })
  })
})
