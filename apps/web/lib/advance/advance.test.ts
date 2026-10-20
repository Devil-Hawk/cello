// The advancer: a lease taken once, a step run once, a failure that lands somewhere named, a rate limit
// that waits for the right time, and what each step decides. The SQL it moves through is checked in
// supabase/checks (pipeline_core.sql, pipeline_sweep.sql: fairness of 2 a person, 10 a minute, stale
// leases); here transition is a recorder.

import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const calls: any[] = []
const notes: any[] = []
let failNextAdditionNote = false
vi.mock('@/lib/pipeline/transition', () => ({
  transition: vi.fn(async (_admin: unknown, m: any) => (calls.push(m), { ok: true, replay: false, event: { id: 'e', kind: m.event.kind } })),
  note: vi.fn(async (_admin: unknown, _user: string, _app: string, e: any) => {
    if (failNextAdditionNote && e.payload?.changed === 'added') {
      failNextAdditionNote = false
      return { ok: false, refusal: 'injected', sentence: 'injected' }
    }
    notes.push(e)
    return { ok: true, replay: false, event: { id: 'n', kind: e.kind } }
  }),
  autoSendReason: vi.fn(async () => 'Cello sends only Strong matches.'),
}))

vi.mock('@/lib/ats', () => ({ assertAllowedHost: vi.fn(), fetchJson: vi.fn() }))
vi.mock('@/lib/resume/store', () => ({ getLatestVersion: vi.fn(async () => null), getBaseResume: vi.fn(async () => null) }))
const openQuestions: { fieldId: string; answerId: string; question: string }[] = []
vi.mock('@/lib/answers', () => ({ resolveFieldValues: vi.fn(async () => ({ values: {}, open: openQuestions, never: [] })) }))
const letters: { id: string; version: number; text: string }[] = []
vi.mock('@/lib/agents/artifacts', () => ({
  listArtifacts: vi.fn(async () => letters.map((l) => ({ id: l.id }))),
  getArtifact: vi.fn(async (_a: unknown, _u: string, id: string) => {
    const l = letters.find((x) => x.id === id)
    return l ? { artifact: { id: l.id }, version: { version: l.version, content_text: l.text } } : null
  }),
}))

import { getLatestVersion } from '@/lib/resume/store'
import { advanceOne } from './index'
import { costLine, rateLimitOf, sumCost, waitAfter } from './cost'
import { coverLetter, draftAnswers, readGreenhouseFields, readGreenhouseFiles, startedHandsOff, tailor, type Step, type StepCtx } from './steps'

const NOW = Date.parse('2026-10-14T12:00:00Z')

function fakeAdmin(tables: Record<string, Row[]>): any {
  return {
    rpc: async () => ({ data: false, error: null }),
    from(name: string) {
      tables[name] ??= []
      let rows = tables[name]
      let mode: 'select' | 'update' = 'select'
      let patch: Row = {}
      let sort: { c: string; asc: boolean } | null = null
      const filters: ((r: Row) => boolean)[] = []
      const run = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (sort) hit.sort((a, b) => (a[sort!.c] < b[sort!.c] ? -1 : a[sort!.c] > b[sort!.c] ? 1 : 0) * (sort!.asc ? 1 : -1))
        if (mode === 'update') for (const r of hit) Object.assign(r, patch)
        return { data: hit.map((r) => ({ ...r })), error: null }
      }
      const q: any = {
        select: () => q,
        update: (v: Row) => ((mode = 'update'), (patch = v), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        or: (str: string) => {
          // lease_until.is.null,lease_until.lt.<iso>
          const lt = /lease_until\.lt\.(.+)$/.exec(str)?.[1] ?? ''
          filters.push((r) => r.lease_until == null || r.lease_until < lt)
          return q
        },
        limit: () => q,
        order: (c: string, o?: { ascending?: boolean }) => ((sort = { c, asc: o?.ascending !== false }), q),
        contains: (c: string, v: Row) => (filters.push((r) => Object.entries(v).every(([k, x]) => r[c]?.[k] === x)), q),
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res(run()),
      }
      return q
    },
  }
}

const app = (over: Row = {}): Row => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', state: 'preparing', attempt: 0, last_event_at: null, posting_url_hash: null, lease_until: null,
  jobs: { url: 'https://example.com/jobs/1', title: 'Engineer', company_id: 'c1', closed_at: null, still_open: true, companies: { name: 'Acme' } },
  ...over,
})

const ok = (id: string): Step => ({ id, doing: `Doing ${id}`, run: vi.fn(async () => ({ kind: 'continue' as const, line: `${id} done` })) })

const opts = (steps: Step[]) => ({ now: () => NOW, steps })

beforeEach(() => {
  calls.length = 0
  notes.length = 0
  failNextAdditionNote = false
})

describe('advanceOne', () => {
  it('runs every step in order and ends at Ready', async () => {
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [] })
    const steps = [ok('one'), ok('two')]
    await advanceOne(admin, 'a1', opts(steps))
    expect(calls.map((c) => `${c.from}>${c.to}:${c.event.step ?? ''}`)).toEqual(['preparing>preparing:one', 'preparing>preparing:two', 'preparing>ready:ready'])
  })

  it('stops at the next step boundary when asked, and pauses the application so the sweeper does not carry on', async () => {
    const steps = [ok('one'), ok('two')]
    let asked = 0
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [] })
    await advanceOne(admin, 'a1', { ...opts(steps), shouldStop: async () => ++asked > 1 })
    expect(steps[0].run).toHaveBeenCalledTimes(1)
    expect(steps[1].run).not.toHaveBeenCalled()
    expect(calls.map((c) => `${c.from}>${c.to}:${c.event.kind}`)).toEqual(['preparing>preparing:step.finished', 'preparing>paused:application.paused'])
  })

  it('pauses instead of moving to Ready when the stop landed during the last step', async () => {
    let asked = 0
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [] })
    await advanceOne(admin, 'a1', { ...opts([ok('one')]), shouldStop: async () => ++asked > 1 })
    expect(calls.map((c) => `${c.from}>${c.to}:${c.event.kind}`)).toEqual(['preparing>preparing:step.finished', 'preparing>paused:application.paused'])
  })

  it('takes a free or expired lease once, and leaves a live one alone', async () => {
    const expired = fakeAdmin({ applications: [app({ lease_until: new Date(NOW - 60_000).toISOString() })], pipeline_events: [] })
    expect(await advanceOne(expired, 'a1', opts([ok('one')]))).not.toBeNull()
    const live = fakeAdmin({ applications: [app({ lease_until: new Date(NOW + 60_000).toISOString() })], pipeline_events: [] })
    calls.length = 0
    expect(await advanceOne(live, 'a1', opts([ok('one')]))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('does nothing for an application that is not preparing', async () => {
    expect(await advanceOne(fakeAdmin({ applications: [app({ state: 'ready' })], pipeline_events: [] }), 'a1', opts([ok('one')]))).toBeNull()
  })

  it('does not run a step again that already finished', async () => {
    const steps = [ok('one'), ok('two')]
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [{ user_id: 'u1', idempotency_key: 'step:a1:one:0:done' }] })
    await advanceOne(admin, 'a1', opts(steps))
    expect(steps[0].run).not.toHaveBeenCalled()
    expect(steps[1].run).toHaveBeenCalledTimes(1)
  })

  it('lands a throwing step in a named state: one more try, then Not sent on the third', async () => {
    const boom: Step = { id: 'boom', doing: 'Boom', run: async () => { throw new Error('nope') } }
    await advanceOne(fakeAdmin({ applications: [app({ attempt: 0 })], pipeline_events: [] }), 'a1', opts([boom]))
    expect(calls.at(-1)).toMatchObject({ to: 'preparing', event: { kind: 'step.failed', attemptInc: true } })
    calls.length = 0
    await advanceOne(fakeAdmin({ applications: [app({ attempt: 2 })], pipeline_events: [] }), 'a1', opts([boom]))
    expect(calls.at(-1)).toMatchObject({ to: 'not_sent', event: { kind: 'step.failed' } })
    expect(calls.at(-1).step).toContain('could not finish')
  })

  it('waits on the free daily limit until tomorrow and retries a per-minute limit in a minute', async () => {
    const daily: Step = { id: 'm', doing: 'Model', run: async () => { throw Object.assign(new Error('Rate limit exceeded: free-models-per-day'), { status: 429 }) } }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([daily]))
    expect(calls.at(-1)).toMatchObject({ to: 'scheduled', event: { kind: 'limit.reached', nextAt: '2026-10-15T00:05:00.000Z' } })
    expect(calls.at(-1).step).toBe("The free model's daily limit is reached. Cello will carry on tomorrow.")
    calls.length = 0
    const perMinute: Step = { id: 'm', doing: 'Model', run: async () => { throw Object.assign(new Error('429 Too many requests'), { status: 429 }) } }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([perMinute]))
    expect(calls.at(-1)).toMatchObject({ to: 'scheduled', event: { nextAt: '2026-10-14T12:01:00.000Z' } })
  })

  it('after Ready, a hands-off application says what holds it, and an Ask first one says nothing more', async () => {
    const off = fakeAdmin({ applications: [app()], pipeline_events: [{ application_id: 'a1', user_id: 'u1', kind: 'application.created', payload: { mode: 'hands_off' } }] })
    await advanceOne(off, 'a1', opts([ok('one')]))
    expect(calls.at(-1)).toMatchObject({ to: 'ready' })
    expect(notes).toEqual([expect.objectContaining({ kind: 'step.finished', sentence: 'It waits for you: Cello sends only Strong matches.', idempotencyKey: 'ready-mode:a1:0' })])

    notes.length = 0
    const ask = fakeAdmin({ applications: [app()], pipeline_events: [{ application_id: 'a1', user_id: 'u1', kind: 'application.created', payload: { mode: 'ask' } }] })
    await advanceOne(ask, 'a1', opts([ok('one')]))
    expect(notes).toEqual([])
  })

  it('moves to the one thing it waits on, with the reason and additions persisted on that move', async () => {
    const asks: Step = { id: 'read_form', doing: 'Reading', run: async () => ({ kind: 'wait', reason: 'answer', detail: { answer_ids: ['q1'] }, line: '1 question needs your answer.', add: [{ step: 'cover_letter', why: 'The form asks for a cover letter.' }] }) }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([ok('one'), asks, ok('after')]))
    expect(calls.at(-1)).toMatchObject({ to: 'needs_you', reason: 'answer', detail: { answer_ids: ['q1'] }, event: { payload: { answer_ids: ['q1'], additions: [{ step: 'cover_letter', why: 'The form asks for a cover letter.', after: 'read_form' }] } } })
    expect(notes).toEqual([expect.objectContaining({ payload: { changed: 'added', step: 'cover_letter', after: 'read_form', why: 'The form asks for a cover letter.' } })])
    expect(calls.some((c) => c.event.step === 'after')).toBe(false)
  })
})

describe('a step the form asks for', () => {
  const reads = (): Step => ({ id: 'read_form', doing: 'Reading', run: vi.fn(async () => ({ kind: 'continue' as const, line: 'Read 3 questions; 2 need your answer.', add: [{ step: 'draft_answers' as const, why: 'The form asks 2 questions you have not answered.' }] })) })
  const drafts = (reason: 'wait' | 'continue') => ({ ...draftAnswers, run: vi.fn(async () => (reason === 'wait' ? { kind: 'wait' as const, reason: 'answer' as const, detail: { answer_ids: ['q1', 'q2'], drafted: 2 }, line: 'Drafted 2 answers for you to check. Cello never sends an answer you did not give.' } : { kind: 'continue' as const, line: 'Every question has an answer.' })) })

  it('puts an added step right after the one that added it, and names the change', async () => {
    const { withAdded, addedLine } = await import('./index')
    expect(withAdded([ok('one'), reads(), ok('after')], [{ after: 'read_form', step: 'draft_answers' }]).map((s) => s.id)).toEqual(['one', 'read_form', 'draft_answers', 'after'])
    expect(withAdded([ok('one')], [{ after: 'gone', step: 'cover_letter' }]).map((s) => s.id)).toEqual(['one', 'cover_letter'])
    expect(addedLine({ step: 'draft_answers', why: 'The form asks 2 questions you have not answered.' }, 2)).toBe('Added a step: draft 2 answers. The form asks 2 questions you have not answered.')
    expect(addedLine({ step: 'cover_letter', why: 'The form asks for a cover letter.' })).toBe('Added a step: write a cover letter. The form asks for a cover letter.')
  })

  it('adds a step for open questions and says why, then waits for the person after drafting answers', async () => {
    vi.doMock('./steps', async (orig) => ({ ...(await orig<typeof import('./steps')>()), ADDED_STEPS: { draft_answers: drafts('wait'), cover_letter: coverLetter } }))
    vi.resetModules()
    const { advanceOne: run } = await import('./index')
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [] })
    await run(admin, 'a1', opts([ok('one'), reads(), ok('after')]))
    expect(notes).toEqual([expect.objectContaining({ kind: 'step.finished', sentence: 'Added a step: draft 2 answers. The form asks 2 questions you have not answered.', idempotencyKey: 'step:a1:read_form:0:added:draft_answers', payload: { changed: 'added', step: 'draft_answers', after: 'read_form', why: 'The form asks 2 questions you have not answered.' } })])
    expect(calls.at(-1)).toMatchObject({ to: 'needs_you', reason: 'answer', detail: { drafted: 2 } })
    expect(calls.at(-1).event.sentence).toBe('Drafted 2 answers for you to check. Cello never sends an answer you did not give.')
    expect(calls.some((c) => c.event.step === 'after')).toBe(false)
    vi.doUnmock('./steps')
    vi.resetModules()
  })

  it('recovers an added step exactly once when its status event fails', async () => {
    const draftStep = drafts('continue')
    vi.doMock('./steps', async (orig) => ({ ...(await orig<typeof import('./steps')>()), ADDED_STEPS: { draft_answers: draftStep, cover_letter: coverLetter } }))
    vi.resetModules()
    const { advanceOne: run } = await import('./index')
    const tables = { applications: [app()], pipeline_events: [] as Row[] }
    const admin = fakeAdmin(tables)
    failNextAdditionNote = true
    await run(admin, 'a1', opts([reads(), ok('after')]))
    expect(notes).toEqual([])
    const parent = calls.find((call) => call.event.step === 'read_form' && call.event.kind === 'step.finished')!
    expect(parent.event.payload.additions).toEqual([{ step: 'draft_answers', why: 'The form asks 2 questions you have not answered.', after: 'read_form' }])

    tables.pipeline_events.push({ user_id: 'u1', application_id: 'a1', kind: 'step.finished', idempotency_key: parent.event.idempotencyKey, payload: parent.event.payload, created_at: '2026-10-14T11:00:00Z' })
    tables.applications[0].attempt = 1
    calls.length = 0
    await run(admin, 'a1', opts([reads(), ok('after')]))
    expect(notes).toEqual([expect.objectContaining({ payload: { changed: 'added', step: 'draft_answers', after: 'read_form', why: 'The form asks 2 questions you have not answered.' } })])
    expect(draftStep.run).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.event.step === 'draft_answers')).toHaveLength(1)
    vi.doUnmock('./steps')
    vi.resetModules()
  })

  it('rebuilds the same steps after a retry', async () => {
    vi.doMock('./steps', async (orig) => ({ ...(await orig<typeof import('./steps')>()), ADDED_STEPS: { draft_answers: drafts('continue'), cover_letter: coverLetter } }))
    vi.resetModules()
    const { advanceOne: run } = await import('./index')
    // the earlier attempt added the step and finished read_form; the retry reads both back and runs the added step without adding it again
    const events = [
      { user_id: 'u1', application_id: 'a1', kind: 'step.finished', idempotency_key: 'step:a1:one:1:done', payload: {} },
      { user_id: 'u1', application_id: 'a1', kind: 'step.finished', idempotency_key: 'step:a1:read_form:1:done', payload: {} },
      { user_id: 'u1', application_id: 'a1', kind: 'step.finished', idempotency_key: 'step:a1:read_form:1:added:draft_answers', payload: { changed: 'added', step: 'draft_answers', after: 'read_form' }, created_at: '2026-10-14T11:00:00Z' },
    ]
    const admin = fakeAdmin({ applications: [app({ attempt: 1 })], pipeline_events: events })
    const asks = reads()
    await run(admin, 'a1', opts([ok('one'), asks, ok('after')]))
    expect(asks.run).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(calls.map((c) => `${c.to}:${c.event.step ?? ''}`)).toEqual(['preparing:draft_answers', 'preparing:after', 'ready:ready'])
    vi.doUnmock('./steps')
    vi.resetModules()
  })
})

describe('the steps a form asks for', () => {
  const form = { questions: [
    { label: 'Cover Letter', required: true, fields: [{ name: 'cover_letter', type: 'input_file' }] },
    { label: 'Why us?', required: true, fields: [{ name: 'q1', type: 'textarea' }] },
    { label: 'How did you hear about us?', required: true, fields: [{ name: 'q2', type: 'multi_value_single_select', values: [{ label: 'LinkedIn', value: 1 }] }] },
  ] }
  const ctx = (over: Partial<StepCtx> = {}, tables: Record<string, Row[]> = {}): StepCtx => ({
    admin: fakeAdmin({ pipeline_events: [], applications: [{ id: 'a1', user_id: 'u1', form_fields: [{ id: 'q1', label: 'Why us?', required: true, kind: 'long_text' }, { id: 'q2', label: 'How did you hear about us?', required: true, kind: 'select', options: ['LinkedIn'] }] }], ...tables }),
    app: { id: 'a1', user_id: 'u1', job_id: 'j1', posting_url_hash: null },
    job: { url: 'https://boards.greenhouse.io/acme/jobs/123', title: 'Engineer', company_id: 'c1', closed_at: null, still_open: true, companyName: 'Acme' },
    fetchForm: async () => form,
    ...over,
  })

  beforeEach(() => {
    openQuestions.length = 0
    letters.length = 0
  })

  it('lists the files a form asks for apart from its questions', () => {
    expect(readGreenhouseFiles(form)).toEqual([{ label: 'Cover Letter', required: true }])
  })

  it('read_form adds a step for open long questions and one for a required cover letter, and says why', async () => {
    openQuestions.push({ fieldId: 'q1', answerId: 'ans1', question: 'Why us?' }, { fieldId: 'q2', answerId: 'ans2', question: 'How did you hear about us?' })
    const { readForm } = await import('./steps')
    expect(await readForm.run(ctx())).toEqual({ kind: 'continue', line: 'Read 2 questions; 2 need your answer.', add: [{ step: 'draft_answers', why: 'The form asks 1 question you have not answered.' }, { step: 'cover_letter', why: 'The form asks for a cover letter.' }] })
    // only a short question open: it waits as before, but keeps the required cover-letter step
    openQuestions.splice(0, 1)
    expect(await readForm.run(ctx())).toMatchObject({ kind: 'wait', reason: 'answer', line: '1 question needs your answer.', add: [{ step: 'cover_letter', why: 'The form asks for a cover letter.' }] })
  })

  it('draft_answers drafts each open long question and waits for the person, with the reason when it could not', async () => {
    openQuestions.push({ fieldId: 'q1', answerId: 'ans1', question: 'Why us?' }, { fieldId: 'q2', answerId: 'ans2', question: 'How did you hear about us?' })
    const drafted: string[] = []
    const out = await draftAnswers.run(ctx({ draftAnswer: async (_a, q) => (drafted.push(q.answerId), { ok: true }) }))
    expect(drafted).toEqual(['ans1'])
    expect(out).toEqual({ kind: 'wait', reason: 'answer', detail: { answer_ids: ['ans1', 'ans2'], questions: ['Why us?', 'How did you hear about us?'], drafted: 1 }, line: 'Drafted 1 answer for you to check. Cello never sends an answer you did not give.' })
    const refused = await draftAnswers.run(ctx({ draftAnswer: async () => ({ ok: false, reason: 'Free models allow 5 drafts a day.' }) }))
    expect(refused).toMatchObject({ kind: 'wait', reason: 'answer', line: '2 questions need your answer. Cello could not draft them (Free models allow 5 drafts a day).' })
  })

  it('cover_letter writes once, waits for approval like the resume, and carries on when approved or hands-off', async () => {
    const writes = vi.fn(async () => (letters.push({ id: 'cl1', version: 1, text: 'Dear Acme' }), { artifact_id: 'cl1', version: 1 }))
    const hash = createHash('sha256').update('Dear Acme').digest('hex').slice(0, 32)
    expect(await coverLetter.run(ctx({ writeCoverLetter: writes }))).toEqual({ kind: 'wait', reason: 'approve_resume', detail: { artifact_id: 'cl1', version: 1, hash, what: 'cover_letter' }, line: 'Needs you: approve the cover letter.' })
    expect(await coverLetter.run(ctx({ writeCoverLetter: writes }))).toMatchObject({ kind: 'wait' })
    expect(writes).toHaveBeenCalledTimes(1)
    const approved = { pipeline_events: [{ application_id: 'a1', user_id: 'u1', kind: 'approval.decided', payload: { decision: 'approved', what: 'cover_letter', hash } }] }
    expect(await coverLetter.run(ctx({ writeCoverLetter: writes }, approved))).toMatchObject({ kind: 'continue', line: 'You approved version 1 of the cover letter.' })
    const handsOff = { pipeline_events: [{ application_id: 'a1', user_id: 'u1', kind: 'application.created', payload: { mode: 'hands_off' } }], profiles: [{ id: 'u1', preferences: { pipeline: { send: { mode: 'auto' }, resumeApproval: false } } }] }
    expect(await coverLetter.run(ctx({ writeCoverLetter: writes }, handsOff))).toMatchObject({ kind: 'continue', line: 'Hands-off: version 1 of the cover letter goes with it, without asking you.' })
    letters.length = 0
    expect(await coverLetter.run(ctx({ writeCoverLetter: async () => ({ error: 'The draft could not be written: Free models allow 5 drafts a day.' }) }))).toEqual({ kind: 'continue', line: 'Cello could not write the cover letter (Free models allow 5 drafts a day). Write one yourself if the form needs it.' })
  })
})

describe('the steps', () => {
  it('closes a posting that is closed and waits on Already applied? for a send-blocked one', async () => {
    const { checkOpen, dedupe } = await import('./steps')
    const ctx = (over: Row = {}, blocked = false) => ({ admin: { rpc: async () => ({ data: blocked, error: null }), from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as any, app: { id: 'a1', user_id: 'u1', job_id: 'j1', posting_url_hash: 'h' }, job: { url: 'u', title: 't', company_id: 'c', closed_at: null, still_open: true, companyName: 'Acme', ...over }, fetchForm: async () => ({}) })
    expect(await checkOpen.run(ctx({ closed_at: '2026-10-01T00:00:00Z' }))).toMatchObject({ kind: 'close', closedReason: 'posting_closed' })
    expect(await checkOpen.run(ctx())).toMatchObject({ kind: 'continue' })
    expect(await dedupe.run(ctx({}, true))).toMatchObject({ kind: 'wait', reason: 'duplicate' })
    expect(await dedupe.run(ctx({}, false))).toMatchObject({ kind: 'continue' })
  })

  it('reads a Greenhouse question with its options, and skips the file inputs', () => {
    const fields = readGreenhouseFields({
      questions: [
        { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
        { label: 'How did you hear about this job?', required: true, fields: [{ name: 'question_1', type: 'multi_value_single_select', values: [{ label: 'LinkedIn', value: 1 }, { label: 'A friend', value: 2 }] }] },
        { label: 'Why us?', required: false, fields: [{ name: 'question_2', type: 'textarea' }] },
      ],
    })
    expect(fields).toEqual([
      { id: 'question_1', label: 'How did you hear about this job?', required: true, kind: 'select', options: ['LinkedIn', 'A friend'] },
      { id: 'question_2', label: 'Why us?', required: false, kind: 'long_text', options: undefined },
    ])
  })
})

describe('cost', () => {
  it('sums free and paid rows apart, and says Free when nothing cost anything', () => {
    const c = sumCost([{ cost_usd: 0, free_model: true }, { cost_usd: 0, free_model: true }, { cost_usd: 0.0312, free_model: false }, { cost_usd: null, free_model: null }])
    expect(c).toEqual({ usd: 0.0312, free: 2, paid: 1 })
    expect(costLine(c)).toBe('$0.03')
    expect(costLine(sumCost([{ cost_usd: 0, free_model: true }]))).toBe('Free')
    expect(costLine(sumCost([]))).toBe('')
  })

  it('tells a daily limit from a per-minute one, and nothing else from either', () => {
    expect(rateLimitOf(Object.assign(new Error('free-models-per-day'), { status: 429 }))).toBe('daily')
    expect(rateLimitOf(Object.assign(new Error('slow down'), { status: 429 }))).toBe('minute')
    expect(rateLimitOf(new Error('boom'))).toBeNull()
    expect(waitAfter('minute', new Date(NOW)).nextAt).toBe('2026-10-14T12:01:00.000Z')
  })
})

describe('tailor', () => {
  const ctx = (tailorResume: StepCtx['tailorResume'], tables: Record<string, Row[]> = { pipeline_events: [] }): StepCtx => ({
    admin: fakeAdmin(tables),
    app: { id: 'a1', user_id: 'u1', job_id: 'j1', posting_url_hash: null },
    job: { url: 'https://example.com/jobs/1', title: 'Engineer', company_id: 'c1', closed_at: null, still_open: true, companyName: 'Acme' },
    fetchForm: async () => ({}),
    tailorResume,
  })

  it('says why tailoring was skipped', async () => {
    const out = await tailor.run(ctx(async () => ({ error: 'The draft could not be written: Free models allow 5 drafts a day. Add credit or choose another way to run.' })))
    expect(out).toEqual({ kind: 'continue', line: 'Cello could not tailor your resume (Free models allow 5 drafts a day. Add credit or choose another way to run), so your base resume goes with it.' })
    expect(await tailor.run(ctx(async () => null))).toEqual({ kind: 'continue', line: 'Cello could not tailor your resume, so your base resume goes with it.' })
  })

  const doc = { artifact_id: 'art1', version: 2, content: 'Tailored text', title: 'Resume for Engineer' }
  const hash = createHash('sha256').update(doc.content).digest('hex').slice(0, 32)
  const created = (mode: string, created_at = '2026-10-14T11:00:00Z') => ({ application_id: 'a1', user_id: 'u1', kind: 'application.created', payload: { mode }, created_at })
  const prefs = (pipeline: Record<string, unknown>) => ({ id: 'u1', preferences: { pipeline } })
  const application = () => ({ id: 'a1', user_id: 'u1', resume_artifact_id: null as string | null })
  const handsOff = { send: { mode: 'auto' }, resumeApproval: false }

  it('does not stop for the resume in hands-off with Send for me on and resume review off, and attaches the version that goes with it', async () => {
    vi.mocked(getLatestVersion).mockResolvedValue(doc as never)
    const tables = { pipeline_events: [created('hands_off')], profiles: [prefs(handsOff)], applications: [application()] }
    const out = await tailor.run(ctx(undefined, tables))
    expect(out).toMatchObject({ kind: 'continue', line: 'Hands-off: version 2 of the tailored resume goes with it, without asking you.', payload: { artifact_id: 'art1', version: 2, hash } })
    expect(tables.applications[0].resume_artifact_id).toBe('art1')
  })

  it('attaches the version the person approved, and nothing while it still waits', async () => {
    vi.mocked(getLatestVersion).mockResolvedValue(doc as never)
    const waiting = { pipeline_events: [created('ask')], profiles: [prefs(handsOff)], applications: [application()] }
    expect(await tailor.run(ctx(undefined, waiting))).toMatchObject({ kind: 'wait', reason: 'approve_resume' })
    expect(waiting.applications[0].resume_artifact_id).toBeNull()
    const approved = { pipeline_events: [created('ask'), { application_id: 'a1', user_id: 'u1', kind: 'approval.decided', payload: { decision: 'approved', what: 'resume', hash } }], profiles: [prefs(handsOff)], applications: [application()] }
    expect(await tailor.run(ctx(undefined, approved))).toMatchObject({ kind: 'continue', line: 'You approved version 2 of the tailored resume.', payload: { artifact_id: 'art1', version: 2, hash } })
    expect(approved.applications[0].resume_artifact_id).toBe('art1')
  })

  it('stops for the resume in Ask first, and in hands-off while Send for me is off or each resume is to be shown first', async () => {
    vi.mocked(getLatestVersion).mockResolvedValue(doc as never)
    const wait = { kind: 'wait', reason: 'approve_resume', line: 'Needs you: approve version 2 of the tailored resume.' }
    expect(await tailor.run(ctx(undefined, { pipeline_events: [created('ask')], profiles: [prefs({ send: { mode: 'auto' }, resumeApproval: false })] }))).toMatchObject(wait)
    expect(await tailor.run(ctx(undefined, { pipeline_events: [created('hands_off')], profiles: [prefs({ send: { mode: 'me' }, resumeApproval: false })] }))).toMatchObject(wait)
    expect(await tailor.run(ctx(undefined, { pipeline_events: [created('hands_off')], profiles: [prefs({ send: { mode: 'auto' }, resumeApproval: true })] }))).toMatchObject(wait)
    vi.mocked(getLatestVersion).mockResolvedValue(null)
  })

  it('reads the mode from the newest start: a start again in Ask first waits, whatever the first start said', async () => {
    vi.mocked(getLatestVersion).mockResolvedValue(doc as never)
    const again = [created('hands_off', '2026-10-14T10:00:00Z'), created('ask', '2026-10-14T11:00:00Z')]
    expect(await tailor.run(ctx(undefined, { pipeline_events: again, profiles: [prefs(handsOff)], applications: [application()] }))).toMatchObject({ kind: 'wait', reason: 'approve_resume' })
    expect(await startedHandsOff(fakeAdmin({ pipeline_events: again }), { id: 'a1', user_id: 'u1' })).toBe(false)
    expect(await startedHandsOff(fakeAdmin({ pipeline_events: [...again].reverse() }), { id: 'a1', user_id: 'u1' })).toBe(false)
    expect(await startedHandsOff(fakeAdmin({ pipeline_events: [created('ask', '2026-10-14T10:00:00Z'), created('hands_off', '2026-10-14T11:00:00Z')] }), { id: 'a1', user_id: 'u1' })).toBe(true)
    vi.mocked(getLatestVersion).mockResolvedValue(null)
  })
})
