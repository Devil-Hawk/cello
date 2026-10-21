import { describe, expect, it } from 'vitest'
import type { AddResult } from './add-link'
import { addLinksRun, coverageRun, findRun, recordMeasureRun, runAddLinks, runCoverage, runFinds, type FindRow } from './directory-runs'
import { fakeDb } from './fake-db'

describe('T24: directory search coverage', () => {
  const world = () =>
    fakeDb(
      {
        directory_candidates: [
          { name: 'Pending Co', name_norm: 'pending', state: 'pending' },
          { name: 'Failed Co', name_norm: 'failed', state: 'failed', fail_reason: 'not_linked' },
          { name: 'Deep Co', name_norm: 'deep', state: 'verified' },
        ],
        company_directory: [{ name: 'Dead Co', name_norm: 'dead', cannot_read_reason: 'no_board' }],
      },
      { rpc: { directory_progress: () => [{ verified: 100, pending: 40, failed: 7 }] } }
    )

  it('counts a name found among the first 3 verified rows, and says why each other name was missed', async () => {
    const { client } = world()
    const found = new Set(['Stripe', 'Deep Co'])
    const search = async (_db: unknown, name: string) => ({ employers: found.has(name) && name === 'Stripe' ? [{ name: 'Stripe', name_norm: 'stripe' }] : [], notChecked: [] }) as never
    const c = await runCoverage(client, ['Stripe', 'Pending Co', 'Failed Co', 'Dead Co', 'Deep Co', 'Never Heard Of', '  '], search)
    expect(c.total).toBe(6)
    expect(c.hits).toBe(1)
    expect(c.rows.map((r) => [r.name, r.hit, r.reason, r.detail])).toEqual([
      ['Stripe', true, undefined, undefined],
      ['Pending Co', false, 'pending', undefined],
      ['Failed Co', false, 'failed', 'not_linked'],
      ['Dead Co', false, 'cannot_read', 'no_board'],
      ['Deep Co', false, 'below_first_3', undefined],
      ['Never Heard Of', false, 'not_in_seed', undefined],
    ])
    expect(c.progress).toEqual({ verified: 100, pending: 40, failed: 7 })
  })

  it('is judged only on a full set of 35 names: 34 pass, 33 fail, fewer are reported', () => {
    const rows = (hits: number, total: number) => Array.from({ length: total }, (_, i) => ({ name: `Co ${i}`, hit: i < hits, reason: i < hits ? undefined : ('not_in_seed' as const) }))
    const progress = { verified: 1, pending: 1, failed: 0 }
    expect(coverageRun({ rows: rows(34, 35), hits: 34, total: 35, progress })).toMatchObject({ value: 34 / 35, passed: true, sample_n: 35 })
    expect(coverageRun({ rows: rows(33, 35), hits: 33, total: 35, progress }).passed).toBe(false)
    expect(coverageRun({ rows: rows(10, 12), hits: 10, total: 12, progress }).passed).toBeNull()
    expect(coverageRun({ rows: rows(33, 35), hits: 33, total: 35, progress }).note).toContain('Co 34: not_in_seed')
  })
})

describe('T25: add by link', () => {
  const ok = (name: string, already = false): AddResult => ({ ok: true, companyId: 'c1', already, employer: { employerId: 'e1', name, domain: null, logoUrl: null, openCount: null } })
  const no = (reason: 'other_owner' | 'stale', offers = 0): AddResult => ({ ok: false, reason, line: 'x', offers: Array.from({ length: offers }, () => ({ kind: 'employer' as const, name: 'Retell AI' })) })

  it('is right when the right employer is added or the right reason is given, and counts a wrong employer', async () => {
    const answers: Record<string, AddResult> = {
      'https://retellai.com/careers': ok('Retell AI'),
      'https://other.example/careers': no('other_owner', 1),
      'https://stale.example/careers': ok('Stale Co'), // should have been refused: a wrong employer added
      'https://mix.example/careers': ok('Not The One'),
    }
    const { client } = fakeDb()
    const r = await runAddLinks(
      client,
      'u1',
      [
        { link: 'https://retellai.com/careers', expect: { employer: 'Retell AI' } },
        { link: 'https://other.example/careers', expect: { reason: 'other_owner' } },
        { link: 'https://stale.example/careers', expect: { reason: 'stale' } },
        { link: 'https://mix.example/careers', expect: { employer: 'Mix Co' } },
      ],
      async (_db, _u, by) => answers[by.link]
    )
    expect(r.correct).toBe(2)
    expect(r.wrongEmployers).toBe(2)
    expect(r.rows.map((x) => x.ok)).toEqual([true, true, false, false])
    expect(r.rows[1].offers).toBe(1)
  })

  it('passes only at 20 of 20 with no wrong employer added', () => {
    const rows = (n: number, bad: number) => Array.from({ length: n }, (_, i) => ({ link: `l${i}`, ok: i >= bad, got: 'x', wrongEmployer: false, offers: 0 }))
    expect(addLinksRun({ rows: rows(20, 0), correct: 20, wrongEmployers: 0 }).passed).toBe(true)
    expect(addLinksRun({ rows: rows(20, 1), correct: 19, wrongEmployers: 0 }).passed).toBe(false)
    expect(addLinksRun({ rows: rows(20, 0), correct: 20, wrongEmployers: 1 }).passed).toBe(false)
    expect(addLinksRun({ rows: rows(8, 0), correct: 8, wrongEmployers: 0 }).passed).toBeNull()
  })
})

describe('recordMeasureRun', () => {
  it('writes one measure_runs row with the number, the verdict and the note', async () => {
    const { client, tables } = fakeDb({ measure_runs: [] })
    await recordMeasureRun(client, 'T24', { value: 0.97, passed: true, sample_n: 35, note: 'ok' })
    expect(tables.measure_runs).toEqual([{ measure_id: 'T24', value: 0.97, passed: true, sample_n: 35, note: 'ok' }])
  })
})

describe('T34: find by name', () => {
  it('counts a name when a candidate for that employer is offered, and says which rung found it or how far a miss got', async () => {
    const answers: Record<string, { rungs: ('directory' | 'boards' | 'lookup' | 'site' | 'web')[]; result: unknown }> = {
      'Retell AI': { rungs: ['directory', 'boards'], result: { candidates: [{ name: 'Retell AI', domain: 'retellai.com', foundBy: 'board', provenBy: 'the board declares retellai.com as home', jobs: 12 }] } },
      Modal: { rungs: ['directory', 'boards', 'lookup'], result: { candidates: [{ name: 'Modal Trouble', domain: 'modaltrouble.com', foundBy: 'wikidata', provenBy: 'x', jobs: null }] } },
      Cursor: { rungs: ['directory', 'boards', 'lookup', 'site', 'web'], result: { none: true, queued: true, line: 'x' } },
      Glean: { rungs: ['directory', 'boards', 'lookup', 'site', 'web'], result: { none: true, line: 'x' } },
      Linear: { rungs: ['directory', 'boards'], result: { candidates: [{ name: 'Linear Orbit', domain: 'linear.app', foundBy: 'board', provenBy: 'x', jobs: 3 }] } },
      'Fireworks AI': { rungs: ['directory', 'boards', 'lookup', 'site'], result: { candidates: [{ name: 'Fireworks', domain: 'fireworks.ai', foundBy: 'site', provenBy: 'its site links the board', jobs: 9 }] } },
    }
    let t = 0
    const run = await runFinds(['Retell AI', 'Modal', 'Cursor', 'Glean', 'Linear', 'Fireworks AI', '  '], async (name, report) => {
      const a = answers[name]
      a.rungs.forEach((rung) => report({ rung, line: rung }))
      t += 100
      return a.result as never
    }, () => t)
    expect(run.total).toBe(6)
    expect(run.hits).toBe(3)
    expect(run.rows.map((r) => [r.name, r.hit, r.rung, r.found ?? r.reason])).toEqual([
      ['Retell AI', true, 'board', 'Retell AI (retellai.com); the board declares retellai.com as home'],
      ['Modal', false, 'lookup', 'offered other employers (Modal Trouble at modaltrouble.com), not Modal'],
      ['Cursor', false, 'web', 'nothing proven; no search key, so the web search was left for the worker'],
      ['Glean', false, 'web', 'nothing proven'],
      ['Linear', true, 'board', 'Linear Orbit (linear.app); x'],
      ['Fireworks AI', true, 'site', 'Fireworks (fireworks.ai); its site links the board'],
    ])
  })
})

describe('T34: the verdict and its note', () => {
  const row = (name: string, hit: boolean): FindRow => (hit ? { name, hit, rung: 'board', found: name, ms: 1 } : { name, hit, rung: 'site', reason: 'nothing proven', ms: 1 })

  it('passes when every owner name is found and 8 of 10 startups are, and says both counts', () => {
    const owner = ['Amazon', 'Apple'].map((n) => row(n, true))
    const startups = Array.from({ length: 10 }, (_, i) => row(`S${i}`, i < 8))
    const run = findRun([...owner, ...startups], 2)
    expect(run).toMatchObject({ passed: true, sample_n: 12, value: 10 / 12 })
    expect(run.note).toBe("Owner's names found: 2 of 2. Startups found: 8 of 10 (need 8). Misses: S8 at site: nothing proven; S9 at site: nothing proven.")
  })

  it('fails on one owner miss, or on 7 of 10 startups, and names each miss with its rung', () => {
    expect(findRun([row('Amazon', false), row('Apple', true)], 2)).toMatchObject({ passed: false })
    const seven = Array.from({ length: 10 }, (_, i) => row(`S${i}`, i < 7))
    const run = findRun([row('Amazon', true), row('Apple', true), ...seven], 2)
    expect(run.passed).toBe(false)
    expect(run.note).toContain('Startups found: 7 of 10 (need 8)')
    expect(run.note).toContain('S7 at site: nothing proven')
  })

  it('reports no verdict when there is no row to judge', () => {
    expect(findRun([], 0)).toMatchObject({ passed: null, value: null, sample_n: 0 })
  })
})
