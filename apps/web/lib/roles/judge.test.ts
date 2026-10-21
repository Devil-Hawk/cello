import { describe, expect, it, vi } from 'vitest'
import { fakeDb } from '@/lib/companies/fake-db'
import { parseRequirements } from '@/lib/jobs/requirements'
import { Bucket, type DoorDeps } from './free-door'
import { checkingLine, dayLine, judgeRole, judgeRoles, judgeStatus, nextWaiting, NO_REQUIREMENTS_LINE } from './judge'

const NOW = new Date('2026-10-22T10:00:00Z')
const RESUME = `Jane Doe
Backend engineer, Brightpay, 2020-2024: built payment services in Go handling 2M requests per day
Backend engineer, Loop, 2018-2020: Java services, on-call rotation
Skills: Go, Java, PostgreSQL, AWS`

const MD = `## About the role
We build payments.

## Requirements
- 4+ years of backend engineering
- Strong Go or Java
- Experience with fraud detection
- Must be authorized to work in the United States

## Nice to have
- Kubernetes
`

function job(id: string, md: string, extra: Record<string, unknown> = {}) {
  const requirements = parseRequirements({ title: 'Backend Engineer', description: md, descriptionMd: md })
  return { viewer_id: 'u1', id, title: 'Backend Engineer', description: md, description_md: md, location: null, salary_range: null, requirements, viewer_company_name: 'Acme', viewer_company_id: 'c1', ...extra }
}

type Answer = Record<string, unknown>
function setup(opts: { jobs?: Record<string, unknown>[]; answers?: (name: string, system: string) => Answer | Error; day?: boolean; resume?: boolean } = {}) {
  const jobs = opts.jobs ?? [job('j1', MD)]
  const { client, tables } = fakeDb(
    {
      person_jobs: jobs,
      jobs: jobs.map((j) => ({ id: j.id, requirements: j.requirements })),
      person_roles: jobs.map((j, i) => ({ user_id: 'u1', job_id: j.id, judged_at: null, hidden_reason: null, visible_since: `2026-10-2${i}T00:00:00Z`, band: null })),
      resume_documents: opts.resume === false ? [] : [{ id: 'rd1', user_id: 'u1', job_id: null, version: 7, content: RESUME }],
      profiles: [{ id: 'u1', resume_text: opts.resume === false ? null : RESUME }],
    },
    { rpc: { take_judge_call: () => opts.day !== true } }
  )
  const call = vi.fn(async (_keys: unknown, req: { name: string; system: string }) => {
    const a = opts.answers?.(req.name, req.system) ?? { checks: [] }
    if (a instanceof Error) throw a
    return { content: JSON.stringify(a), model: 'google/gemma-4-31b-it:free', promptTokens: 1, completionTokens: 1, tokensUsed: 2 }
  })
  const door = {
    call: call as never,
    loadKeys: async () => ({ userId: 'u1' }) as never,
    platformKey: () => 'sk-platform',
    selfHosted: () => false,
    bucket: new Bucket(100, 60_000, () => NOW.getTime()),
    now: () => NOW,
    dailyCap: () => 800,
    models: () => ['google/gemma-4-31b-it:free'],
  } satisfies DoorDeps
  const row = (id: string) => tables.person_roles.find((r) => r.job_id === id)!
  return { db: client, tables, call, door, row, deps: { door, now: () => NOW } }
}

const strongAnswer = {
  checks: [
    { id: 'j1.r1', status: 'met', line: 2, quote: 'Backend engineer, Brightpay, 2020-2024' },
    { id: 'j1.r2', status: 'met', line: 2, quote: 'built payment services in Go' },
    { id: 'j1.r3', status: 'partial', line: 2, quote: 'built payment services in Go handling 2M requests per day' },
    { id: 'j1.r4', status: 'not_met', line: null, quote: null },
  ],
}

describe('judgeRole', () => {
  it('turns the items into readings with their quotes and a band, with provenance and the time', async () => {
    const t = setup({ answers: () => strongAnswer })
    const out = await judgeRole(t.db, 'u1', 'j1', t.deps)
    expect(out).toEqual({ judged: ['j1'], stopped: null })
    const r = t.row('j1') as { band: string; readings: Record<string, unknown>[]; prov: Record<string, unknown>; judged_at: string; chance: string }
    expect(r.band).toBe('strong')
    expect(r.chance).toBe('strong')
    expect(r.judged_at).toBe(NOW.toISOString())
    expect(r.readings.map((x) => [x.text, x.status, x.line])).toEqual([
      ['4+ years of backend engineering', 'met', 2],
      ['Strong Go or Java', 'met', 2],
      ['Experience with fraud detection', 'partial', 2],
      ['Kubernetes', 'not_met', null],
      ['Must be authorized to work in the United States', 'unclear', null],
    ])
    expect(r.readings[0]).toMatchObject({ kind: 'must', quote: 'Backend engineer, Brightpay, 2020-2024', source: 'resume v7' })
    expect(r.readings[3]).toMatchObject({ kind: 'nice' })
    expect(r.prov).toEqual({
      step: 'role.evidence',
      model: 'google/gemma-4-31b-it:free',
      rung: 'R3',
      evidence: [{ table: 'jobs', id: 'j1' }, { table: 'resume_documents', id: 'rd1' }],
      at: NOW.toISOString(),
    })
    expect(t.call).toHaveBeenCalledTimes(1)
  })

  it('marks work authorization and place items to confirm, never reads them and never lets them move the band', async () => {
    const t = setup({ answers: () => strongAnswer })
    await judgeRole(t.db, 'u1', 'j1', t.deps)
    const r = t.row('j1') as { readings: Record<string, unknown>[]; chance_detail: { confirm: string[] } }
    const confirm = r.readings.filter((x) => x.confirm)
    expect(confirm).toHaveLength(1)
    expect(confirm[0]).toMatchObject({ text: 'Must be authorized to work in the United States', status: 'unclear', line: null, quote: null })
    expect(r.chance_detail.confirm).toEqual(['Must be authorized to work in the United States'])
    expect((t.call.mock.calls[0][1] as unknown as { prompt: string }).prompt).not.toContain('authorized')
  })

  it('never shows a reading as met when its quote is not on the cited resume line', async () => {
    const t = setup({
      answers: () => ({
        checks: [
          { id: 'j1.r1', status: 'met', line: 2, quote: 'ten years leading a staff team' },
          { id: 'j1.r2', status: 'met', line: 3, quote: 'built payment services in Go' },
          { id: 'j1.r3', status: 'partial', line: 99, quote: 'fraud detection' },
          { id: 'j1.r4', status: 'not_met', line: null, quote: null },
        ],
      }),
    })
    await judgeRole(t.db, 'u1', 'j1', t.deps)
    const r = t.row('j1') as { band: string; readings: { status: string; quote: string | null; line: number | null }[] }
    expect(r.readings.slice(0, 3).map((x) => [x.status, x.quote, x.line])).toEqual([['not_met', null, null], ['not_met', null, null], ['not_met', null, null]])
    expect(r.band).toBe('stretch')
    expect(r.readings.every((x) => x.status !== 'met' || x.quote)).toBe(true)
  })

  it('writes cannot_assess with the reason no_requirements for a thin posting, and makes no call', async () => {
    const thin = 'We are hiring a backend engineer. Come and build with us.'
    const t = setup({ jobs: [job('j1', thin)] })
    expect(await judgeRole(t.db, 'u1', 'j1', t.deps)).toEqual({ judged: ['j1'], stopped: null })
    const r = t.row('j1') as { band: string; prov: Record<string, unknown>; judged_at: string; chance_detail: { note: string } }
    expect(r.band).toBe('cannot_assess')
    expect(r.prov).toMatchObject({ rule: 'no_requirements' })
    expect(r.judged_at).toBe(NOW.toISOString())
    expect(r.chance_detail.note).toBe(NO_REQUIREMENTS_LINE)
    expect(t.call).not.toHaveBeenCalled()
  })

  it('reads a posting with no list through the role.requirements step and keeps only items found verbatim in the posting', async () => {
    const prose = `We are a payments company in Lisbon and we move money for small shops across Europe every day. ${'The team ships often and values clear writing. '.repeat(8)}You know Go and PostgreSQL well, you have run Kubernetes in production, and fraud detection is part of the work.`
    const t = setup({
      jobs: [job('j1', prose)],
      answers: (name) =>
        name === 'role.requirements'
          ? { must_have: ['Go', 'PostgreSQL', 'Rust and Haskell'], nice_to_have: ['Kubernetes'], years_min: null }
          : { checks: [{ id: 'j1.r1', status: 'met', line: 2, quote: 'built payment services in Go' }, { id: 'j1.r2', status: 'met', line: 4, quote: 'PostgreSQL' }, { id: 'j1.r3', status: 'not_met', line: null, quote: null }] },
    })
    await judgeRole(t.db, 'u1', 'j1', t.deps)
    expect(t.call.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual(['role.requirements', 'role.evidence'])
    const stored = t.tables.jobs[0].requirements as { items: { text: string; origin: string; prov: Record<string, string> }[]; model_checked_at: string }
    expect(stored.items.map((i) => i.text).sort()).toEqual(['Go', 'Kubernetes', 'PostgreSQL'])
    expect(stored.items[0]).toMatchObject({ origin: 'model', prov: { step: 'role.requirements', model: 'google/gemma-4-31b-it:free' } })
    expect(stored.model_checked_at).toBeTruthy()
    expect(t.row('j1')).toMatchObject({ band: 'strong' })
  })

  it('does not ask a model again for a posting a model already read', async () => {
    const prose = `${'We make payment tools for shops and we write about it. '.repeat(10)}`
    const j = job('j1', prose)
    ;(j.requirements as Record<string, unknown>).model_checked_at = '2026-10-21T00:00:00Z'
    const t = setup({ jobs: [j] })
    await judgeRole(t.db, 'u1', 'j1', t.deps)
    expect(t.call).not.toHaveBeenCalled()
    expect((t.row('j1') as { band: string }).band).toBe('cannot_assess')
  })

  it('leaves the role waiting and says why when the day share is used', async () => {
    const t = setup({ day: true })
    expect(await judgeRole(t.db, 'u1', 'j1', t.deps)).toEqual({ judged: [], stopped: 'day' })
    expect(t.call).not.toHaveBeenCalled()
    expect((t.row('j1') as { judged_at: unknown }).judged_at).toBeNull()
  })

  it('stops with no_resume when there is no resume, and ignores a role the person does not hold', async () => {
    const none = setup({ resume: false })
    expect(await judgeRole(none.db, 'u1', 'j1', none.deps)).toEqual({ judged: [], stopped: 'no_resume' })
    const t = setup({ answers: () => strongAnswer })
    expect(await judgeRoles(t.db, 'u1', ['someone-elses'], t.deps)).toEqual({ judged: [], stopped: null })
    expect(t.call).not.toHaveBeenCalled()
  })

  it('marks the role cannot_assess with a code reason when the model answers nothing usable, keeping the run going', async () => {
    const t = setup({ answers: () => ({ nope: 1 }) })
    expect(await judgeRole(t.db, 'u1', 'j1', t.deps)).toEqual({ judged: ['j1'], stopped: null })
    expect(t.row('j1')).toMatchObject({ band: 'cannot_assess', prov: { rule: 'check_failed' } })
  })

  it('judges three roles in one call', async () => {
    const jobs = ['j1', 'j2', 'j3', 'j4'].map((id) => job(id, MD))
    const t = setup({ jobs, answers: () => ({ checks: [] }) })
    await judgeRoles(t.db, 'u1', ['j1', 'j2', 'j3', 'j4'], t.deps)
    expect(t.call).toHaveBeenCalledTimes(2)
  })
})

describe('nextWaiting', () => {
  it('lists newest first, with roles at followed employers before the rest, and skips judged and hidden ones', async () => {
    const jobs = [job('old-followed', MD), job('new-directory', MD, { viewer_company_id: null }), job('mid-directory', MD, { viewer_company_id: null }), job('judged', MD), job('hidden', MD)]
    const { client, tables } = fakeDb({
      person_jobs: jobs,
      person_roles: [
        { user_id: 'u1', job_id: 'old-followed', judged_at: null, hidden_reason: null, visible_since: '2026-10-01T00:00:00Z' },
        { user_id: 'u1', job_id: 'new-directory', judged_at: null, hidden_reason: null, visible_since: '2026-10-21T00:00:00Z' },
        { user_id: 'u1', job_id: 'mid-directory', judged_at: null, hidden_reason: null, visible_since: '2026-10-10T00:00:00Z' },
        { user_id: 'u1', job_id: 'judged', judged_at: '2026-10-20T00:00:00Z', hidden_reason: null, visible_since: '2026-10-22T00:00:00Z' },
        { user_id: 'u1', job_id: 'hidden', judged_at: null, hidden_reason: 'not_for_me', visible_since: '2026-10-22T00:00:00Z' },
        { user_id: 'u2', job_id: 'new-directory', judged_at: null, hidden_reason: null, visible_since: '2026-10-22T00:00:00Z' },
      ],
    })
    expect(await nextWaiting(client, 'u1', 10)).toEqual(['old-followed', 'new-directory', 'mid-directory'])
    expect(await nextWaiting(client, 'u1', 2)).toEqual(['old-followed', 'new-directory'])
    expect(tables.person_roles).toHaveLength(6)
  })
})

describe('judgeStatus', () => {
  const rows = (judgedToday: number, waiting: number) => [
    ...Array.from({ length: judgedToday }, (_, i) => ({ user_id: 'u1', job_id: `d${i}`, judged_at: '2026-10-22T08:00:00Z', hidden_reason: null })),
    ...Array.from({ length: waiting }, (_, i) => ({ user_id: 'u1', job_id: `w${i}`, judged_at: null, hidden_reason: null })),
  ]
  const status = (judgedToday: number, waiting: number, budget: unknown[], keys: Record<string, unknown> = {}) => {
    const { client } = fakeDb({ person_roles: rows(judgedToday, waiting), judge_budget: budget as never })
    const door = { dailyCap: () => 800, now: () => NOW, loadKeys: async () => ({ userId: 'u1', ...keys }) } as unknown as DoorDeps
    return judgeStatus(client, 'u1', { door, now: () => NOW })
  }

  it('says nothing when nothing waits', async () => {
    expect(await status(5, 0, [])).toEqual({ judgedToday: 5, waiting: 0, line: null })
  })
  it('says the roles are being checked while the share lasts', async () => {
    const s = await status(3, 12, [{ day: '2026-10-22', calls: 3, by_user: { u1: 3 } }])
    expect(s.line).toBe('12 more are being checked. Until then they are listed by title and date.')
    expect(s.line).toBe(checkingLine(12))
  })
  it('says the day line once the share is used', async () => {
    const s = await status(40, 80, [{ day: '2026-10-22', calls: 800, by_user: { u1: 800 } }])
    expect(s).toEqual({ judgedToday: 40, waiting: 80, line: 'Cello judged 40 of your 120 new roles today. The rest continue tomorrow.' })
    expect(s.line).toBe(dayLine(40, 80))
  })
  it('does not say the day line to a person with a key of their own', async () => {
    const s = await status(40, 80, [{ day: '2026-10-22', calls: 800, by_user: { u1: 800 } }], { openrouter: 'sk-own' })
    expect(s.line).toBe(checkingLine(80))
  })
})
