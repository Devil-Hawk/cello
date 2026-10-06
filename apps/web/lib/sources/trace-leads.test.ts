import { describe, expect, it } from 'vitest'
import type { AtsJob } from '../ats/types'
import { fakeDb } from '../companies/fake-db'
import { leadsAreTraced, traceLeads, VERIFY_PER_BATCH } from './trace-leads'
import type { JobLead } from './types'

const NOW = Date.now()
const fresh: AtsJob[] = [{ title: 'Engineer', url: 'https://boards.example/1', externalId: '1', postedAt: new Date(NOW - 3 * 86_400_000).toISOString() }]
const verify = { now: () => NOW, fetchBoard: async () => fresh, identify: async () => ({ name: 'Acme', homeUrls: [] }), pageBoards: async () => [] }

const lead = (over: Partial<JobLead> = {}): JobLead => ({
  company: 'Acme', title: 'Software Engineer', url: 'https://themuse.example/jobs/1', location: 'Remote', salary: null, description: 'Build things.', source: 'themuse', externalId: 'm-1', companyDomain: null, postedAt: null, ...over,
})
const employer = { id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', careers_url: 'https://acme.com/careers', ats_provider: 'greenhouse', ats_token: 'acme', verified_at: '2026-10-01T00:00:00Z' }

/** `byTitle`: the employer already has the role stored under its title; otherwise only an id lookup finds it. */
function world(tables: Record<string, Record<string, unknown>[]> = {}, stored: { id: string; external_id?: string; location: string | null }[] = [], byTitle = true) {
  const calls: Record<string, Record<string, unknown>[]> = { upsert_employer_jobs: [], add_person_roles: [], set_person_counts: [] }
  const { client, tables: t, queries } = fakeDb(
    { profiles: [{ id: 'u1', targets_version: 3 }], company_directory: [], companies: [], person_counts: [], ...tables },
    {
      rpc: {
        employer_roles: (a) => (a.p_external_ids ? stored.filter((s) => (a.p_external_ids as string[]).includes(s.external_id ?? '')) : byTitle ? stored : []),
        upsert_employer_jobs: (a) => (calls.upsert_employer_jobs.push(a), 1),
        add_person_roles: (a) => (calls.add_person_roles.push(a), 1),
        set_person_counts: (a) => (calls.set_person_counts.push(a), 1),
      },
    }
  )
  return { client, calls, tables: t, queries }
}

describe('leadsAreTraced', () => {
  it('is on only when the flag row says so, and a database that cannot say is off', async () => {
    expect(await leadsAreTraced(world({ instance_flags: [{ key: 'directory_leads', on: true }] }).client)).toBe(true)
    expect(await leadsAreTraced(world({ instance_flags: [{ key: 'directory_leads', on: false }] }).client)).toBe(false)
    expect(await leadsAreTraced(world().client)).toBe(false)
    expect(await leadsAreTraced({ from: () => { throw new Error('no table') } } as never)).toBe(false)
  })
})

describe('traceLeads: a lead is a role only when traced to the employer own posting, else a count', () => {
  it('a lead the employer board already lists is the role the sweep stored: the person is given it', async () => {
    const { client, calls, queries } = world({ company_directory: [employer] }, [{ id: 'j1', location: 'Remote' }])
    const r = await traceLeads(client, 'u1', [lead({ companyDomain: 'acme.com' })], { verify })
    expect(r).toMatchObject({ jobIds: ['j1'], inserted: 0, untraced: 0, errors: [] })
    expect(calls.add_person_roles).toEqual([{ p_user: 'u1', p_job_ids: ['j1'], p_hidden: [], p_targets_version: 3 }])
    expect(calls.set_person_counts).toEqual([])
    // no company is made from a lead, no role stored from an aggregator copy
    expect(queries.filter((q) => q.op !== 'select')).toEqual([])
  })

  it('a lead that is the employer own posting is stored once for the employer', async () => {
    const own = lead({ url: 'https://acme.com/careers/jobs/77', externalId: 'own-77', companyDomain: 'acme.com' })
    const { client, calls } = world({ company_directory: [employer] }, [{ id: 'j7', external_id: 'own-77', location: 'Remote' }], false)
    // nothing stored under that title yet: the title lookup finds nothing, the id lookup finds the new row
    const r = await traceLeads(client, 'u1', [own], { verify })
    expect(calls.upsert_employer_jobs).toHaveLength(1)
    const sent = calls.upsert_employer_jobs[0]
    expect(sent.p_employer).toBe('e1')
    expect((sent.p_rows as { employer_id: string; source: string; external_id: string; company_id?: string }[])[0]).toMatchObject({ employer_id: 'e1', source: 'themuse', external_id: 'own-77' })
    expect((sent.p_rows as { company_id?: string }[])[0]).not.toHaveProperty('company_id')
    expect(r.inserted).toBe(1)
  })

  it('a lead for an employer Cello does not have, with nothing to verify it by, is a count and nothing else', async () => {
    const { client, calls, queries } = world()
    const r = await traceLeads(client, 'u1', [lead(), lead({ externalId: 'm-2', title: 'Data Engineer' })], { verify })
    expect(r).toMatchObject({ jobIds: [], inserted: 0, untraced: 2 })
    expect(calls.set_person_counts).toEqual([{ p_user: 'u1', p_rows: [{ employer_id: null, company_id: null, kind: 'untraced', reason: 'themuse', n: 2 }] }])
    expect(calls.upsert_employer_jobs).toEqual([])
    expect(queries.filter((q) => q.op !== 'select')).toEqual([])
  })

  it('a lead for a verified employer that its board does not list, on an aggregator address, is untraced', async () => {
    const { client, calls } = world({ company_directory: [employer] }, [])
    const r = await traceLeads(client, 'u1', [lead({ companyDomain: 'acme.com' })], { verify })
    expect(r).toMatchObject({ jobIds: [], untraced: 1 })
    expect(calls.upsert_employer_jobs).toEqual([])
  })

  it('a common-word name that two verified employers share is not taken for either', async () => {
    const a = { ...employer, id: 'm1', name: 'Mercury', name_norm: 'mercury', domain: 'mercury.com', ats_token: 'mercury' }
    const b = { ...employer, id: 'm2', name: 'Mercury', name_norm: 'mercury', domain: 'mercury.co.uk', ats_token: 'mercury-uk' }
    const { client } = world({ company_directory: [a, b] }, [{ id: 'j1', location: 'Remote' }])
    const r = await traceLeads(client, 'u1', [lead({ company: 'Mercury' })], { verify })
    expect(r).toMatchObject({ jobIds: [], untraced: 1 })
  })

  it('a lead that points at a board is checked by the verifier, joins the directory as a lead, and is then traced', async () => {
    const { client, calls, tables } = world({}, [{ id: 'j9', external_id: 'g-123', location: 'Remote' }], false)
    const l = lead({ url: 'https://boards.greenhouse.io/acme/jobs/123', externalId: 'g-123' })
    const r = await traceLeads(client, 'u1', [l], { verify })
    expect(tables.company_directory).toHaveLength(1)
    expect(tables.company_directory[0]).toMatchObject({ source: 'lead', ats_provider: 'greenhouse', ats_token: 'acme', verified_by: 'seed_checked' })
    expect(r.untraced).toBe(0)
    expect(calls.upsert_employer_jobs).toHaveLength(1)
    expect(r.jobIds).toEqual(['j9'])
  })

  it('looks an employer up on the web for only a few leads in a batch, and counts the rest', async () => {
    const many = Array.from({ length: VERIFY_PER_BATCH + 3 }, (_, i) =>
      lead({ company: `Co ${i}`, companyDomain: `co${i}.example`, externalId: `m-${i}`, url: `https://themuse.example/jobs/${i}` })
    )
    const failing = { ...verify, fetchBoard: async () => [] as AtsJob[] }
    const { client } = world()
    const r = await traceLeads(client, 'u1', many, { verify: failing })
    expect(r.untraced).toBe(VERIFY_PER_BATCH + 3)
  })

  it('adds to what earlier batches of the day found', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { client, calls } = world({ person_counts: [{ user_id: 'u1', day: today, kind: 'untraced', reason: 'themuse', n: 2, employer_id: null, company_id: null }] })
    await traceLeads(client, 'u1', [lead()], { verify })
    expect(calls.set_person_counts[0]).toMatchObject({ p_rows: [{ kind: 'untraced', reason: 'themuse', n: 3 }] })
  })
})
