import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../ats/http'
import type { AtsJob } from '../ats/types'
import type { BoardIdentity, BoardRef } from '../ats/verify'
import type { SiteRead } from '../ingest/reader'
import { toProfile, type WikidataEntity } from './wikidata'
import { fakeDb } from './fake-db'
import { addByOf, findEmployer, findFromJob, guessDomains, realFindDeps, type Candidate, type FindDeps } from './find'
import type { AddDeps } from './add-link'

const NOW = Date.now()
const job = (i: number): AtsJob => ({ title: `Engineer ${i}`, url: `https://boards.example/${i}`, externalId: `${i}`, postedAt: new Date(NOW - 3 * 86_400_000).toISOString() })
const fresh = [job(1), job(2)]

interface World {
  /** `provider:token` -> what that board answers. A board not listed is a 404. */
  boards?: Record<string, { jobs?: AtsJob[]; identity?: BoardIdentity | null }>
  /** domain -> the boards that site links. */
  pages?: Record<string, BoardRef[]>
  /** domain -> roles the site lists itself. */
  sites?: Record<string, AtsJob[]>
  wikidata?: WikidataEntity[]
  /** null: no search key. */
  web?: string[] | null
  directory?: Record<string, unknown>[]
  tables?: Record<string, Record<string, unknown>[]>
  timeoutMs?: number
}

const entity = (over: Partial<WikidataEntity> = {}): WikidataEntity => ({ qid: 'Q1', label: 'Retell AI', website: 'https://www.retellai.com/', hq: 'San Francisco', employees: 75, industry: null, logo: null, founded: 2023, ticker: null, github: null, fetchedAt: '2026-10-21T00:00:00.000Z', ...over })
const retell = { 'ashby:retell-ai': { jobs: fresh, identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] } } }

function setup(w: World = {}) {
  const fetchBoard = vi.fn(async (provider: string, token: string) => {
    const b = w.boards?.[`${provider}:${token}`]
    if (!b) throw new HttpError('not found', 404)
    return b.jobs ?? fresh
  })
  const pageBoards = vi.fn(async (i: { domain: string | null }) => w.pages?.[i.domain ?? ''] ?? [])
  const read = vi.fn(async (input: { company: { domain: string | null } }) => {
    const jobs = w.sites?.[input.company.domain ?? ''] ?? []
    return (jobs.length ? { tier: 'listing', jobs, complete: true, reason: null, tried: [], checked: [], requests: 1 } : { tier: null, jobs: [], complete: false, reason: 'no_roles', tried: [], checked: [], requests: 1 }) as SiteRead
  })
  const queue = vi.fn(async (_name: string) => 'job-1' as string | null)
  const wikidata = vi.fn(async (_name: string) => w.wikidata ?? [])
  const web = vi.fn(async (_name: string) => (w.web === undefined ? null : w.web))
  const deps: FindDeps = {
    verify: { now: () => NOW, fetchBoard: fetchBoard as never, identify: async (p, t) => w.boards?.[`${p}:${t}`]?.identity ?? null, pageBoards },
    read: read as never,
    wikidata,
    web,
    queue,
    timeoutMs: w.timeoutMs,
  }
  const db = fakeDb({ profiles: [{ id: 'u1', is_demo: false, demo_expires_at: null }], companies: [], ...w.tables }, { rpc: { search_company_directory: () => w.directory ?? [] }, autoId: ['companies', 'company_directory', 'directory_candidates', 'render_jobs'] })
  const events: { rung: string; line: string }[] = []
  const find = (name: string) => findEmployer(db.client, 'u1', name, deps, (e) => events.push(e))
  return { ...db, deps, find, events, fetchBoard, pageBoards, read, queue, wikidata, web }
}
const writes = (queries: { op: string }[]) => queries.filter((q) => q.op !== 'select')
const found = (r: Awaited<ReturnType<ReturnType<typeof setup>['find']>>): Candidate[] => ('candidates' in r ? r.candidates : [])

describe('rung 1: the directory', () => {
  const row = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', open_count: 12, hq: 'San Francisco' }

  it('offers a verified employer by exact name, says whether the person follows it, and reads no network', async () => {
    const s = setup({ directory: [row, { ...row, id: 'e2', name: 'Retell AI Labs', domain: 'retell-labs.com' }], tables: { companies: [{ id: 'c1', user_id: 'u1', employer_id: 'e1', domain: 'retellai.com', watching: true }] } })
    const r = await s.find('retell-ai')
    expect(found(r)).toEqual([expect.objectContaining({ name: 'Retell AI', foundBy: 'directory', employerId: 'e1', jobs: 12, city: 'San Francisco', following: true, provenBy: 'its site links the board' })])
    expect(s.events).toEqual([{ rung: 'directory', line: 'Checking the directory' }])
    expect(s.fetchBoard).not.toHaveBeenCalled()
    expect(s.wikidata).not.toHaveBeenCalled()
  })

  it('finds an employer by the first label of its domain', async () => {
    const s = setup({ directory: [row] })
    expect(found(await s.find('retellai'))[0]).toMatchObject({ employerId: 'e1', following: false })
  })

  it('offers a seed candidate that has not been checked, by its exact name, without checking it', async () => {
    const s = setup({ tables: { directory_candidates: [{ id: 'k1', name: 'Gusto', name_norm: 'gusto', domain: 'gusto.com', state: 'pending' }, { id: 'k2', name: 'Gusto Pay', name_norm: 'gusto pay', state: 'pending' }] } })
    expect(found(await s.find('Gusto'))).toEqual([expect.objectContaining({ candidateId: 'k1', name: 'Gusto', jobs: null, foundBy: 'directory' })])
    expect(s.fetchBoard).not.toHaveBeenCalled()
  })

  it('offers a big employer it has no row for from its curated careers address, and never probes boards for it', async () => {
    const s = setup({ boards: { 'workable:amazon': { identity: { name: 'Amazon', homeUrls: [] } } } })
    const r = await s.find('Amazon')
    expect(found(r)).toEqual([expect.objectContaining({ name: 'Amazon', domain: 'amazon.jobs', careersUrl: 'https://www.amazon.jobs/en/search', provenBy: 'its curated careers address' })])
    expect(s.fetchBoard).not.toHaveBeenCalled()
    expect(addByOf(found(r)[0])).toEqual({ site: expect.objectContaining({ domain: 'amazon.jobs', careersUrl: 'https://www.amazon.jobs/en/search' }) })
  })

  it('offers a big employer whose board was checked by hand as that board', async () => {
    const s = setup()
    const [c] = found(await s.find('Datadog'))
    expect(c).toMatchObject({ name: 'Datadog', provider: 'greenhouse', token: 'datadog', domain: 'datadog.com', provenBy: 'a board Cello checked by hand' })
    expect(s.fetchBoard).not.toHaveBeenCalled()
  })
})

describe('rung 2: job boards', () => {
  it('finds the board whose provider names the employer and declares its home, probing only providers with a safe probe', async () => {
    const s = setup({ boards: retell })
    const r = await s.find('Retell AI')
    expect(found(r)).toEqual([{ name: 'Retell AI', domain: 'retellai.com', provider: 'ashby', token: 'retell-ai', foundBy: 'board', provenBy: 'the board declares retellai.com as home', jobs: 2 }])
    expect(s.events.map((e) => e.rung)).toEqual(['directory', 'boards'])
    const asked = new Set(s.fetchBoard.mock.calls.map((c) => c[0]))
    expect([...asked].sort()).toEqual(['ashby', 'greenhouse', 'lever', 'recruitee', 'smartrecruiters', 'workable'])
    expect(s.fetchBoard.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['retellai', 'retell-ai']))
  })

  it('does not take a namesake: a board that names another employer, or names none, is not a candidate', async () => {
    const s = setup({
      boards: {
        'workable:retellai': { identity: { name: 'Retell Inc', homeUrls: [] } },
        'lever:retell-ai': { identity: { name: 'Retell Corp', homeUrls: ['https://retell.io'] } },
        'greenhouse:retellai': { identity: null },
      },
    })
    const r = await s.find('Retell AI')
    expect(found(r)).toEqual([])
    // it went on to the next rungs
    expect(s.events.map((e) => e.rung)).toEqual(['directory', 'boards', 'lookup', 'site', 'web'])
  })

  it('shows one employer once when two providers carry boards for it, and at most three employers', async () => {
    const home = (d: string) => ({ jobs: fresh, identity: { name: 'Retell AI', homeUrls: [`https://${d}`] } })
    const same = setup({ boards: { 'ashby:retell-ai': home('retellai.com'), 'lever:retellai': home('retellai.com') } })
    expect(found(await same.find('Retell AI'))).toHaveLength(1)
    const many = setup({
      boards: {
        'ashby:retell-ai': home('a.com'),
        'lever:retell-ai': home('b.com'),
        'workable:retell-ai': home('c.com'),
        'greenhouse:retell-ai': home('d.com'),
      },
    })
    const c = found(await many.find('Retell AI'))
    expect(c).toHaveLength(3)
    expect(new Set(c.map((x) => x.domain)).size).toBe(3)
  })
})

describe('rung 3: Wikidata', () => {
  it('proves the website Wikidata names through the board its site links, and carries the profile', async () => {
    const s = setup({ wikidata: [entity()], pages: { 'retellai.com': [{ provider: 'ashby', token: 'retell-ai' }] }, boards: retell })
    const r = await s.find('Retell')
    const [c] = found(r)
    expect(c).toMatchObject({ name: 'Retell AI', domain: 'retellai.com', provider: 'ashby', token: 'retell-ai', foundBy: 'wikidata', jobs: 2, city: 'San Francisco', provenBy: 'Wikidata names retellai.com; its site links the board' })
    expect(c.profile).toEqual(toProfile(entity()))
    expect(s.events.map((e) => e.rung)).toEqual(['directory', 'boards', 'lookup'])
    expect(addByOf(c)).toMatchObject({ board: { provider: 'ashby', token: 'retell-ai', domain: 'retellai.com', qid: 'Q1' } })
  })

  it('shows nothing for a website that proves nothing, and up to three employers when several are proven', async () => {
    const e = (qid: string, d: string) => entity({ qid, label: `Acme ${qid}`, website: `https://${d}/` })
    const s = setup({
      wikidata: [e('Q1', 'acme.com'), e('Q2', 'acme.org'), e('Q3', 'acme.io')],
      sites: { 'acme.com': fresh, 'acme.io': fresh },
    })
    const c = found(await s.find('Acme'))
    expect(c.map((x) => x.domain)).toEqual(['acme.com', 'acme.io'])
    expect(c[0]).toMatchObject({ careersUrl: 'https://acme.com/careers', provenBy: 'Wikidata names acme.com; roles listed on the site' })
  })

  it('goes on to the next rung when Wikidata does not answer', async () => {
    const s = setup({ sites: { 'acmelabs.io': fresh } })
    s.wikidata.mockRejectedValue(new Error('wikidata 503'))
    expect(found(await s.find('Acme Labs'))[0]).toMatchObject({ domain: 'acmelabs.io', foundBy: 'site' })
  })
})

describe('rung 4: the site by name', () => {
  it('tries the guessed addresses and shows only the one a board or its own roles prove', async () => {
    const s = setup({ pages: { 'acmelabs.io': [{ provider: 'ashby', token: 'acme-board' }] }, boards: { 'ashby:acme-board': { jobs: fresh, identity: { name: 'Acme Labs', homeUrls: ['https://acmelabs.io'] } } } })
    const c = found(await s.find('Acme Labs'))
    expect(c).toEqual([expect.objectContaining({ domain: 'acmelabs.io', foundBy: 'site', provider: 'ashby', token: 'acme-board', provenBy: 'its site links the board' })])
    const tried = s.pageBoards.mock.calls.map((x) => x[0].domain)
    expect(tried).toEqual(expect.arrayContaining(['acmelabs.com', 'acmelabs.io', 'acme-labs.co']))
  })

  it('shows a site that lists roles with no applicant system, and not one that lists none', async () => {
    const s = setup({ sites: { 'acme.ai': fresh } })
    const c = found(await s.find('Acme'))
    expect(c).toEqual([expect.objectContaining({ domain: 'acme.ai', careersUrl: 'https://acme.ai/careers', jobs: 2, provenBy: 'roles listed on the site' })])
    expect(c[0].provider).toBeUndefined()
  })

  it('guesses .com .ai .io .co, joined and hyphenated, and the last word as the suffix', () => {
    expect(guessDomains('Retell AI')).toEqual(expect.arrayContaining(['retell.ai', 'retellai.com', 'retellai.ai', 'retellai.io', 'retellai.co', 'retell-ai.com', 'retell-ai.co']))
    expect(guessDomains('Linear')).toEqual(['linear.com', 'linear.ai', 'linear.io', 'linear.co'])
    expect(guessDomains('!')).toEqual([])
  })
})

describe('rung 5: the web', () => {
  it('searches the web when a key is set and proves the domains it names', async () => {
    const s = setup({ web: ['retellai.com', 'news.example'], pages: { 'retellai.com': [{ provider: 'ashby', token: 'retell-ai' }] }, boards: retell })
    const c = found(await s.find('Obscure Name'))
    expect(c).toEqual([expect.objectContaining({ domain: 'retellai.com', foundBy: 'web' })])
    expect(s.queue).not.toHaveBeenCalled()
    expect(s.web).toHaveBeenCalledWith('Obscure Name')
  })

  it('without a key queues the search for the worker and says it is still searching', async () => {
    const s = setup({ web: null })
    const r = await s.find('Obscure Name')
    expect(r).toEqual({ none: true, queued: true, line: 'Cello is still searching the web for Obscure Name; it will appear on Companies when found.' })
    expect(s.queue).toHaveBeenCalledWith('Obscure Name')
  })

  it('says nothing was found, and to paste the link, when the web proves nothing either', async () => {
    const s = setup({ web: ['nothing.example'] })
    expect(await s.find('Obscure Name')).toEqual({ none: true, line: 'Cello could not find Obscure Name. Paste its careers link.' })
    expect(s.events.map((e) => e.line)).toEqual(['Checking the directory', 'Checking job boards', 'Looking it up', 'Trying its website', 'Searching the web'])
  })
})

describe('the search itself', () => {
  it('writes nothing about an employer, whichever rung finds it', async () => {
    for (const w of [
      { directory: [{ id: 'e1', name: 'Retell AI', domain: 'retellai.com' }] },
      { boards: retell },
      { wikidata: [entity()], pages: { 'retellai.com': [{ provider: 'ashby' as const, token: 'retell-ai' }] }, boards: retell },
      { sites: { 'acmelabs.io': fresh } },
      { web: null },
    ]) {
      const s = setup(w)
      await s.find('Retell AI')
      expect(writes(s.queries), JSON.stringify(Object.keys(w))).toEqual([])
    }
  })

  it('ends with what it has when the budget runs out, and does not wait for a rung that never answers', async () => {
    const s = setup({ timeoutMs: 30 })
    s.fetchBoard.mockImplementation(() => new Promise<AtsJob[]>(() => {}))
    const started = Date.now()
    const r = await s.find('Retell AI')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r).toMatchObject({ none: true })
    expect(s.events.map((e) => e.rung)).toEqual(['directory', 'boards'])
  })

  it('runs the rungs in order and stops at the first that finds an employer', async () => {
    const s = setup({ boards: retell, wikidata: [entity()] })
    await s.find('Retell AI')
    expect(s.events.map((e) => e.rung)).toEqual(['directory', 'boards'])
    expect(s.wikidata).not.toHaveBeenCalled()
  })
})

describe('realFindDeps.queue', () => {
  it('queues the search for the person who asked, and queues nothing for a demo account', async () => {
    const real = fakeDb({ profiles: [{ id: 'u1', is_demo: false, demo_expires_at: null }, { id: 'u2', is_demo: true, demo_expires_at: '2099-01-01T00:00:00Z' }] }, { autoId: ['render_jobs'] })
    expect(await realFindDeps(real.client, 'u1').queue('Retell AI')).toBeTruthy()
    expect(real.tables.render_jobs).toEqual([expect.objectContaining({ kind: 'web_search', query: 'Retell AI', requested_by: 'u1' })])
    expect(await realFindDeps(real.client, 'u2').queue('Retell AI')).toBeNull()
    expect(real.tables.render_jobs).toHaveLength(1)
  })
})

describe('findFromJob: the worker found the domains', () => {
  const addDeps = (s: ReturnType<typeof setup>): AddDeps => ({ verify: s.deps.verify, read: s.read as never, trace: async () => ({ employer: null, applyUrl: null }) })
  const jobRow = (over: Record<string, unknown> = {}) => ({ id: 'j1', kind: 'web_search', query: 'Retell AI', state: 'done', requested_by: 'u1', result: { domains: [{ domain: 'news.example', title: '' }, { domain: 'retellai.com', title: 'Retell AI careers' }] }, ...over })

  it('proves the domains in order and adds the first employer proven for the person who asked', async () => {
    const s = setup({ pages: { 'retellai.com': [{ provider: 'ashby', token: 'retell-ai' }] }, boards: retell, tables: { render_jobs: [jobRow()] } })
    expect(await findFromJob(s.client, 'j1', s.deps, addDeps(s))).toEqual({ added: true })
    expect(s.tables.company_directory).toEqual([expect.objectContaining({ domain: 'retellai.com', ats_provider: 'ashby', ats_token: 'retell-ai', source: 'person' })])
    expect(s.tables.companies[0]).toMatchObject({ user_id: 'u1', watching: true, employer_id: s.tables.company_directory[0].id })
  })

  it('adds nothing when no domain is proven, nobody asked, or the job is not a finished search', async () => {
    for (const row of [jobRow({ result: { domains: [{ domain: 'news.example', title: '' }] } }), jobRow({ requested_by: null }), jobRow({ state: 'failed' }), jobRow({ kind: 'careers_page' })]) {
      const s = setup({ pages: { 'retellai.com': [{ provider: 'ashby', token: 'retell-ai' }] }, boards: retell, tables: { render_jobs: [row] } })
      expect(await findFromJob(s.client, 'j1', s.deps, addDeps(s))).toEqual({ added: false })
      expect(s.tables.company_directory ?? []).toHaveLength(0)
    }
  })
})
