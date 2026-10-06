import { describe, expect, it } from 'vitest'
import { HttpError } from '../ats/http'
import type { AtsJob } from '../ats/types'
import { postingCapture } from '../ingest/markdown'
import { prepareTargets } from '../jobs/target-relevance'
import { EMPTY_TARGETING } from '../targeting'
import type { DirectoryRow } from './directory'
import { fakeDb } from './fake-db'
import { readEmployer, type Person, type ReadDeps } from './read-employer'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()
const desc = 'We are hiring to build and run our platform. You will design services, review code, mentor others and ship every week. '.repeat(3)
const job = (id: string, title: string, daysAgo: number, extra: Partial<AtsJob> = {}): AtsJob => ({ title, url: `https://boards.greenhouse.io/acme/jobs/${id}`, externalId: id, postedAt: iso(daysAgo), description: desc, location: 'Remote', ...extra })

const employer = (over: Partial<DirectoryRow> = {}): DirectoryRow => ({
  id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', logo_url: null, open_count: null, open_count_at: null,
  ats_provider: 'greenhouse', ats_token: 'acme', careers_url: null, verified_by: 'seed_checked', verified_at: iso(5), source: 'seed',
  last_read_at: null, next_read_at: null, read_tier: 'board', cannot_read_reason: null, failed_reads: 0, ...over,
})

const engineer: Person = { userId: 'u1', targets: { targeting: { ...EMPTY_TARGETING, functions: ['engineering'] }, titles: [] }, prepared: prepareTargets([]) }

interface Run {
  jobs?: AtsJob[] | Error
  stored?: { externalId: string; descriptionMd5: string | null }[]
  followers?: number
  people?: Person[]
  identity?: { name: string; homeUrls: string[] } | null
  page?: { provider: 'greenhouse'; token: string }[]
  row?: Partial<DirectoryRow>
}

async function run(o: Run = {}) {
  const row = employer(o.row)
  const rpcs: Record<string, Record<string, unknown>[]> = { upsert_employer_jobs: [], record_employer_sightings: [], bump_employer_stats: [] }
  const { client, tables } = fakeDb(
    { company_directory: [{ ...row }], companies: Array.from({ length: o.followers ?? 0 }, (_, i) => ({ id: `c${i}`, employer_id: 'e1', watching: true })) },
    { rpc: Object.fromEntries(Object.keys(rpcs).map((name) => [name, (a: Record<string, unknown>) => (rpcs[name].push(a), 1)])) }
  )
  const deps: ReadDeps = {
    verify: {
      now: () => NOW,
      fetchBoard: async () => {
        if (o.jobs instanceof Error) throw o.jobs
        return o.jobs ?? []
      },
      identify: async () => o.identity ?? null,
      pageBoards: async () => o.page ?? [],
    },
    listStored: async () => (o.stored ?? []).map((s) => ({ ...s, title: 'x', location: null, salaryRange: null })),
  }
  const result = await readEmployer(client, row, o.people ?? [engineer], deps)
  const sent = rpcs.upsert_employer_jobs.flatMap((a) => a.p_rows as { external_id: string; employer_id: string }[])
  return { result, tables, rpcs, sent, directory: tables.company_directory[0] }
}

describe('readEmployer: what a sweep read keeps, counts and records', () => {
  const board = [job('1', 'Software Engineer', 3), job('2', 'Software Engineer', 20), job('3', 'Account Executive', 5), job('4', 'Software Engineer', 60)]

  it('stores only roles inside someone targets and inside the 30-day window at an employer nobody follows, and counts the rest', async () => {
    const { result, sent, rpcs, directory } = await run({ jobs: board })
    expect(result).toMatchObject({ listed: 4, kept: 2, stored: 2, errors: [] })
    expect(sent.map((r) => r.external_id).sort()).toEqual(['1', '2'])
    expect(sent.every((r) => r.employer_id === 'e1' && !('company_id' in r))).toBe(true)
    // every listing is counted, stored or not
    const stats = rpcs.bump_employer_stats[0].p_rows as { open: number; opened_30d: number }[]
    expect(stats.reduce((n, s) => n + s.open, 0)).toBe(4)
    expect(stats.reduce((n, s) => n + s.opened_30d, 0)).toBe(3)
    // "of 636 open" is the last read
    expect(directory).toMatchObject({ open_count: 4, last_read_at: new Date(NOW).toISOString(), failed_reads: 0, cannot_read_reason: null })
    expect(rpcs.record_employer_sightings[0]).toMatchObject({ p_employer: 'e1', p_external_ids: ['1', '2', '3', '4'] })
  })

  it('a role stays in reach for 180 days at an employer somebody follows', async () => {
    const { sent } = await run({ jobs: board, followers: 1 })
    expect(sent.map((r) => r.external_id).sort()).toEqual(['1', '2', '4'])
  })

  it('stores nothing when no one has stated what they want, and still counts', async () => {
    const { result, sent, directory } = await run({ jobs: board, people: [] })
    expect(result).toMatchObject({ listed: 4, kept: 0, stored: 0 })
    expect(sent).toEqual([])
    expect(directory.open_count).toBe(4)
  })

  it('writes a stored role again only when its posting changed', async () => {
    const withBody = (id: string, html: string) => job(id, 'Software Engineer', 3, { descriptionHtml: html, descriptionSource: 'api' })
    const same = withBody('1', '<p>The same posting</p>')
    const changed = withBody('2', '<p>A new heading and more</p>')
    const stored = [
      { externalId: '1', descriptionMd5: postingCapture(same).description_md5 },
      { externalId: '2', descriptionMd5: 'old' },
    ]
    const { sent } = await run({ jobs: [same, changed], stored })
    expect(sent.map((r) => r.external_id)).toEqual(['2'])
  })

  it('a board that is gone leaves the rotation with its reason; one that does not answer is tried again, and leaves at the third', async () => {
    const gone = await run({ jobs: new HttpError('gone', 404) })
    expect(gone.result.failure).toBe('no_board')
    expect(gone.directory).toMatchObject({ cannot_read_reason: 'no_board', next_read_at: null })
    expect(gone.sent).toEqual([])

    const down = await run({ jobs: new HttpError('down', 503) })
    expect(down.directory).toMatchObject({ failed_reads: 1, cannot_read_reason: null })
    expect(down.directory.next_read_at).toBe(new Date(NOW + 6 * 3_600_000).toISOString())

    const third = await run({ jobs: new HttpError('down', 503), row: { failed_reads: 2 } })
    expect(third.directory).toMatchObject({ failed_reads: 3, cannot_read_reason: 'cannot_read', next_read_at: null })
  })

  it('every 90 days the board is checked again first: another employer name leaves the rotation, the same one carries on', async () => {
    const old = { verified_at: iso(100) }
    const other = await run({ jobs: board, row: old, identity: { name: 'Other Co', homeUrls: ['https://other.com'] } })
    expect(other.result.failure).toBe('other_owner')
    expect(other.directory).toMatchObject({ cannot_read_reason: 'other_owner', next_read_at: null })
    expect(other.sent).toEqual([])

    const same = await run({ jobs: board, row: old, identity: { name: 'Acme', homeUrls: ['https://acme.com'] }, page: [{ provider: 'greenhouse', token: 'acme' }] })
    expect(same.result.listed).toBe(4)
    expect(same.directory.verified_at).toBe(new Date(NOW).toISOString())
  })

  it('the check of a row with no domain does not give it the domain its board declares', async () => {
    const r = await run({ jobs: board, row: { domain: null, verified_at: iso(100) }, identity: { name: 'Acme', homeUrls: ['https://victim.com'] } })
    expect(r.result.failure).toBeUndefined()
    expect(r.directory.domain).toBeNull()
  })

  it('a board that is not due is checked at once when its jobs name another employer, before anything is stored or counted', async () => {
    const taken = board.map((j) => ({ ...j, employer: 'Other Co' }))
    const other = await run({ jobs: taken, identity: { name: 'Other Co', homeUrls: ['https://other.com'] } })
    expect(other.result).toMatchObject({ failure: 'other_owner', listed: 0, stored: 0 })
    expect(other.directory).toMatchObject({ cannot_read_reason: 'other_owner', next_read_at: null })
    expect(other.sent).toEqual([])
    expect(other.rpcs.bump_employer_stats).toEqual([])
    expect(other.rpcs.record_employer_sightings).toEqual([])

    // the same employer under its legal name, or jobs that name nobody, are read as usual
    const same = await run({ jobs: board.map((j) => ({ ...j, employer: 'Acme, Inc.' })) })
    expect(same.result).toMatchObject({ listed: 4, stored: 2 })
    expect(same.directory.verified_at).toBe(iso(5))
  })
})
