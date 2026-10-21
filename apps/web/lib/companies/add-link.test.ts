import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../ats/http'
import type { AtsJob } from '../ats/types'
import type { BoardIdentity, BoardRef } from '../ats/verify'
import type { SiteRead } from '../ingest/reader'
import { addCompany, DAILY_ADD_LIMIT, employerDomain, parseLink, type AddDeps, type AddStep } from './add-link'
import type { WikidataEntity } from './wikidata'
import { fakeDb } from './fake-db'
import { KNOWN_COMPANIES, lookupKnownCompanyByName, type KnownCompany } from './known-companies'

const NOW = Date.now()
const job = (daysAgo: number, i = 0): AtsJob => ({ title: `Engineer ${i}`, url: `https://boards.example/${i}`, externalId: `${i}`, postedAt: new Date(NOW - daysAgo * 86_400_000).toISOString() })
const fresh = [job(2, 1), job(9, 2)]

interface Setup {
  /** Boards the reader's plain tiers find, in order. */
  boards?: { provider: BoardRef['provider']; token: string; via: 'url' | 'link' | 'redirect' | 'posting' | 'eightfold' }[]
  jobs?: AtsJob[]
  identity?: BoardIdentity | null
  page?: BoardRef[]
  site?: Partial<SiteRead>
  trace?: { employer: string | null; applyUrl: string | null }
  wikidata?: WikidataEntity | null
}

function deps(s: Setup = {}) {
  const events: AddStep[] = []
  const read = vi.fn<Parameters<AddDeps['read']>, ReturnType<AddDeps['read']>>(async (_input, readBoard) => {
    for (const b of s.boards ?? []) {
      const board = await readBoard(b, [])
      if (board) return { tier: 'board', jobs: board.jobs, board, complete: false, reason: null, tried: [], checked: [], requests: 1 } as SiteRead
    }
    return { tier: null, jobs: [], complete: false, reason: 'no_roles', tried: [], checked: [], requests: 1, ...s.site } as SiteRead
  })
  const value: AddDeps = {
    verify: { now: () => NOW, fetchBoard: async () => s.jobs ?? fresh, identify: async () => s.identity ?? null, pageBoards: async () => s.page ?? [] },
    read,
    trace: async () => s.trace ?? { employer: null, applyUrl: null },
    wikidata: async () => s.wikidata ?? null,
    report: (step) => events.push(step),
  }
  return { value, read, events }
}

const profile = { id: 'u1', is_demo: false, demo_expires_at: null }
const retellRow = { id: 'e1', name: 'Retell AI', domain: 'retellai.com' }
const world = (tables: Record<string, Record<string, unknown>[]> = {}) =>
  fakeDb({ profiles: [profile], companies: [], ...tables }, { rpc: { search_company_directory: () => [retellRow] }, autoId: ['companies', 'company_directory', 'directory_candidates', 'render_jobs'] })
const writes = (queries: { op: string }[]) => queries.filter((q) => q.op !== 'select')

describe('parseLink: the first door', () => {
  it('reads an address with or without its scheme', () => {
    expect(parseLink('retellai.com/careers')?.href).toBe('https://retellai.com/careers')
    expect(parseLink(' https://jobs.ashbyhq.com/retell-ai ')?.hostname).toBe('jobs.ashbyhq.com')
    expect(employerDomain('careers.stripe.com')).toBe('stripe.com')
    expect(employerDomain('www.retellai.com')).toBe('retellai.com')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///etc/passwd',
    'ftp://acme.com/jobs',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3000/admin',
    'https://10.0.0.5/jobs',
    'https://[::1]/jobs',
    'https://printer.local/jobs',
    'https://user:pass@acme.com/careers',
    'https://xn--mazon-3ve.com/careers',
    'not a link',
    '',
  ])('refuses %s', (raw) => {
    expect(parseLink(raw)).toBeNull()
  })
})

describe('companies.add by link', () => {
  it('Retell AI: pasting retellai.com/careers verifies jobs.ashbyhq.com/retell-ai and follows the employer', async () => {
    const { client, tables } = world()
    const d = deps({
      boards: [{ provider: 'ashby', token: 'retell-ai', via: 'link' }],
      identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] },
      page: [{ provider: 'ashby', token: 'retell-ai' }],
    })
    const r = await addCompany(client, 'u1', { link: 'retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: true, already: false, employer: { name: 'Retell AI', domain: 'retellai.com', openCount: 2 } })
    expect(tables.company_directory).toHaveLength(1)
    expect(tables.company_directory[0]).toMatchObject({ ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', source: 'person' })
    expect(tables.companies).toHaveLength(1)
    expect(tables.companies[0]).toMatchObject({ user_id: 'u1', name: 'Retell AI', employer_id: tables.company_directory[0].id, watching: true })
    expect((tables.companies[0].metadata as { ats: { provider: string; token: string } }).ats).toMatchObject({ provider: 'ashby', token: 'retell-ai' })
  })

  it('a careers page that links another employer board is other_owner and offers the employer the directory has', async () => {
    const { client, tables, queries } = world()
    const d = deps({ boards: [{ provider: 'workable', token: 'retell', via: 'link' }], identity: { name: 'Retell Inc', homeUrls: ['https://retell.io'] }, page: [{ provider: 'workable', token: 'retell' }] })
    const r = await addCompany(client, 'u1', { link: 'https://retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI', employerId: 'e1' }] })
    expect(writes(queries)).toEqual([])
    expect(tables.company_directory ?? []).toHaveLength(0)
  })

  it('a pasted board of a big employer name on a provider that keeps no owner record is refused, not taken on its slug', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'personio', token: 'amazon', via: 'url' }], identity: null })
    const r = await addCompany(client, 'u1', { link: 'https://amazon.jobs.personio.de/' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory ?? []).toHaveLength(0)
  })

  it('a dead board under a big employer name is a namesake\'s: other_owner, not stale', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'personio', token: 'amazon', via: 'url' }], jobs: [job(2000)], identity: null })
    expect(await addCompany(client, 'u1', { link: 'https://amazon.jobs.personio.de/' }, d.value)).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory ?? []).toHaveLength(0)
    // an unknown name keeps the plain reason
    const quiet = deps({ boards: [{ provider: 'personio', token: 'tiny-co', via: 'url' }], jobs: [job(2000)], identity: null })
    expect(await addCompany(world().client, 'u1', { link: 'https://tiny-co.jobs.personio.de/' }, quiet.value)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('a Workday board is named for its tenant, not its compound token', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'workday', token: 'pfizer.wd1.PfizerCareers', via: 'url' }], identity: null })
    expect(await addCompany(client, 'u1', { link: 'https://pfizer.wd1.myworkdayjobs.com/PfizerCareers' }, d.value)).toMatchObject({ ok: true, employer: { name: 'Pfizer' } })
    expect(tables.company_directory[0]).toMatchObject({ ats_provider: 'workday', verified_by: 'careers_url' })
  })

  it('a pasted Workable board named like a verified employer is other_owner, offers that employer, and writes nothing', async () => {
    const real = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', logo_url: null, careers_url: 'https://retellai.com/careers', ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 12, source: 'person' }
    const { client, tables } = world({ company_directory: [{ ...real }] })
    const d = deps({ boards: [{ provider: 'workable', token: 'squat', via: 'url' }], identity: { name: 'Retell AI', homeUrls: [] } })
    const r = await addCompany(client, 'u1', { link: 'https://apply.workable.com/squat' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI', employerId: 'e1' }] })
    expect(tables.company_directory).toEqual([real])
    expect(tables.companies).toHaveLength(0)
  })

  it('a pasted board no one big has the name of is taken on the person say-so while it is alive', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'personio', token: 'tiny-co', via: 'url' }], identity: null })
    const r = await addCompany(client, 'u1', { link: 'https://tiny-co.jobs.personio.de/' }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { name: 'Tiny Co' } })
    expect(tables.company_directory[0]).toMatchObject({ verified_by: 'careers_url', ats_provider: 'personio', ats_token: 'tiny-co' })
  })

  it('a pasted page that links a verified employer board changes nothing in that employer row', async () => {
    const real = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', logo_url: null, careers_url: 'https://retellai.com/careers', ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 12, source: 'person' }
    const { client, tables } = world({ company_directory: [{ ...real }] })
    const d = deps({ boards: [{ provider: 'ashby', token: 'retell-ai', via: 'link' }], identity: null, page: [{ provider: 'ashby', token: 'retell-ai' }] })
    const r = await addCompany(client, 'u1', { link: 'https://evil-site.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { employerId: 'e1' } })
    expect(tables.company_directory).toEqual([real])
  })

  it('a board whose newest posting is 200 days old is stale', async () => {
    const { client } = world()
    const d = deps({ boards: [{ provider: 'greenhouse', token: 'acme', via: 'link' }], jobs: [job(200)], identity: { name: 'Acme', homeUrls: ['https://acme.com'] } })
    expect(await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, d.value)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('a LinkedIn link is a job site: not_employer_site, with the employer and its own posting offered', async () => {
    const { client, queries } = world()
    const d = deps({ trace: { employer: 'Retell AI', applyUrl: 'https://retellai.com/careers/123' } })
    const r = await addCompany(client, 'u1', { link: 'https://www.linkedin.com/jobs/view/3912345' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'not_employer_site' })
    if (!r.ok) expect(r.offers).toEqual([{ kind: 'employer', name: 'Retell AI', domain: 'retellai.com', employerId: 'e1' }, { kind: 'posting', name: 'Retell AI', url: 'https://retellai.com/careers/123' }])
    expect(d.read).not.toHaveBeenCalled()
    expect(writes(queries)).toEqual([])
  })

  it('a page with no board and no roles is no_board; one the site would not answer is cannot_read', async () => {
    const { client } = world()
    expect(await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, deps({ site: { reason: 'no_roles' } }).value)).toMatchObject({ ok: false, reason: 'no_board' })
    expect(await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, deps({ site: { reason: 'bot_check' } }).value)).toMatchObject({ ok: false, reason: 'cannot_read' })
  })

  it('a site with no board but roles the reader could read is tied to the employer by the address it was read at', async () => {
    const { client, tables } = world()
    const d = deps({ site: { tier: 'listing', jobs: fresh, complete: true, reason: null } })
    const r = await addCompany(client, 'u1', { link: 'https://careers.acme.com/jobs' }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { domain: 'acme.com', openCount: 2 } })
    expect(tables.company_directory[0]).toMatchObject({ verified_by: 'careers_url_host', ats_provider: null, read_tier: 'listing' })
  })

  it('an employer already followed is shown, with no check and no write', async () => {
    const { client, queries } = world({ companies: [{ id: 'co1', user_id: 'u1', name: 'Retell AI', domain: 'retellai.com', watching: true, employer_id: 'e1', logo_url: null }] })
    const d = deps()
    const r = await addCompany(client, 'u1', { link: 'https://retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: true, already: true, companyId: 'co1' })
    expect(d.read).not.toHaveBeenCalled()
    expect(writes(queries)).toEqual([])
  })

  it('a demo account is refused with its line and nothing is read or written', async () => {
    const { client, queries } = fakeDb({ profiles: [{ id: 'u1', is_demo: true, demo_expires_at: '2099-01-01T00:00:00Z' }], companies: [] })
    const d = deps()
    const r = await addCompany(client, 'u1', { link: 'https://retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'demo', line: 'Demo accounts cannot add employers.' })
    expect(d.read).not.toHaveBeenCalled()
    expect(writes(queries)).toEqual([])
  })

  it('the 31st add in a day shows the limit line, and the 30th still goes through', async () => {
    const today = new Date().toISOString()
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, user_id: 'u1', name: `Co ${i}`, domain: `co${i}.com`, watching: true, created_at: today }))
    const setup = { boards: [{ provider: 'ashby' as const, token: 'retell-ai', via: 'link' as const }], identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] }, page: [{ provider: 'ashby' as const, token: 'retell-ai' }] }
    const ok = world({ companies: rows(DAILY_ADD_LIMIT - 1) })
    expect(await addCompany(ok.client, 'u1', { link: 'retellai.com/careers' }, deps(setup).value)).toMatchObject({ ok: true })
    const over = world({ companies: rows(DAILY_ADD_LIMIT) })
    const d = deps(setup)
    const r = await addCompany(over.client, 'u1', { link: 'retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'daily_limit', line: `You have added ${DAILY_ADD_LIMIT} employers today. Try again tomorrow.` })
    expect(d.read).not.toHaveBeenCalled()
    expect(writes(over.queries)).toEqual([])
  })

  it('an unreadable link is bad_link before anything is read', async () => {
    const { client, queries } = world()
    const d = deps()
    for (const link of ['javascript:alert(1)', 'http://169.254.169.254/', 'https://xn--mazon-3ve.com/careers']) {
      expect(await addCompany(client, 'u1', { link }, d.value)).toMatchObject({ ok: false, reason: 'bad_link' })
    }
    expect(d.read).not.toHaveBeenCalled()
    expect(writes(queries)).toEqual([])
  })
})

describe('companies.add by directory id and by candidate', () => {
  const verified = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', logo_url: null, careers_url: 'https://retellai.com/careers', ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 12 }

  it('a verified employer is followed with no new check', async () => {
    const { client, tables } = world({ company_directory: [verified] })
    const d = deps()
    const r = await addCompany(client, 'u1', { employerId: 'e1' }, d.value)
    expect(r).toMatchObject({ ok: true, already: false, employer: { employerId: 'e1', openCount: 12 } })
    expect(tables.companies[0]).toMatchObject({ employer_id: 'e1', watching: true })
    expect(d.read).not.toHaveBeenCalled()
  })

  it('an id the directory has not verified is not found', async () => {
    const { client } = world({ company_directory: [{ ...verified, verified_at: null }] })
    expect(await addCompany(client, 'u1', { employerId: 'e1' }, deps().value)).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('choosing a candidate verifies it at once; a failed one is marked and offers what the directory has', async () => {
    const cand = { id: 'c1', name: 'Retell AI', domain: 'retellai.com', ats_provider: 'workable', ats_token: 'retell', source: 'kalil', failed_reads: 0, state: 'pending', employer_id: null }
    const { client, tables } = world({ directory_candidates: [cand] })
    const d = deps({ identity: { name: 'Retell Inc', homeUrls: ['https://retell.io'] } })
    const r = await addCompany(client, 'u1', { candidateId: 'c1' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI' }] })
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'failed', fail_reason: 'other_owner' })
    expect(tables.companies).toHaveLength(0)
  })

  it('a person choosing a candidate whose board does not answer never fails it: three checks leave it pending and read the board once', async () => {
    const cand = { id: 'c1', name: 'Gusto', domain: null, ats_provider: 'greenhouse', ats_token: 'gusto', source: 'kalil', failed_reads: 0, state: 'pending', employer_id: null }
    const { client, tables } = world({ directory_candidates: [cand] })
    const d = deps()
    const fetchBoard = vi.fn(async (): Promise<AtsJob[]> => { throw new HttpError('down', 503) })
    d.value.verify.fetchBoard = fetchBoard
    for (let i = 0; i < 3; i++) expect(await addCompany(client, 'u1', { candidateId: 'c1' }, d.value)).toMatchObject({ ok: false, reason: 'cannot_read' })
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'pending', failed_reads: 0 })
    expect(fetchBoard).toHaveBeenCalledTimes(1)
  })

  it('choosing a candidate that passes writes the employer and follows it', async () => {
    const cand = { id: 'c1', name: 'Gusto', domain: null, ats_provider: 'greenhouse', ats_token: 'gusto', source: 'kalil', failed_reads: 0, state: 'pending', employer_id: null }
    const { client, tables } = world({ directory_candidates: [cand] })
    const d = deps({ identity: { name: 'Gusto', homeUrls: [] } })
    const r = await addCompany(client, 'u1', { candidateId: 'c1' }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { name: 'Gusto' } })
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'verified' })
    expect(tables.companies[0]).toMatchObject({ user_id: 'u1', watching: true })
  })
})

const verifiedRetell = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', logo_url: null, careers_url: 'https://retellai.com/careers', ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', verified_at: '2026-10-01T00:00:00Z', open_count: 12, source: 'person' }

describe('the stages of a link, as they happen', () => {
  it('Retell AI: reading, the board found, the roles counted, the owner checked, in the order they happen', async () => {
    const { client } = world()
    const d = deps({ boards: [{ provider: 'ashby', token: 'retell-ai', via: 'link' }], identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] }, page: [{ provider: 'ashby', token: 'retell-ai' }] })
    await addCompany(client, 'u1', { link: 'retellai.com/careers' }, d.value)
    expect(d.events.map((e) => e.line)).toEqual(['Reading retellai.com', 'Found an Ashby board', 'Reading the board, 2 postings so far', "Checking it is Retell AI's"])
    expect(d.events.map((e) => e.step)).toEqual(['reading', 'board_found', 'reading_roles', 'checking_owner'])
    expect(d.events[1]).toMatchObject({ provider: 'ashby' })
    expect(d.events[2]).toMatchObject({ count: 2 })
  })

  it('a site that lists roles with no board says so', async () => {
    const { client } = world()
    const d = deps({ site: { tier: 'listing', jobs: fresh, complete: true, reason: null } })
    await addCompany(client, 'u1', { link: 'https://careers.acme.com/jobs' }, d.value)
    expect(d.events.map((e) => e.line)).toEqual(['Reading careers.acme.com', 'Found roles on the page itself'])
  })

  it('an employer already in the directory is shown at once, before anything is fetched, and followed', async () => {
    const { client, tables } = world({ company_directory: [{ ...verifiedRetell }] })
    const d = deps({ boards: [{ provider: 'ashby', token: 'retell-ai', via: 'link' }] })
    const fetchBoard = vi.fn(async (): Promise<AtsJob[]> => fresh)
    d.value.verify.fetchBoard = fetchBoard
    const r = await addCompany(client, 'u1', { link: 'https://www.retellai.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: true, already: false, employer: { employerId: 'e1' } })
    expect(d.events).toEqual([{ step: 'directory_hit', following: false, line: 'In the directory, not on your page yet' }])
    expect(d.read).not.toHaveBeenCalled()
    expect(fetchBoard).not.toHaveBeenCalled()
    expect(tables.companies[0]).toMatchObject({ employer_id: 'e1', watching: true })
    // and a board's own address finds the row the same way
    const again = world({ company_directory: [{ ...verifiedRetell }] })
    const e2 = deps()
    await addCompany(again.client, 'u1', { link: 'https://jobs.ashbyhq.com/retell-ai' }, e2.value)
    expect(e2.events).toEqual([{ step: 'directory_hit', following: false, line: 'In the directory, not on your page yet' }])
    expect(e2.read).not.toHaveBeenCalled()
  })

  it('says "You follow this already" for an employer the person follows', async () => {
    const { client } = world({ company_directory: [{ ...verifiedRetell }], companies: [{ id: 'co1', user_id: 'u1', name: 'Retell AI', domain: 'retellai.com', watching: true, employer_id: 'e1', logo_url: null }] })
    const d = deps()
    await addCompany(client, 'u1', { link: 'https://retellai.com/careers' }, d.value)
    expect(d.events).toEqual([{ step: 'directory_hit', following: true, line: 'You follow this already' }])
  })
})

describe('a board checked by hand', () => {
  it.each([
    ['https://www.datadoghq.com/careers', 'greenhouse', 'datadog', 'Datadog', 'datadoghq.com'],
    ['https://ramp.com/careers', 'ashby', 'ramp', 'Ramp', 'ramp.com'],
  ])('%s is accepted as known_board even though its page links no board, and the page is not read', async (link, provider, token, name, domain) => {
    const { client, tables } = world()
    const d = deps({ identity: null })
    const r = await addCompany(client, 'u1', { link }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { name, domain, openCount: 2 } })
    expect(tables.company_directory[0]).toMatchObject({ verified_by: 'known_board', ats_provider: provider, ats_token: token, source: 'person', domain })
    expect(d.read).not.toHaveBeenCalled()
  })

  it('a known board that has gone quiet is not accepted on the strength of the list alone', async () => {
    const { client, tables } = world()
    const d = deps({ jobs: [job(300)] })
    const r = await addCompany(client, 'u1', { link: 'https://www.datadoghq.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: false })
    expect(tables.company_directory ?? []).toHaveLength(0)
  })

  it('Amazon on Personio is still another employer, with the curated domain given', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'personio', token: 'amazon', via: 'url' }], identity: null })
    expect(await addCompany(client, 'u1', { link: 'https://amazon.jobs.personio.de/' }, d.value)).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory ?? []).toHaveLength(0)
  })
})

describe('a page only a browser can read', () => {
  it('a bot check on the employer\'s own address is queued for the worker: a candidate, a job for this person, and the line', async () => {
    const { client, tables } = world()
    const d = deps({ site: { reason: 'bot_check' } })
    const r = await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'cannot_read', queued: 'Cello could not read that page: the site asked for a bot check. Trying with a browser within the hour.' })
    expect(tables.directory_candidates).toEqual([expect.objectContaining({ name: 'Acme', domain: 'acme.com', source: 'person' })])
    expect(tables.render_jobs).toEqual([expect.objectContaining({ kind: 'careers_page', url: 'https://acme.com/careers', candidate_id: tables.directory_candidates[0].id, requested_by: 'u1' })])
    expect(tables.company_directory ?? []).toHaveLength(0)
    expect(tables.companies).toHaveLength(0)
    // pasting it again queues nothing new (the database defaults a new job to queued)
    tables.render_jobs[0].state = 'queued'
    await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, d.value)
    expect(tables.directory_candidates).toHaveLength(1)
    expect(tables.render_jobs).toHaveLength(1)
  })

  it('a page that lists roles only to a browser is queued too; a site that did not answer, a login and robots are not', async () => {
    const { client, tables } = world()
    await addCompany(client, 'u1', { link: 'https://acme.com/careers' }, deps({ site: { reason: 'role_pages' } }).value)
    expect(tables.render_jobs).toHaveLength(1)
    for (const reason of ['unreachable', 'login_required', 'robots'] as const) {
      const r = await addCompany(client, 'u1', { link: `https://${reason.replace('_', '')}.example/careers` }, deps({ site: { reason } }).value)
      expect(r).toMatchObject({ ok: false, reason: 'cannot_read' })
      expect((r as { queued?: string }).queued).toBeUndefined()
    }
    expect(tables.render_jobs).toHaveLength(1)
  })
})

describe('a board or a site a search proved', () => {
  const retellBoard = { provider: 'ashby' as const, token: 'retell-ai', name: 'Retell AI', domain: 'retellai.com' }
  const setup = { identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] }, page: [{ provider: 'ashby' as const, token: 'retell-ai' }] }
  const entity: WikidataEntity = { qid: 'Q1', label: 'Retell AI', website: 'https://www.retellai.com/', hq: 'San Francisco', employees: 75, industry: null, logo: null, founded: 2023, ticker: null, github: null, fetchedAt: '2026-10-21T00:00:00.000Z' }

  it('proves the board again, writes the employer as the person\'s add, follows it and keeps the Wikidata profile', async () => {
    const { client, tables } = world()
    const d = deps({ ...setup, wikidata: entity })
    const r = await addCompany(client, 'u1', { board: { ...retellBoard, qid: 'Q1' } }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { name: 'Retell AI', domain: 'retellai.com', openCount: 2 } })
    expect(tables.company_directory[0]).toMatchObject({ ats_provider: 'ashby', ats_token: 'retell-ai', verified_by: 'careers_page_link', source: 'person', profile: expect.objectContaining({ source: 'wikidata', qid: 'Q1', hq: 'San Francisco' }) })
    expect(tables.companies[0]).toMatchObject({ user_id: 'u1', watching: true, employer_id: tables.company_directory[0].id })
    expect(d.events.map((e) => e.step)).toEqual(['board_found', 'reading_roles', 'checking_owner'])
  })

  it('takes nothing a client sent on trust: a forged domain, a name that is not the board\'s and a profile for another site all fail', async () => {
    const forged = world()
    expect(await addCompany(forged.client, 'u1', { board: { ...retellBoard, domain: 'evil.example' } }, deps(setup).value)).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(forged.tables.company_directory ?? []).toHaveLength(0)

    const renamed = world()
    expect(await addCompany(renamed.client, 'u1', { board: { ...retellBoard, domain: null, name: 'Amazon' } }, deps({ identity: { name: 'Retell AI', homeUrls: [] } }).value)).toMatchObject({ ok: false, reason: 'not_linked' })
    expect(renamed.tables.company_directory ?? []).toHaveLength(0)

    const other = world()
    const r = await addCompany(other.client, 'u1', { board: { ...retellBoard, qid: 'Q1' } }, deps({ ...setup, wikidata: { ...entity, website: 'https://other.example' } }).value)
    expect(r).toMatchObject({ ok: true })
    expect(other.tables.company_directory[0].profile).toBeUndefined()
  })

  it('a board the directory already has is shown without a check', async () => {
    const { client } = world({ company_directory: [{ ...verifiedRetell }] })
    const d = deps(setup)
    d.value.verify.fetchBoard = vi.fn(async (): Promise<AtsJob[]> => fresh)
    expect(await addCompany(client, 'u1', { board: retellBoard }, d.value)).toMatchObject({ ok: true, employer: { employerId: 'e1' } })
    expect(d.value.verify.fetchBoard).not.toHaveBeenCalled()
    expect(d.events[0]).toMatchObject({ step: 'directory_hit' })
  })

  it('a site that lists roles is read at its own address and written as the person\'s add; an address on another domain is refused', async () => {
    const { client, tables } = world()
    const d = deps({ site: { tier: 'listing', jobs: fresh, complete: true, reason: null } })
    const r = await addCompany(client, 'u1', { site: { domain: 'acme.com', careersUrl: 'https://acme.com/careers', name: 'Acme Labs' } }, d.value)
    expect(r).toMatchObject({ ok: true, employer: { name: 'Acme Labs', domain: 'acme.com', openCount: 2 } })
    expect(tables.company_directory[0]).toMatchObject({ verified_by: 'careers_url_host', careers_url: 'https://acme.com/careers', ats_provider: null })
    expect(await addCompany(world().client, 'u1', { site: { domain: 'acme.com', careersUrl: 'https://evil.example/careers' } }, deps().value)).toMatchObject({ ok: false, reason: 'bad_link' })
  })

  it('counts against the day\'s limit like any add', async () => {
    const today = new Date().toISOString()
    const rows = Array.from({ length: DAILY_ADD_LIMIT }, (_, i) => ({ id: `c${i}`, user_id: 'u1', name: `Co ${i}`, domain: `co${i}.com`, watching: true, created_at: today }))
    const { client } = world({ companies: rows })
    const d = deps(setup)
    expect(await addCompany(client, 'u1', { board: retellBoard }, d.value)).toMatchObject({ ok: false, reason: 'daily_limit' })
  })
})

describe('a pasted board of a curated employer', () => {
  const addressOf: Record<string, (token: string) => string> = {
    greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
    ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
    lever: (t) => `https://jobs.lever.co/${t}`,
    smartrecruiters: (t) => `https://jobs.smartrecruiters.com/${t}`,
  }
  const withBoard = Object.entries(KNOWN_COMPANIES).filter(([, k]) => k.board && addressOf[k.board.provider])

  it('is the curated employer\'s own when the provider names it and declares no other home: every curated board', async () => {
    expect(withBoard.length).toBeGreaterThan(50)
    for (const [, k] of withBoard) {
      // a name with two curated domains (Datadog) is written under the one the name lookup gives
      const domain = lookupKnownCompanyByName(k.name)?.domain
      const { client, tables } = world()
      const board = k.board as NonNullable<KnownCompany['board']>
      const d = deps({ boards: [{ provider: board.provider, token: board.token, via: 'url' }], identity: { name: k.name, homeUrls: [] } })
      const r = await addCompany(client, 'u1', { link: addressOf[board.provider](board.token) }, d.value)
      expect(r, `${k.name} ${board.provider}:${board.token}`).toMatchObject({ ok: true, employer: { name: k.name, domain } })
      expect(tables.company_directory[0]).toMatchObject({ domain, ats_provider: board.provider, ats_token: board.token })
    }
  })

  it('is refused when the board declares a home that is not the curated employer\'s', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'greenhouse', token: 'anthropic', via: 'url' }], identity: { name: 'Anthropic', homeUrls: ['https://anthropic-careers.example'] } })
    const r = await addCompany(client, 'u1', { link: 'https://boards.greenhouse.io/anthropic' }, d.value)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory ?? []).toHaveLength(0)
  })

  it('does not take a board for a curated employer when the provider names someone else', async () => {
    const { client, tables } = world()
    const d = deps({ boards: [{ provider: 'greenhouse', token: 'stripe', via: 'url' }], identity: { name: 'Stripe Fan Club', homeUrls: [] } })
    const r = await addCompany(client, 'u1', { link: 'https://boards.greenhouse.io/stripe' }, d.value)
    expect(r.ok ? tables.company_directory[0].domain : 'refused').not.toBe('stripe.com')
  })
})
