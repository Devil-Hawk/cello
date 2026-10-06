// What may be sent without a click, and what the extension's routes accept and refuse. The routes run
// against a small in-memory database; the pipeline's SQL functions are mocked (their refusals are
// proven in supabase/checks).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { findAnswer, classify, type BankRow } from '@/lib/answers/match'
import { STOP_CAUSES as PIPELINE_CAUSES } from '@/lib/pipeline/types'
import { postingUrlHash } from '@/lib/pipeline/posting'
import { AUTO_HOSTS, type AutoHost } from './auto-hosts'
import { STOP_CAUSES } from './contract'
import { eligibility, type EligibleField } from './eligibility'
import { filledEvent } from './record'
import { portalOf } from './portals'
import { allowedReadBack, readScreenshot, serverFields, SessionBody } from './wire'

type Row = Record<string, any>

// --- a small database ---------------------------------------------------------------
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpcs: [] as [string, any][], rpcData: {} as Record<string, unknown>, uploads: [] as string[], calls: [] as any[] }))

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let mode: 'select' | 'insert' | 'update' = 'select'
  let patch: Row = {}
  let max = Infinity
  const col = (r: Row, c: string) => (c.includes('->>') ? c.split('->>').reduce((v: any, k, i) => (i === 0 ? r[k] : v?.[k]), null as any) : r[c])
  const hits = () => (db.tables[table] ??= []).filter((r) => filters.every((f) => f(r))).slice(0, max)
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => col(r, c) === v), q),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    order: () => q,
    limit: (n: number) => ((max = n), q),
    insert: (v: Row) => ((mode = 'insert'), (patch = v), q),
    update: (v: Row) => ((mode = 'update'), (patch = v), q),
    maybeSingle: async () => {
      if (mode === 'insert') {
        const row = { id: `${table}-${(db.tables[table] ??= []).length + 1}`, ...patch }
        db.tables[table].push(row)
        return { data: { id: row.id }, error: null }
      }
      return { data: hits()[0] ?? null, error: null }
    },
    then: (res: (v: unknown) => unknown) => {
      if (mode === 'update') for (const r of hits()) Object.assign(r, patch)
      return res({ data: mode === 'select' ? hits() : null, error: null })
    },
  }
  q.single = q.maybeSingle
  return q
}
const admin = { from, rpc: async (n: string, a: unknown) => (db.rpcs.push([n, a]), { data: db.rpcData[n] ?? null, error: null }), storage: { from: () => ({ upload: async (p: string) => (db.uploads.push(p), { error: null }) }) } }

const TOKEN = '3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b'
vi.mock('./auth', () => ({
  fillAuth: vi.fn(async () => ({ admin, userId: 'u1', tokenId: TOKEN })),
  isFillAuth: (v: unknown) => !(v instanceof NextResponse),
}))
vi.mock('@/lib/pipeline/transition', () => ({
  transition: vi.fn(async (_a: unknown, m: any) => (db.calls.push(m), { ok: true, replay: false, event: { id: 'e' } })),
  note: vi.fn(async (_a: unknown, _u: string, _id: string, e: any) => (db.calls.push({ note: e }), { ok: true, replay: false, event: { id: 'e' } })),
  autoSendReason: vi.fn(async () => null),
  pause: vi.fn(async () => ({ ok: true, already: false })),
}))
const transitionMock = async () => (await import('@/lib/pipeline/transition')).transition as unknown as ReturnType<typeof vi.fn>

const HOST: AutoHost = { host: 'boards.greenhouse.io', urlPattern: '', submitLabels: ['Submit application'], confirmationPatterns: ['thank you'], confirmationUrls: [] }
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

  it('refuses a model-drafted, resume-read or similar answer on an optional field too', () => {
    expect(check([field(), field({ required: false, resolved: { value: 'A paragraph a model drafted', via: 'exact', origin: 'model' } })])).toBe('Answer it yourself to let Cello send this.')
    expect(check([field({ required: false, resolved: { value: '7', via: 'exact', origin: 'code' } })])).toContain('resume')
    expect(check([field({ required: false, resolved: { value: 'Yes', via: 'similar', origin: 'person' } })])).toContain('similar saved answer')
    // an optional field with the person's own value, or none, does not stop a send
    expect(check([field({ required: false, resolved: undefined }), field({ required: false })])).toBeNull()
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

describe('portals and the wire', () => {
  it('says an account portal needs an account, and a hosted form does not', () => {
    expect(portalOf('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')?.sentence).toBe('This site needs an account.')
    expect(portalOf('https://boards.greenhouse.io/stripe/jobs/1')).toBeNull()
    expect(portalOf(null)).toBeNull()
  })

  it('reads the extension\'s session request: fields by key, a bounded number', () => {
    const ok = SessionBody.safeParse({ url: URL_OK, fields: [{ key: 'a', label: 'Email', type: 'text', required: true, name: 'email', autocomplete: 'email', options: [] }] })
    expect(ok.success && ok.data.fields[0]).toMatchObject({ key: 'a', required: true })
    expect(SessionBody.safeParse({ url: URL_OK, fields: [{ id: 'a', label: 'Email' }] }).success).toBe(false)
    expect(SessionBody.safeParse({ url: 'nope', fields: [] }).success).toBe(false)
    expect(SessionBody.safeParse({ url: URL_OK, fields: Array.from({ length: 301 }, (_, i) => ({ key: `${i}`, label: 'l' })) }).success).toBe(false)
  })

  it('keeps the contract\'s twelve stop causes equal to the pipeline\'s', () => {
    expect(STOP_CAUSES).toHaveLength(12)
    expect([...STOP_CAUSES]).toEqual([...PIPELINE_CAUSES])
  })

  it('takes the kind and the category from the server\'s own reading of the form', () => {
    const f = serverFields([{ key: 'g', label: 'What is your gender?', name: '', type: 'select', options: ['A'], required: false }, { key: 'p', label: 'Password', name: '', type: 'password', options: [], required: true }], 'Stripe')
    expect(f.map((x) => [x.key, x.kind, x.category])).toEqual([['g', 'select', 'eeo'], ['p', 'password', 'other']])
  })

  it('records a read-back through the allowlist, whatever the extension says about itself', () => {
    const known = [{ key: 'name', kind: 'text', category: 'other' }, { key: 'auth', kind: 'radio', category: 'work_auth' }, { key: 'pw', kind: 'password', category: 'other' }, { key: 'cv', kind: 'file', category: 'other' }] as const
    // the extension's record
    expect(allowedReadBack({ name: 'Ada', auth: 'Yes', pw: 'secret', cv: { file: 'Ada.pdf' }, stray: 'x' }, known)).toEqual([
      { key: 'name', kind: 'text', category: 'other', entry: { value: 'Ada' } },
      { key: 'auth', kind: 'radio', category: 'work_auth', entry: { answered_by_you: true } },
      { key: 'cv', kind: 'file', category: 'other', entry: { file_name: 'Ada.pdf' } },
    ])
    // the contract's array, with a sensitive field claimed as plain
    expect(allowedReadBack([{ key: 'auth', kind: 'text', category: 'other', entry: { value: 'Yes' } }], known)).toEqual([{ key: 'auth', kind: 'radio', category: 'work_auth', entry: { answered_by_you: true } }])
    // a file's text is not recorded
    expect(allowedReadBack({ cv: 'C:\\fakepath\\Ada.pdf' }, known)).toEqual([])
  })

  it('refuses a screenshot over 256 KB and one that is not a JPEG', () => {
    const jpeg = (kb: number) => `data:image/jpeg;base64,${Buffer.alloc(kb * 1024, 1).toString('base64')}`
    expect('bytes' in readScreenshot(jpeg(200))).toBe(true)
    expect('error' in readScreenshot(jpeg(300))).toBe(true)
    expect('error' in readScreenshot('data:image/png;base64,AAAA')).toBe(true)
    expect(readScreenshot(null)).toEqual({ bytes: null })
  })
})

// --- the routes -----------------------------------------------------------------------
const ID = '11111111-1111-4111-8111-111111111111'
const app = (over: Row = {}): Row => ({
  id: ID, user_id: 'u1', state: 'ready', posting_url_hash: postingUrlHash(URL_OK), auto_attempted_at: null, lease_holder: null, lease_until: null, needs_reason: null,
  last_event_at: '2026-10-14T00:00:00Z', form_fields: null, job_id: 'j1', jobs: { url: URL_OK, title: 'Engineer', company_id: 'c1', companies: { name: 'Stripe' } }, ...over,
})
const profile = (over: Row = {}): Row => ({ id: 'u1', full_name: 'Ada Lovelace', email: 'ada@example.com', preferences: { contact: { phone: '555 0100' } }, resume_text: null, is_demo: false, demo_expires_at: null, ...over })
const FIELDS = [
  { key: 'first_name', label: 'First Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'text', required: true },
  { key: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female'], required: false },
  { key: 'pw', label: 'Password', type: 'password', required: true },
  { key: 'why', label: 'Why do you want to work at Stripe?', type: 'textarea', required: true },
]

const routes = {
  session: () => import('@/app/api/fill/session/route'),
  report: () => import('@/app/api/fill/report/route'),
  next: () => import('@/app/api/fill/next/route'),
}
const call = async (route: keyof typeof routes, method: 'POST', body: unknown, headers: Record<string, string> = {}) => {
  const mod = await routes[route]()
  return mod[method](new NextRequest(`http://localhost/api/fill/${route}`, { method, body: JSON.stringify(body), headers }))
}

beforeEach(async () => {
  vi.useRealTimers()
  db.tables = { applications: [app()], profiles: [profile()], answer_bank: [], pipeline_events: [], application_attempts: [], resume_documents: [] }
  db.rpcs.length = 0
  db.rpcData = {}
  db.uploads.length = 0
  db.calls.length = 0
  ;(await transitionMock()).mockClear()
})

describe('POST /api/fill/session', () => {
  const session = (over: Row = {}) => call('session', 'POST', { url: URL_OK, fields: FIELDS, application: ID, ...over })

  it('answers in the extension\'s shape: values for the keys it sent, from the person\'s own record, and nothing for a password or a demographic', async () => {
    const res = await session()
    const b = await res.json()
    expect(b).toMatchObject({ status: 'ok', application: ID, company: 'Stripe', drafts: [], file: null })
    expect(typeof b.session).toBe('string')
    // T13: every value the server hands out equals what the person stored (profile: Ada Lovelace, ada@example.com)
    expect(b.values).toEqual({ first_name: { value: 'Ada', source: 'profile' }, email: { value: 'ada@example.com', source: 'profile' } })
    expect(b.categories).toMatchObject({ gender: 'eeo', first_name: 'standard', why: 'motivation' })
    expect(JSON.stringify(b)).not.toMatch(/secret|password/i)
    // a Ready application moves to Applying, and what the form asked is kept for the report
    expect(db.calls[0]).toMatchObject({ from: ['ready'], to: 'applying', event: { kind: 'fill.started' } })
    expect(db.calls.find((c) => c.note)?.note.payload).toMatchObject({ phase: 'session', fields: expect.arrayContaining([{ key: 'gender', kind: 'select', category: 'eeo' }]) })
    // the question it cannot answer is one open row, not a guess
    expect(db.tables.answer_bank).toHaveLength(1)
  })

  it('finds the application by the page\'s address when the extension names none', async () => {
    const b = await (await session({ application: undefined })).json()
    expect(b).toMatchObject({ status: 'ok', application: ID })
    db.tables.applications = []
    expect(await (await session({ application: undefined })).json()).toMatchObject({ status: 'none' })
  })

  it('is refused while Cello is paused (409), for a posting already sent, and in a state that is not fillable', async () => {
    db.tables.profiles = [profile({ preferences: { pipeline: { paused_at: '2026-10-14T00:00:00Z' } } })]
    const paused = await session()
    expect(paused.status).toBe(409)
    expect(await paused.json()).toMatchObject({ status: 'refused', reason: 'paused' })
    db.tables.profiles = [profile()]
    db.rpcData.pipeline_send_blocked = true
    expect(await (await session()).json()).toMatchObject({ status: 'refused', reason: 'already_sent' })
    db.rpcData.pipeline_send_blocked = false
    db.tables.applications = [app({ state: 'sent' })]
    const sent = await session()
    expect(sent.status).toBe(409)
    expect(await sent.json()).toMatchObject({ status: 'refused', reason: 'not_ready' })
    expect(db.calls).toHaveLength(0)
  })

  it('never opens another person\'s application, and says that one is gone', async () => {
    db.tables.applications = [app({ user_id: 'someone-else' })]
    expect((await session()).status).toBe(404)
  })

  it('keeps the person\'s own fill out of a live automatic claim, and an automatic session to a claimed one', async () => {
    db.tables.applications = [app({ state: 'applying', auto_attempted_at: '2026-10-14T00:00:00Z', lease_until: new Date(Date.now() + 60_000).toISOString() })]
    expect(await (await session()).json()).toMatchObject({ status: 'refused', reason: 'claimed' })
    db.tables.applications = [app({ state: 'applying' })]
    expect(await (await session({ auto: true })).json()).toMatchObject({ status: 'refused', reason: 'not_claimed' })
  })

  it('ends an automatic claim that is not eligible, with the sentence', async () => {
    db.tables.applications = [app({ state: 'applying', auto_attempted_at: '2026-10-14T00:00:00Z', lease_until: new Date(Date.now() + 60_000).toISOString() })]
    const b = await (await session({ auto: true })).json()
    expect(b).toMatchObject({ status: 'ended', cause: 'unknown_field', message: 'A required question has no answer yet.' })
    expect(db.calls[0]).toMatchObject({ to: 'needs_you', reason: 'your_turn' })
  })

  it('refuses a request that is not the extension\'s shape', async () => {
    expect((await call('session', 'POST', { applicationId: ID, fields: [{ id: 'a', label: 'x' }] })).status).toBe(400)
  })
})

describe('POST /api/fill/next', () => {
  const next = (body: unknown = { auto: true, version: '1.0.0' }) => call('next', 'POST', body)
  const autoOn = (over: Row = {}) => ({ pipeline: { send: { mode: 'auto', tokenId: TOKEN }, ...over } })

  it('serves no claim when Send for me is off, paused, in quiet hours, bound to another browser, or a demo', async () => {
    for (const [prefs, demo, reason] of [
      [{}, false, 'off'],
      [autoOn({ paused_at: '2026-10-14T00:00:00Z' }), false, 'paused'],
      [{ pipeline: { send: { mode: 'auto', tokenId: '2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c' } } }, false, 'other_browser'],
      [autoOn({ morning: { quietFrom: '00:00', quietTo: '23:59' } }), false, 'quiet'],
      [autoOn(), true, 'demo'],
    ] as const) {
      db.tables.profiles = [profile({ preferences: prefs, is_demo: demo })]
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
      const b = await (await next()).json()
      expect(b).toEqual({ reason })
    }
    expect(db.calls).toHaveLength(0)
  })

  it('serves no claim today even when everything else allows it: no site is listed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
    db.tables.profiles = [profile({ preferences: { pipeline: { send: { mode: 'auto', tokenId: TOKEN } } } })]
    db.tables.applications = [app({ form_fields: [{ id: 'q', label: 'How did you hear about us?', required: false }] })]
    expect(await (await next()).json()).toEqual({ reason: 'site_not_supported' })
    expect(db.calls).toHaveLength(0)
  })

  it('gives the person\'s own Send next the oldest ready application, claimed by nothing', async () => {
    expect(await (await next({ auto: false, version: '1.0.0' })).json()).toEqual({ next: { application: ID, url: URL_OK, company: 'Stripe' } })
    db.tables.applications = []
    expect(await (await next({ auto: false })).json()).toEqual({ reason: 'nothing_ready' })
    expect(db.calls).toHaveLength(0)
  })
})

describe('POST /api/fill/report', () => {
  const report = (body: Row, headers: Record<string, string> = {}) => call('report', 'POST', { application: ID, ...body }, headers)
  const sessionFields = () => {
    db.tables.pipeline_events = [{ user_id: 'u1', application_id: ID, kind: 'fill.reported', payload: { phase: 'session', fields: [{ key: 'first_name', kind: 'text', category: 'other' }, { key: 'gender', kind: 'select', category: 'eeo' }, { key: 'pw', kind: 'password', category: 'other' }, { key: 'cv', kind: 'file', category: 'other' }] } }]
  }
  const jpeg = (kb: number) => `data:image/jpeg;base64,${Buffer.alloc(kb * 1024, 1).toString('base64')}`

  beforeEach(() => {
    db.tables.applications = [app({ state: 'applying' })]
  })

  it('writes the "filled" phase on the event, because the sweeper reads it to tell Did you send it? from Ready again', async () => {
    expect((await report({ phase: 'filled', filled: 4, total: 5, unknown: ['x'] })).status).toBe(200)
    expect(db.calls[0].note).toMatchObject({ kind: 'fill.reported', payload: { phase: 'filled', filled: 4, total: 5 } })
  })

  it('names the phase the sweeper\'s lease branch reads, so the SQL and this route cannot drift', () => {
    const sql = readFileSync(path.join(process.cwd(), '../../supabase/migrations/20261013000004_pipeline_sweep.sql'), 'utf8')
    expect(sql).toContain(`e.kind = 'fill.reported' and e.payload ->> 'phase' = '${filledEvent('a', 's', { filled: 1, total: 1 }).payload.phase}'`)
  })

  it('moves a stop to Needs you with its cause, and refuses a cause it does not know', async () => {
    expect((await report({ phase: 'blocked', url: URL_OK, cause: 'site_check' })).status).toBe(200)
    expect(db.calls[0]).toMatchObject({ to: 'needs_you', reason: 'your_turn', detail: { cause: 'site_check', host: 'boards.greenhouse.io' } })
    db.calls.length = 0
    expect((await report({ phase: 'blocked', url: URL_OK, cause: 'because' })).status).toBe(400)
    expect((await report({ phase: 'blocked', url: URL_OK })).status).toBe(400)
    expect((await report({ phase: 'nonsense' })).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('answers a blocked form it could not match to an application with ok, and moves nothing', async () => {
    db.tables.applications = []
    expect(await (await call('report', 'POST', { phase: 'blocked', url: URL_OK, cause: 'sign_in' })).json()).toEqual({ ok: true })
    expect(db.calls).toHaveLength(0)
  })

  it('never reads another person\'s application', async () => {
    db.tables.applications = [app({ user_id: 'someone-else' })]
    expect((await report({ phase: 'filled' })).status).toBe(404)
  })

  it('a submit nobody confirmed is Did you send it?, never Sent, and its attempt keeps only the allowlist', async () => {
    sessionFields()
    const res = await report({ phase: 'submitted', url: URL_OK, values: { first_name: 'Ada', gender: 'Female', pw: 'hunter2', cv: { file: 'Ada.pdf' }, stray: 'x' } }, { 'x-cello-extension-version': '1.2.3' })
    expect(res.status).toBe(200)
    expect(db.calls[0]).toMatchObject({ to: 'needs_you', reason: 'check_sent', event: { kind: 'submission.unconfirmed', trust: 'unconfirmed' } })
    expect(db.calls.map((c) => c.to)).not.toContain('sent')
    const [attempt] = db.tables.application_attempts
    expect(attempt).toMatchObject({ attempt_outcome: 'unconfirmed', provenance: 'browser_companion', verification_state: 'unconfirmed', sent_by: 'person', extension_version: '1.2.3', final_url: URL_OK })
    expect(attempt.values_sent).toEqual({ first_name: { value: 'Ada' }, gender: { answered_by_you: true }, cv: { file_name: 'Ada.pdf' } })
    expect(JSON.stringify(attempt)).not.toMatch(/hunter2|Female/)
  })

  it('refuses an automatic submit Send for me never asked to make, and records one it did as Did you send it?', async () => {
    db.tables.applications = [app({ state: 'applying', auto_attempted_at: '2026-10-14T00:00:00Z' })]
    expect((await report({ phase: 'submitted', url: URL_OK })).status).toBe(409)
    expect(db.calls).toHaveLength(0)
    db.tables.pipeline_events = [{ user_id: 'u1', application_id: ID, kind: 'submission.sending', payload: {} }]
    await report({ phase: 'submitted', url: URL_OK })
    expect(db.calls[0]).toMatchObject({ to: 'needs_you', reason: 'check_sent' })
    expect(db.tables.application_attempts[0]).toMatchObject({ sent_by: 'cello' })
  })

  it('answers ready_to_send with go once, and with already_sent the second time', async () => {
    db.tables.applications = [app({ state: 'applying', auto_attempted_at: '2026-10-14T00:00:00Z', lease_holder: 'lh1' })]
    db.tables.pipeline_events = [{ user_id: 'u1', application_id: ID, kind: 'fill.started', payload: { files: [{ name: 'Ada.pdf', id: 'r1' }] } }]
    const body = { phase: 'ready_to_send', fields_hash: 'f'.repeat(64), values_hash: 'v'.repeat(64), submit_label: 'Submit application', file_hashes: ['h1'], final_url: URL_OK }
    expect(await (await report(body)).json()).toEqual({ ok: true, go: true })
    expect(db.calls[0]).toMatchObject({ from: ['applying'], to: 'applying', event: { kind: 'submission.sending', payload: { lease_holder: 'lh1', token_id: TOKEN, files: [{ name: 'Ada.pdf', id: 'r1' }], fields_hash: 'f'.repeat(64), submit_label: 'Submit application' } } })
    ;(await transitionMock()).mockResolvedValueOnce({ ok: true, replay: true, event: { id: 'e' } })
    expect(await (await report(body)).json()).toEqual({ ok: true, go: false, already_sent: true })
    ;(await transitionMock()).mockResolvedValueOnce({ ok: false, refusal: 'send_off', sentence: 'Send for me is off.' })
    const refused = await report(body)
    expect(refused.status).toBe(409)
    expect((await refused.json()).go).toBe(false)
  })

  it('matches a site\'s confirmation by job id only, records Sent with the screenshot, and refuses one that is too large', async () => {
    sessionFields()
    await report({ phase: 'submitted', url: URL_OK, values: { first_name: 'Ada' } })
    db.calls.length = 0
    db.tables.applications = [app({ state: 'needs_you', needs_reason: 'check_sent' })]
    expect((await report({ phase: 'confirmation', text: 'Thank you', url: 'https://boards.greenhouse.io/stripe/jobs/999/confirmation' })).status).toBe(409)
    expect((await report({ phase: 'confirmation', text: 'Thank you', url: URL_OK, screenshot: jpeg(300) })).status).toBe(413)
    expect(db.calls).toHaveLength(0)
    expect((await report({ phase: 'confirmation', text: 'Thank you for applying', url: URL_OK, screenshot: jpeg(100) })).status).toBe(200)
    expect(db.calls[0]).toMatchObject({ from: ['applying', 'ready', 'needs_you'], to: 'sent', event: { kind: 'submission.sent', trust: 'proven' } })
    expect(db.tables.application_attempts).toHaveLength(1)
    expect(db.tables.application_attempts[0]).toMatchObject({ attempt_outcome: 'sent', verification_state: 'system_confirmed', confirmation_text: 'Thank you for applying' })
    expect(db.uploads).toEqual([`u1/${db.tables.application_attempts[0].id}.jpg`])
  })

  it('a second confirmation after Sent is Confirmed, and adds no attempt', async () => {
    db.tables.applications = [app({ state: 'sent' })]
    await report({ phase: 'confirmation', text: 'Thank you', url: URL_OK })
    expect(db.calls[0]).toMatchObject({ from: ['sent'], to: 'confirmed', event: { kind: 'submission.confirmed' } })
    expect(db.tables.application_attempts).toHaveLength(0)
  })

  it('treats a dropped manual fill as Ready again and a dropped automatic claim as Your turn', async () => {
    await report({ phase: 'abandoned' })
    expect(db.calls[0]).toMatchObject({ to: 'ready' })
    db.calls.length = 0
    db.tables.applications = [app({ state: 'applying', auto_attempted_at: '2026-10-14T00:00:00Z' })]
    await report({ phase: 'abandoned' })
    expect(db.calls[0]).toMatchObject({ to: 'needs_you', reason: 'your_turn', detail: { cause: 'interrupted' } })
  })
})
