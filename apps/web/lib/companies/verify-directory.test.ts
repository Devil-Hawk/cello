import { describe, expect, it } from 'vitest'
import { HttpError } from '../ats/http'
import type { AtsJob } from '../ats/types'
import type { BoardIdentity, BoardRef } from '../ats/verify'
import { fakeDb } from './fake-db'
import { checkBoard, declaredDomain, settleCandidate, verifyEmployer, writeEmployer, type CandidateRow, type VerifyDeps } from './verify-directory'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const DAY = 86_400_000
const job = (daysAgo: number, i = 0): AtsJob => ({ title: `Engineer ${i}`, url: `https://boards.example/${i}`, externalId: `${i}`, postedAt: new Date(NOW - daysAgo * DAY).toISOString() })
const fresh = [job(3, 1), job(10, 2)]

interface World {
  jobs?: AtsJob[] | Error
  identity?: BoardIdentity | null | Error
  page?: BoardRef[]
}

const world = (w: World = {}): VerifyDeps => ({
  now: () => NOW,
  fetchBoard: async () => {
    if (w.jobs instanceof Error) throw w.jobs
    return w.jobs ?? fresh
  },
  identify: async () => {
    if (w.identity instanceof Error) throw w.identity
    return w.identity ?? null
  },
  pageBoards: async () => w.page ?? [],
})

describe('declaredDomain', () => {
  it('is the home the board names, never the applicant system own host', () => {
    expect(declaredDomain({ name: 'x', homeUrls: ['https://jobs.lever.co/x', 'https://www.retellai.com/'] })).toBe('retellai.com')
    expect(declaredDomain({ name: 'x', homeUrls: ['https://jobs.lever.co/x'] })).toBeNull()
  })
})

describe('checkBoard: the employer a board belongs to', () => {
  it('Retell AI: its careers page links jobs.ashbyhq.com/retell-ai, so the board is theirs', async () => {
    const r = await checkBoard(
      { name: 'Retell AI', domain: 'retellai.com', careerUrl: 'https://retellai.com/careers', provider: 'ashby', token: 'retell-ai' },
      world({ identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] }, page: [{ provider: 'ashby', token: 'retell-ai' }] })
    )
    expect(r).toMatchObject({ ok: true, verifiedBy: 'careers_page_link', name: 'Retell AI', domain: 'retellai.com' })
  })

  it('the "retellai" guess on Workable is refused: the board declares another employer home', async () => {
    const r = await checkBoard(
      { name: 'Retell AI', domain: 'retellai.com', provider: 'workable', token: 'retellai' },
      world({ identity: { name: 'Retell Staffing', homeUrls: ['https://retellstaffing.com'] } })
    )
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it('a board with another name and no home is another employer, not a match by slug', async () => {
    const r = await checkBoard({ name: 'Retell AI', domain: 'retellai.com', provider: 'workable', token: 'retell' }, world({ identity: { name: 'Retell Capital', homeUrls: [] } }))
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it('"amazon" on Personio is refused: a known employer is only tied by its own site', async () => {
    const r = await checkBoard({ name: 'Amazon', domain: 'amazon.com', provider: 'personio', token: 'amazon' }, world())
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it('a seed row with no domain on a provider that names no owner is not linked', async () => {
    const r = await checkBoard({ name: 'amazon', domain: null, provider: 'personio', token: 'amazon' }, world())
    expect(r).toMatchObject({ ok: false, reason: 'not_linked' })
  })

  it('a board whose newest posting is 200 days old is stale, and so is one with no dates', async () => {
    const stale = await checkBoard({ name: 'Acme', domain: 'acme.com', provider: 'greenhouse', token: 'acme' }, world({ jobs: [job(200)] }))
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    const undated = await checkBoard({ name: 'Acme', domain: 'acme.com', provider: 'greenhouse', token: 'acme' }, world({ jobs: [{ title: 'x', url: 'https://a.example/1', externalId: '1' }] }))
    expect(undated).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('a careers page that links the boards of two employers: the provider name decides which is this one', async () => {
    const r = await checkBoard(
      { name: 'Acme', domain: 'acme.com', provider: 'greenhouse', token: 'acmebuyer' },
      world({ identity: { name: 'Acme Buyer Holdings', homeUrls: [] }, page: [{ provider: 'greenhouse', token: 'acme' }, { provider: 'greenhouse', token: 'acmebuyer' }] })
    )
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it.each(['Amazon', 'Mercury', 'Ramp', 'Notion', 'Linear', 'Scale', 'Square', 'Block', 'Unity'])('%s: a namesake board with the same name and another home is refused', async (name) => {
    const r = await checkBoard(
      { name, domain: `${name.toLowerCase()}.com`, provider: 'greenhouse', token: name.toLowerCase() },
      world({ identity: { name, homeUrls: ['https://namesake.example'] } })
    )
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it('a board page that names the employer only in its title is not theirs: the name alone never ties a board', async () => {
    const r = await checkBoard(
      { name: 'Acme', domain: 'acme.com', provider: 'lever', token: 'acme-staffing' },
      world({ identity: { name: 'Acme', homeUrls: [] } })
    )
    expect(r).toMatchObject({ ok: false, reason: 'not_linked' })
  })

  it('a look-alike domain does not take the real employer board: the board declares its own home', async () => {
    const r = await checkBoard(
      { name: 'Amazon', domain: 'xn--mazon-3ve.com', provider: 'ashby', token: 'amazon' },
      world({ identity: { name: 'Amazon', homeUrls: ['https://amazon.com'] }, page: [{ provider: 'ashby', token: 'amazon' }] })
    )
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })

  it('a board that is gone is no_board, one that does not answer is cannot_read', async () => {
    const input = { name: 'Acme', domain: 'acme.com', provider: 'greenhouse' as const, token: 'acme' }
    expect(await checkBoard(input, world({ jobs: new HttpError('gone', 404) }))).toMatchObject({ ok: false, reason: 'no_board' })
    expect(await checkBoard(input, world({ jobs: new HttpError('down', 503) }))).toMatchObject({ ok: false, reason: 'cannot_read' })
    expect(await checkBoard(input, world({ identity: new HttpError('down', 503) }))).toMatchObject({ ok: false, reason: 'cannot_read' })
  })

  it('a seed row passes on the provider own name; a pasted board with no name is named by its provider', async () => {
    const seed = await checkBoard({ name: 'Gusto', domain: null, provider: 'greenhouse', token: 'gusto' }, world({ identity: { name: 'Gusto, Inc.', homeUrls: [] } }))
    expect(seed).toMatchObject({ ok: true, verifiedBy: 'seed_checked', name: 'Gusto, Inc.' })
    const pasted = await checkBoard({ name: null, domain: null, provider: 'greenhouse', token: 'gusto' }, world({ identity: { name: 'Gusto, Inc.', homeUrls: [] } }))
    expect(pasted).toMatchObject({ ok: true, verifiedBy: 'provider_name', name: 'Gusto, Inc.' })
  })
})

const idOf = async (p: ReturnType<typeof writeEmployer>) => {
  const r = await p
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r.employerId
}

describe('writeEmployer: the one writer of company_directory', () => {
  const base = { name: 'Retell AI', careersUrl: null, provider: 'ashby' as const, token: 'retell-ai', verifiedBy: 'careers_page_link', source: 'person' as const, openCount: 12, readTier: 'board' }

  it('writes a row once by board and keeps what the row knew when a later check knows less', async () => {
    const { client, tables } = fakeDb()
    const id = await idOf(writeEmployer(client, { ...base, domain: 'retellai.com' }, () => NOW))
    const again = await idOf(writeEmployer(client, { ...base, domain: null, openCount: 14 }, () => NOW))
    expect(again).toBe(id)
    expect(tables.company_directory).toHaveLength(1)
    expect(tables.company_directory[0]).toMatchObject({ name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', open_count: 14, verified_by: 'careers_page_link', ats_provider: 'ashby' })
  })

  it('does not relabel a person add as the seed', async () => {
    const { client, tables } = fakeDb({ company_directory: [{ id: 'e1', source: 'person', ats_provider: 'ashby', ats_token: 'retell-ai', domain: 'retellai.com' }] })
    await writeEmployer(client, { ...base, domain: 'retellai.com', source: 'seed' }, () => NOW)
    expect(tables.company_directory[0].source).toBe('person')
  })

  it('a board whose declared home is a verified employer\'s domain leaves that row\'s board, owner and address alone', async () => {
    const real = { id: 'e1', source: 'person', domain: 'retellai.com', ats_provider: 'greenhouse', ats_token: 'real', verified_by: 'careers_page_link', careers_url: 'https://retellai.com/jobs' }
    const { client, tables } = fakeDb({ company_directory: [{ ...real }] })
    const id = await idOf(writeEmployer(client, { ...base, domain: 'retellai.com', careersUrl: 'https://evil.example/jobs', verifiedBy: 'careers_url' }, () => NOW))
    expect(id).toBe('e1')
    expect(tables.company_directory).toEqual([real])
    // a site-only check never nulls the board either
    await writeEmployer(client, { ...base, domain: 'retellai.com', provider: null, token: null, careersUrl: 'https://evil.example/jobs' }, () => NOW)
    expect(tables.company_directory).toEqual([real])
  })

  it('a person or a lead leaves a row that is there exactly as it is: found by board, by domain with a board, or by domain site-only', async () => {
    const real = { id: 'e1', source: 'person', name: 'Retell AI', domain: 'retellai.com', ats_provider: 'greenhouse', ats_token: 'real', verified_by: 'careers_page_link', careers_url: 'https://retellai.com/jobs' }
    const siteOnly = { id: 'e2', source: 'person', name: 'Acme', domain: 'acme.com', ats_provider: null, ats_token: null, verified_by: 'careers_url_host', careers_url: 'https://acme.com/jobs' }
    const { client, tables } = fakeDb({ company_directory: [{ ...real }, { ...siteOnly }] })
    // a pasted page the person controls that links the verified board
    const hit = await idOf(writeEmployer(client, { ...base, name: 'Evil', domain: 'evil.example', careersUrl: 'https://evil.example/jobs', provider: 'greenhouse', token: 'real', verifiedBy: 'careers_page_link', keepExisting: true }, () => NOW))
    expect(hit).toBe('e1')
    // a lead whose companyDomain is the site-only employer's, with a board of its own
    const lead = await idOf(writeEmployer(client, { ...base, domain: 'acme.com', provider: 'ashby', token: 'attacker', keepExisting: true, source: 'lead' }, () => NOW))
    expect(lead).toBe('e2')
    expect(tables.company_directory).toEqual([real, siteOnly])
  })
})

describe('a person or a lead never writes an employer under a name another employer holds', () => {
  const notion = { id: 'e1', source: 'seed', name: 'Notion', name_norm: 'notion', domain: 'notion.so', ats_provider: 'greenhouse', ats_token: 'notion', verified_at: '2026-10-01T00:00:00Z' }
  const squat = world({ identity: { name: 'Notion', homeUrls: [] } })

  it('a lead whose board is a Workable account named like a verified employer is other_owner, and the directory keeps one row', async () => {
    const { client, tables } = fakeDb({ company_directory: [{ ...notion }] })
    const r = await verifyEmployer(client, { name: 'Notion', domain: null, boards: [{ provider: 'workable', token: 'squat' }], source: 'lead' }, squat)
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory).toEqual([notion])
  })

  it('a person with a big employer name and no domain is refused; with that employer domain the row is written', async () => {
    const base = { name: 'Stripe', careersUrl: null, provider: 'workable' as const, token: 'squat', verifiedBy: 'provider_name', source: 'person' as const, openCount: 1, readTier: 'board', keepExisting: true }
    const { client, tables } = fakeDb()
    expect(await writeEmployer(client, { ...base, domain: null }, () => NOW)).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(await writeEmployer(client, { ...base, domain: 'evil.example' }, () => NOW)).toMatchObject({ ok: false, reason: 'other_owner' })
    expect(tables.company_directory ?? []).toHaveLength(0)
    expect(await writeEmployer(client, { ...base, domain: 'stripe.com' }, () => NOW)).toMatchObject({ ok: true })
    expect(tables.company_directory).toHaveLength(1)
  })

  it('the seed keeps its path: a namesake from a list is written', async () => {
    const { client, tables } = fakeDb({ company_directory: [{ ...notion }] })
    const r = await verifyEmployer(client, { name: 'Notion', domain: null, boards: [{ provider: 'workable', token: 'other' }], source: 'seed' }, squat)
    expect(r.ok).toBe(true)
    expect(tables.company_directory).toHaveLength(2)
  })
})

describe('verifyEmployer: a lead never gives a site-only row a board, and a board never gives a row its domain', () => {
  it('a lead with the employer domain leaves a site-only row without a board', async () => {
    const siteOnly = { id: 'e2', source: 'person', name: 'Acme', domain: 'acme.com', ats_provider: null, ats_token: null, verified_by: 'careers_url_host', careers_url: 'https://acme.com/jobs' }
    const { client, tables } = fakeDb({ company_directory: [{ ...siteOnly }] })
    const r = await verifyEmployer(client, { name: 'Acme', domain: 'acme.com', boards: [{ provider: 'greenhouse', token: 'acme' }], source: 'lead' }, world({ identity: { name: 'Acme', homeUrls: ['https://acme.com'] } }))
    expect(r).toEqual({ ok: true, employerId: 'e2' })
    expect(tables.company_directory).toEqual([siteOnly])
  })

  it('a board that declares a domain does not give it to a seed row that has none', async () => {
    const { client, tables } = fakeDb({ company_directory: [] })
    await verifyEmployer(client, { name: 'Gusto', domain: null, boards: [{ provider: 'greenhouse', token: 'gusto' }], source: 'seed' }, world({ identity: { name: 'Gusto', homeUrls: ['https://gusto.com'] } }))
    expect(tables.company_directory[0].domain ?? null).toBeNull()
  })

  it('a page link alone does not verify a board whose provider names another employer and declares no home', async () => {
    const r = await checkBoard(
      { name: 'Evil', domain: 'evil.example', careerUrl: 'https://evil.example/careers', provider: 'workable', token: 'retell' },
      world({ identity: { name: 'Retell AI', homeUrls: [] }, page: [{ provider: 'workable', token: 'retell' }] })
    )
    expect(r).toMatchObject({ ok: false, reason: 'other_owner' })
  })
})

describe('settleCandidate', () => {
  const kalil = (over: Partial<CandidateRow> = {}): CandidateRow => ({ id: 'c1', name: 'Gusto', domain: null, ats_provider: 'greenhouse', ats_token: 'gusto', source: 'kalil', failed_reads: 0, ...over })
  const seeded = (c: CandidateRow, rpc: Record<string, (a: Record<string, unknown>) => unknown> = {}) => fakeDb({ directory_candidates: [{ ...c, state: 'pending' }] }, { rpc })

  it('verifies a seed entry by the provider own name and joins the rotation', async () => {
    const { client, tables } = seeded(kalil())
    const r = await settleCandidate(client, kalil(), world({ identity: { name: 'Gusto', homeUrls: [] } }))
    expect(r.state).toBe('verified')
    expect(tables.company_directory).toHaveLength(1)
    expect(tables.company_directory[0]).toMatchObject({ verified_by: 'seed_checked', source: 'seed', open_count: 2, read_tier: 'board' })
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'verified', employer_id: tables.company_directory[0].id })
  })

  it('a slug another employer owns fails as other_owner and offers the employer the directory has', async () => {
    const c = kalil({ name: 'Retell AI', domain: 'retellai.com', ats_provider: 'workable', ats_token: 'retell' })
    const { client, tables } = seeded(c, { search_company_directory: () => [{ id: 'e1', name: 'Retell AI', domain: 'retellai.com' }] })
    const r = await settleCandidate(client, c, world({ identity: { name: 'Retell Inc', homeUrls: ['https://retell.io'] } }))
    expect(r).toMatchObject({ state: 'failed', reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI', employerId: 'e1' }] })
    expect(tables.company_directory ?? []).toHaveLength(0)
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'failed', fail_reason: 'other_owner' })
  })

  it('a write the database refuses counts as an unread board, so the candidate does not stay first in line', async () => {
    const c = kalil()
    const { client, tables } = fakeDb({ directory_candidates: [{ ...c, state: 'pending' }], company_directory: [{ id: 'e0', name: 'Gusto', name_norm: 'gusto', ats_provider: 'lever', ats_token: 'other' }] }, { unique: { company_directory: [['name_norm']] } })
    const r = await settleCandidate(client, c, world({ identity: { name: 'Gusto', homeUrls: [] } }))
    expect(r).toMatchObject({ state: 'retry' })
    expect(tables.directory_candidates[0]).toMatchObject({ state: 'pending', failed_reads: 1 })
    expect(tables.directory_candidates[0].next_check_at).not.toBeNull()
  })

  it('a board that does not answer is tried again, and fails for good at the third read', async () => {
    const down = world({ jobs: new HttpError('down', 503) })
    const first = seeded(kalil())
    expect(await settleCandidate(first.client, kalil(), down)).toMatchObject({ state: 'retry' })
    expect(first.tables.directory_candidates[0]).toMatchObject({ state: 'pending', failed_reads: 1 })
    const last = seeded(kalil({ failed_reads: 2 }))
    expect(await settleCandidate(last.client, kalil({ failed_reads: 2 }), down)).toMatchObject({ state: 'failed', reason: 'cannot_read' })
    expect(last.tables.directory_candidates[0]).toMatchObject({ state: 'failed', fail_reason: 'cannot_read' })
  })

  it('a YC row with a website and no board is checked through the board its own site links to', async () => {
    const c = kalil({ name: 'Retell AI', domain: 'retellai.com', ats_provider: null, ats_token: null, source: 'yc' })
    const { client, tables } = seeded(c)
    const r = await settleCandidate(client, c, world({ identity: { name: 'Retell AI', homeUrls: ['https://retellai.com'] }, page: [{ provider: 'ashby', token: 'retell-ai' }] }))
    expect(r.state).toBe('verified')
    expect(tables.company_directory[0]).toMatchObject({ ats_provider: 'ashby', ats_token: 'retell-ai', domain: 'retellai.com', source: 'yc' })
  })

  it('a YC row whose site links no board is no_board, and nothing is guessed from its name', async () => {
    const c = kalil({ domain: 'gusto.com', ats_provider: null, ats_token: null, source: 'yc' })
    const { client, tables } = seeded(c)
    expect(await settleCandidate(client, c, world())).toMatchObject({ state: 'failed', reason: 'no_board' })
    expect(tables.company_directory ?? []).toHaveLength(0)
  })
})
