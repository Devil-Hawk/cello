import { describe, expect, it, vi } from 'vitest'
import { DAILY_ADD_LIMIT } from './add-link'
import { followAndRead, reportEmployer, unfollowEmployer, type FollowOpts } from './follow'
import type { DirectoryRow } from './directory'
import { fakeDb } from './fake-db'
import type { EmployerRead, Person } from './read-employer'
import { REVERIFY_DAYS } from './read-employer'
import { EMPTY_TARGETING } from '../targeting'
import { prepareTargets } from '../jobs/target-relevance'

const NOW = Date.now()
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()
const DAY_MS = 86_400_000

const employer = (over: Partial<DirectoryRow> = {}): DirectoryRow => ({
  id: 'e1', name: 'Acme', name_norm: 'acme', domain: 'acme.com', logo_url: null, open_count: null, open_count_at: null,
  ats_provider: 'greenhouse', ats_token: 'acme', careers_url: null, verified_by: 'seed_checked', verified_at: iso(5), source: 'seed',
  last_read_at: null, next_read_at: null, read_tier: 'board', cannot_read_reason: null, failed_reads: 0, ...over,
})
const profile = { id: 'u1', is_demo: false, demo_expires_at: null }
const engineer: Person = { userId: 'u1', targets: { targeting: { ...EMPTY_TARGETING, functions: ['engineering'] }, titles: [] }, prepared: prepareTargets([]) }
const READ: EmployerRead = { listed: 3, kept: 1, stored: 0, errors: [] }

type ReadFn = NonNullable<FollowOpts['read']>
const readFn = (value: EmployerRead = READ) => vi.fn<Parameters<ReadFn>, ReturnType<ReadFn>>(async () => value)

const world = (tables: Record<string, Record<string, unknown>[]> = {}) =>
  fakeDb({ profiles: [profile], company_directory: [{ ...employer() }], companies: [], employer_reports: [], ...tables })
const writes = (queries: { op: string }[]) => queries.filter((q) => q.op !== 'select')

describe('followAndRead: follow, then one read inside the budget', () => {
  it('follow sets watching and employer_id and runs one read; a second follow answers already with no second read', async () => {
    const { client, tables } = world()
    const read = readFn()
    const first = await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(first).toEqual({ ok: true, following: true, already: false, read: { listed: 3, kept: 1 }, line: '3 open · checked just now', fit: '1 fit your targets' })
    expect(tables.companies[0]).toMatchObject({ user_id: 'u1', employer_id: 'e1', watching: true })
    expect(read).toHaveBeenCalledTimes(1)

    const second = await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(second).toMatchObject({ ok: true, already: true, read: null })
    expect(read).toHaveBeenCalledTimes(1)
    expect(tables.companies).toHaveLength(1)
  })

  it('with no targets stated the line counts open roles and says nothing about fit', async () => {
    const r = await followAndRead(world().client, 'u1', 'e1', [], { read: readFn() })
    expect(r).toMatchObject({ line: '3 open · checked just now', fit: null })
  })

  it('with targets and nothing kept the fit line is null, not a verdict', async () => {
    const r = await followAndRead(world().client, 'u1', 'e1', [engineer], { read: readFn({ listed: 12, kept: 0, stored: 0, errors: [] }) })
    expect(r).toMatchObject({ line: '12 open · checked just now', fit: null })
  })

  it('past the budget the person gets the hand-off line and the read still finishes', async () => {
    let finished = false
    const read: ReadFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      finished = true
      return READ
    }
    const r = await followAndRead(world().client, 'u1', 'e1', [engineer], { read, budgetMs: 5 })
    expect(r).toEqual({ ok: true, following: true, already: false, read: null, line: 'Following. Cello reads its board within the hour.', fit: null })
    expect(finished).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(finished).toBe(true)
  })

  it('a demo account is refused with its line and nothing is read or written', async () => {
    const { client, queries } = world({ profiles: [{ id: 'u1', is_demo: true, demo_expires_at: null }] })
    const read = readFn()
    const r = await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(r).toEqual({ ok: false, reason: 'demo', line: 'Demo accounts cannot add employers.' })
    expect(read).not.toHaveBeenCalled()
    expect(writes(queries)).toEqual([])
  })

  it('follow, unfollow, follow again: one row, watching true, one more read', async () => {
    const { client, tables } = world()
    const read = readFn()
    await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(await unfollowEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'following' })
    const again = await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(again).toMatchObject({ ok: true, following: true, already: false })
    expect(tables.companies).toHaveLength(1)
    expect(tables.companies[0]).toMatchObject({ employer_id: 'e1', watching: true })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('report, then follow again: one row, watching true, one more read', async () => {
    const { client, tables } = world()
    const read = readFn()
    await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(await reportEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'following' })
    const again = await followAndRead(client, 'u1', 'e1', [engineer], { read })
    expect(again).toMatchObject({ ok: true, following: true, already: false })
    expect(tables.companies).toHaveLength(1)
    expect(tables.companies[0]).toMatchObject({ employer_id: 'e1', watching: true })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a follow without a dream flag leaves the person\'s dream flag as it was', async () => {
    const { client, tables } = world({ companies: [{ id: 'c1', user_id: 'u1', name: 'Acme', domain: 'acme.com', name_key: 'acme', employer_id: 'e1', watching: false, is_dream_company: true, metadata: {} }] })
    expect(await followAndRead(client, 'u1', 'e1', [engineer], { read: readFn() })).toMatchObject({ ok: true, already: false })
    expect(tables.companies).toHaveLength(1)
    expect(tables.companies[0]).toMatchObject({ watching: true, is_dream_company: true })
  })

  it('the 31st follow in a day is refused with the limit line and no read', async () => {
    const today = new Date().toISOString()
    const rows = Array.from({ length: DAILY_ADD_LIMIT }, (_, i) => ({ id: `c${i}`, user_id: 'u1', name: `Co ${i}`, domain: `co${i}.com`, watching: true, created_at: today }))
    const read = readFn()
    const r = await followAndRead(world({ companies: rows }).client, 'u1', 'e1', [engineer], { read })
    expect(r).toMatchObject({ ok: false, reason: 'daily_limit' })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('unfollow and report', () => {
  it('unfollow sets watching to false and keeps the row; a second unfollow says it was not followed', async () => {
    const { client, tables } = world({ companies: [{ id: 'c1', user_id: 'u1', name: 'Acme', employer_id: 'e1', watching: true }] })
    expect(await unfollowEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'following' })
    expect(tables.companies).toHaveLength(1)
    expect(tables.companies[0]).toMatchObject({ id: 'c1', watching: false })
    expect(await unfollowEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'not_following' })
  })

  it('report unfollows, keeps the report, and sends the board to the next read by setting verified_at back past the re-check age', async () => {
    const { client, tables } = world({ companies: [{ id: 'c1', user_id: 'u1', name: 'Acme', employer_id: 'e1', watching: true }] })
    expect(await reportEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'following' })
    expect(tables.companies[0]).toMatchObject({ watching: false })
    expect(tables.employer_reports).toEqual([expect.objectContaining({ user_id: 'u1', employer_id: 'e1' })])
    const dir = tables.company_directory[0]
    expect(Date.now() - Date.parse(dir.verified_at as string)).toBeGreaterThan(REVERIFY_DAYS * DAY_MS)
    expect(Date.parse(dir.next_read_at as string)).toBeLessThanOrEqual(Date.now())
  })

  it('report by a demo account is refused and writes nothing', async () => {
    const { client, queries } = world({ profiles: [{ id: 'u1', is_demo: true, demo_expires_at: null }], companies: [{ id: 'c1', user_id: 'u1', name: 'Acme', employer_id: 'e1', watching: true }] })
    expect(await reportEmployer(client, 'u1', 'e1')).toEqual({ ok: false, reason: 'demo' })
    expect(writes(queries)).toEqual([])
  })

  it('report on an employer the person does not follow writes no report and no re-check', async () => {
    const { client, tables } = world()
    expect(await reportEmployer(client, 'u1', 'e1')).toEqual({ ok: true, was: 'not_following' })
    expect(tables.employer_reports).toEqual([])
    expect(tables.company_directory[0]).toMatchObject({ verified_at: employer().verified_at, next_read_at: null })
  })

  it('report for an employer Cello does not have is not_found and writes nothing', async () => {
    const { client, queries } = world()
    expect(await reportEmployer(client, 'u1', 'nope')).toEqual({ ok: false, reason: 'not_found' })
    expect(writes(queries)).toEqual([])
  })
})
