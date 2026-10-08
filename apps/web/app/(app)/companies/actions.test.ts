import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  user: null as { id: string } | null,
  session: null as unknown,
  admin: null as unknown,
  used: 0,
  slots: {} as Record<string, boolean>,
  findPosting: vi.fn(),
  previewPosting: vi.fn(),
  saveCompany: vi.fn(),
  runEvidenceStep: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.session }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => m.admin }))
vi.mock('@/lib/companies/directory', () => ({ getEmployer: async () => ({ id: '00000000-0000-4000-8000-0000000000e1', name: 'Stripe', ats_provider: 'greenhouse' }) }))
vi.mock('@/lib/companies/add', () => ({ saveCompany: m.saveCompany }))
vi.mock('@/lib/companies/preview', () => ({ previewPosting: m.previewPosting }))
vi.mock('./read', () => ({ findCompanies: async () => ({ employers: [], notChecked: [] }) }))
vi.mock('./[id]/read', () => ({
  ownFor: async () => null,
  findPosting: m.findPosting,
  previewRequirements: () => ({ reqs: [{ id: 'r1' }], authorizationIds: new Set<string>(), kinds: { r1: 'must' } }),
}))
vi.mock('@/lib/fit/material', () => ({ loadMaterial: async () => ({ sources: [] }) }))
vi.mock('@/lib/fit/code', () => ({ codeVerdicts: (reqs: { id: string }[]) => reqs.map((r) => ({ requirementId: r.id, verdict: 'unknown', origin: 'code' })) }))
vi.mock('@/lib/fit/evidence', () => ({ runEvidenceStep: m.runEvidenceStep }))
vi.mock('@/lib/fit/store', () => ({ modelReadsSince: async () => m.used }))
vi.mock('@/lib/fit', async (orig) => ({ ...(await orig<typeof import('@/lib/fit')>()), evidenceLive: async () => true }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({}) }))
vi.mock('@/lib/harness/llm-key-message', () => ({ canRunLlm: () => true }))

import { FREE_CHECKS_PER_DAY } from '@/lib/fit'
import { RATE_LINE, closedLine } from '@/components/companies/company-logic'
import { followAnyway, keepPreview, setFollow, previewChance, removeCompany, takeCheck } from './actions'

const EMP = '00000000-0000-4000-8000-0000000000e1'
const OWN = '00000000-0000-4000-8000-0000000000c1'

/** A database that records every write and every rpc. `tables` answers a select by table name; a write answers with no rows. */
function fakeDb(tables: Record<string, unknown> = {}, rpcs: (name: string, args: Record<string, unknown>) => unknown = () => null) {
  const writes: { table: string; op: string; arg: unknown }[] = []
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  const chain = (table: string): unknown => {
    let wrote = false
    const p: unknown = new Proxy(function () {}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (res: (v: unknown) => unknown) => res({ data: wrote ? [] : tables[table] ?? null, error: null })
        if (['insert', 'update', 'upsert', 'delete'].includes(prop))
          return (arg: unknown) => {
            wrote = true
            writes.push({ table, op: prop, arg })
            return p
          }
        return () => p
      },
    })
    return p
  }
  return {
    writes,
    rpcCalls,
    db: {
      auth: { getUser: async () => ({ data: { user: m.user } }) },
      from: chain,
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        rpcCalls.push({ name, args })
        return { data: rpcs(name, args), error: null }
      },
    },
  }
}

/** The shared slot function: a bucket answers true until the test says otherwise. */
const slotAnswer = (name: string, args: Record<string, unknown>) => (name === 'take_command_slot' ? (m.slots[String(args.p_bucket)] ?? true) : name === 'keep_company_role' ? 'job-1' : null)

let session: ReturnType<typeof fakeDb>
let admin: ReturnType<typeof fakeDb>

beforeEach(() => {
  m.user = { id: 'u1' }
  m.used = 0
  m.slots = {}
  m.findPosting.mockReset().mockResolvedValue({ row: { title: 'Forward Deployed Engineer', url: 'https://boards.example/jobs/1', location: 'Remote', postedAt: null, level: 'senior', role_type: 'ai-engineer' }, tier: 'board' })
  m.previewPosting.mockReset().mockResolvedValue({ title: 'Forward Deployed Engineer', description_md: 'Build things.', description_state: 'full', description_source: 'ats', apply_url: 'https://boards.example/apply/1', description_md5: 'abc', requirements: [], salary_range: null, location: 'Remote' })
  m.saveCompany.mockReset()
  m.runEvidenceStep.mockReset().mockResolvedValue(null)
  session = fakeDb()
  admin = fakeDb({}, slotAnswer)
  m.session = session.db
  m.admin = admin.db
})

describe('followAnyway', () => {
  it('refuses a demo profile before it saves anything', async () => {
    session = fakeDb({ profiles: { is_demo: true, demo_expires_at: null } })
    m.session = session.db
    const r = await followAnyway('https://jobs.example.com/careers')
    expect(r.ok).toBe(false)
    expect(m.saveCompany).not.toHaveBeenCalled()
    expect(session.writes).toEqual([])
  })

  it('asks the person to sign in again when there is no session', async () => {
    m.user = null
    expect(await followAnyway('https://jobs.example.com/careers')).toEqual({ ok: false, sentence: 'Sign in again to do that.' })
    expect(m.saveCompany).not.toHaveBeenCalled()
  })
})

describe('following goes through companies_follow only', () => {
  it('followAnyway saves once (saveCompany follows) and writes nothing else', async () => {
    m.saveCompany.mockResolvedValue({ id: OWN })
    const r = await followAnyway('https://jobs.example.com/careers')
    expect(r).toMatchObject({ ok: true, companyId: OWN })
    expect(m.saveCompany).toHaveBeenCalledTimes(1)
    expect(session.writes).toEqual([])
    expect(session.rpcCalls).toEqual([])
  })

  it('stopping a follow also unpins, and the database answers with the sentence', async () => {
    session = fakeDb({}, () => ({ ok: false, sentence: 'You can pin up to 5 companies.' }))
    m.session = session.db
    expect(await setFollow(OWN, { follow: false })).toEqual({ ok: false, sentence: 'You can pin up to 5 companies.' })
    expect(session.rpcCalls).toEqual([{ name: 'companies_follow', args: { p_ids: [OWN], p_on: false, p_user: 'u1', p_pin: false } }])
    expect(session.writes).toEqual([])
  })
})

describe('takeCheck: one an hour', () => {
  it('takes the slot once and refuses the second call with the next hour', async () => {
    let taken = 0
    admin = fakeDb({}, (name) => (name === 'take_command_slot' ? ++taken === 1 : null))
    m.admin = admin.db
    expect(await takeCheck(OWN)).toEqual({ ok: true })
    const second = await takeCheck(OWN)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.sentence).toMatch(/^Checked within the hour\. Try again after \d\d:00 UTC\.$/)
    expect(admin.rpcCalls[0].args).toMatchObject({ p_user: 'u1', p_bucket: `companies.check:${OWN}`, p_limit: 1, p_window_seconds: 3600 })
  })

  it('keeps Check all now in a bucket of its own and refuses an address that is not a company', async () => {
    await takeCheck('all')
    expect(admin.rpcCalls[0].args.p_bucket).toBe('companies.check_all')
    expect((await takeCheck('not-a-uuid')).ok).toBe(false)
    expect(admin.rpcCalls).toHaveLength(1)
  })
})

describe('keepPreview', () => {
  it('stores the role once through keep_company_role for the person in the session, with no company_id in the row', async () => {
    const r = await keepPreview(EMP, 'k1', 'keep')
    expect(r).toEqual({ ok: true, id: 'job-1' })
    const keeps = admin.rpcCalls.filter((c) => c.name === 'keep_company_role')
    expect(keeps).toHaveLength(1)
    expect(keeps[0].args).toMatchObject({ p_user: 'u1', p_employer: EMP })
    const row = keeps[0].args.p_row as Record<string, unknown>
    expect(row).not.toHaveProperty('company_id')
    expect(row).toMatchObject({ title: 'Forward Deployed Engineer', description_md: 'Build things.', apply_url: 'https://boards.example/apply/1' })
    expect(session.writes).toEqual([])
  })

  it('Save also sets saved_at on the person row', async () => {
    await keepPreview(EMP, 'k1', 'save')
    expect(session.writes).toHaveLength(1)
    expect(session.writes[0]).toMatchObject({ table: 'person_roles', op: 'update' })
    expect(typeof (session.writes[0].arg as { saved_at: unknown }).saved_at).toBe('string')
  })

  it('says the role is closed when the key is not in the live read, and keeps nothing', async () => {
    m.findPosting.mockResolvedValue(null)
    expect(await keepPreview(EMP, 'gone', 'keep')).toEqual({ ok: false, sentence: closedLine })
    expect(admin.rpcCalls.some((c) => c.name === 'keep_company_role')).toBe(false)
  })

  it('shares the preview limit with the page read: no place left, nothing read and nothing kept', async () => {
    m.slots['roles.preview'] = false
    expect(await keepPreview(EMP, 'k1', 'keep')).toEqual({ ok: false, sentence: RATE_LINE })
    expect(m.findPosting).not.toHaveBeenCalled()
    expect(admin.rpcCalls.some((c) => c.name === 'keep_company_role')).toBe(false)
  })

  it('refuses a key that is empty or too long without reading anything', async () => {
    expect((await keepPreview(EMP, '', 'keep')).ok).toBe(false)
    expect((await keepPreview(EMP, 'x'.repeat(501), 'keep')).ok).toBe(false)
    expect(admin.rpcCalls).toEqual([])
  })
})

describe('previewChance: Check my chance', () => {
  const writesOf = () => [...session.writes, ...admin.writes]

  it('stores nothing, and takes what is left of the daily cap as the slot limit', async () => {
    m.used = FREE_CHECKS_PER_DAY - 2
    const r = await previewChance(EMP, 'k1')
    expect(r.ok).toBe(true)
    expect(writesOf()).toEqual([])
    expect(admin.rpcCalls.some((c) => c.name === 'keep_company_role')).toBe(false)
    const slot = admin.rpcCalls.find((c) => c.args.p_bucket === 'roles.check_chance')!
    expect(slot.args).toMatchObject({ p_user: 'u1', p_limit: 2, p_window_seconds: 86_400 })
    expect(m.runEvidenceStep).toHaveBeenCalledTimes(1)
  })

  it('is refused with the cap line at the cap, before any model step', async () => {
    m.used = FREE_CHECKS_PER_DAY
    expect(await previewChance(EMP, 'k1')).toEqual({ ok: false, sentence: `You have used today's ${FREE_CHECKS_PER_DAY} checks. Try again tomorrow.` })
    expect(m.runEvidenceStep).not.toHaveBeenCalled()
    expect(writesOf()).toEqual([])
  })

  it('is refused with the cap line when the daily slot is spent, and runs no model step', async () => {
    m.used = 3
    m.slots['roles.check_chance'] = false
    const r = await previewChance(EMP, 'k1')
    expect(r.ok).toBe(false)
    expect(m.runEvidenceStep).not.toHaveBeenCalled()
  })

  it('says the role is closed when the key is not in the live read', async () => {
    m.findPosting.mockResolvedValue(null)
    expect(await previewChance(EMP, 'gone')).toEqual({ ok: false, sentence: closedLine })
  })
})

describe('removeCompany', () => {
  it('says why in a sentence when the database refuses', async () => {
    session = fakeDb({ companies: { name: 'Stripe' } })
    m.session = session.db
    expect(await removeCompany(OWN)).toEqual({ ok: false, sentence: 'Cello cannot remove Stripe while an application there is open.' })
    expect(session.writes).toHaveLength(1)
    expect(session.writes[0]).toMatchObject({ table: 'companies', op: 'delete' })
  })

  it('refuses a row the person does not have', async () => {
    expect((await removeCompany(OWN)).ok).toBe(false)
    expect(session.writes).toEqual([])
  })
})
