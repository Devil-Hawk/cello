import { describe, expect, it } from 'vitest'
import { formatScorecard } from './format'
import { isOwner } from './owner'
import { buildScorecard, ownerScorecard, type MeasureRow, type RunRow } from './scorecard'

const measure = (id: string, over: Partial<MeasureRow> = {}): MeasureRow => ({
  id,
  layer: id[0] === 'T' ? 'true' : id[0] === 'S' ? 'step' : 'person',
  name: `measure ${id}`,
  bar: 'at most 7',
  direction: 'lower',
  source: 'heartbeats',
  gates: ['K4'],
  state: 'watch',
  ...over,
})

const run = (measure_id: string, over: Partial<RunRow> = {}): RunRow => ({
  measure_id,
  ran_at: '2026-10-08T06:00:00Z',
  value: 3,
  passed: true,
  sample_n: 4,
  note: null,
  ...over,
})

describe('buildScorecard', () => {
  it('shows a failing number as failing, and sorts failing rows first', () => {
    const rows = buildScorecard([measure('T1'), measure('T2'), measure('T5'), measure('S1')], [run('T1'), run('T5', { value: 12.4, passed: false }), run('S1', { passed: true })])
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['T5', 'failing'],
      ['T2', 'no_run'],
      ['T1', 'passing'],
      ['S1', 'passing'],
    ])
    expect(rows[0].latest?.value).toBe(12.4)
  })

  it('reads a measure with no run, or a run with no verdict, as no run yet, never as a pass', () => {
    const rows = buildScorecard([measure('T1'), measure('T2')], [run('T2', { passed: null, value: null })])
    expect(rows.map((r) => r.status)).toEqual(['no_run', 'no_run'])
  })

  it('uses the latest run and gives the trend against the one before', () => {
    const rows = buildScorecard(
      [measure('T5')],
      [run('T5', { ran_at: '2026-10-06T06:00:00Z', value: 9 }), run('T5', { ran_at: '2026-10-08T06:00:00Z', value: 5 }), run('T5', { ran_at: '2026-10-07T06:00:00Z', value: 7 })]
    )
    expect(rows[0].latest?.value).toBe(5)
    expect(rows[0].previousValue).toBe(7)
    expect(rows[0].trend).toBe('falling')
  })

  it('keeps a pinned known failure on the row after a later run replaces the number', () => {
    const pinned = 'Pinned 2026-10-05: no scheduled role check has succeeded for the owner on production.'
    const rows = buildScorecard([measure('T5')], [run('T5', { ran_at: '2026-10-05T12:00:00Z', passed: false, value: null, note: pinned }), run('T5', { ran_at: '2026-10-08T06:00:00Z', value: 4 })])
    expect(rows[0].status).toBe('passing')
    expect(rows[0].pinned).toBe(pinned)
  })

  it('puts T2 before T10 and the true layer before steps and people', () => {
    const rows = buildScorecard([measure('P1'), measure('S2'), measure('T10'), measure('T2')], [])
    expect(rows.map((r) => r.id)).toEqual(['T2', 'T10', 'S2', 'P1'])
  })
})

describe('tiers', () => {
  const free = (over: Partial<RunRow> = {}) => run('S14', { note: 'tier=free model=g/m:free core=deep; injection=0', value: 0.85, ran_at: '2026-10-20T06:00:00Z', ...over })

  it('is null for a measure with no tiered run', () => {
    expect(buildScorecard([measure('S14')], [run('S14')])[0].tiers).toBeNull()
  })

  it('builds a cell per tier and leaves a tier with no run null', () => {
    const rows = buildScorecard([measure('S14')], [free()])
    expect(rows[0].tiers).toEqual({ local: null, free: { value: 0.85, passed: true, model: 'g/m:free', ranAt: '2026-10-20T06:00:00Z' }, paid: null })
  })

  it('takes the latest run per tier, and ignores plain runs for the cells', () => {
    const rows = buildScorecard(
      [measure('S14')],
      [
        free({ ran_at: '2026-10-18T06:00:00Z', value: 0.5, passed: false }),
        free({ ran_at: '2026-10-19T06:00:00Z', value: 0.9 }),
        free({ ran_at: '2026-10-20T06:00:00Z', value: 0.1, passed: false, note: 'tier=free model=g/m:free core=plain' }),
        run('S14', { ran_at: '2026-10-17T06:00:00Z', value: 0.7, passed: true, note: 'tier=paid model=p core=deep' }),
      ]
    )
    expect(rows[0].tiers?.free).toMatchObject({ value: 0.9, passed: true })
    expect(rows[0].tiers?.paid).toMatchObject({ value: 0.7, model: 'p' })
    expect(rows[0].tiers?.local).toBeNull()
  })

  it('takes the row latest, status and trend from the free tier, not from a newer paid or plain run', () => {
    const rows = buildScorecard(
      [measure('S14')],
      [
        free({ ran_at: '2026-10-18T06:00:00Z', value: 0.6, passed: false }),
        free({ ran_at: '2026-10-19T06:00:00Z', value: 0.85, passed: true }),
        run('S14', { ran_at: '2026-10-20T06:00:00Z', value: 0.2, passed: false, note: 'tier=paid model=p core=deep' }),
        run('S14', { ran_at: '2026-10-20T07:00:00Z', value: 0.1, passed: false, note: 'tier=free model=g core=plain' }),
      ]
    )
    expect(rows[0]).toMatchObject({ status: 'passing', previousValue: 0.6, trend: 'rising' })
    expect(rows[0].latest).toMatchObject({ value: 0.85, ranAt: '2026-10-19T06:00:00Z' })
  })

  it('reads a tiered measure with only paid or plain runs as no run, never a status', () => {
    const rows = buildScorecard([measure('S14')], [run('S14', { passed: true, note: 'tier=paid model=p core=deep' }), run('S14', { passed: false, ran_at: '2026-10-09T06:00:00Z', note: 'tier=free model=g core=plain' })])
    expect(rows[0].status).toBe('no_run')
    expect(rows[0].latest).toBeNull()
    expect(rows[0].tiers?.paid).toMatchObject({ passed: true })
  })

  it('keeps an untiered measure as it was', () => {
    const rows = buildScorecard([measure('T1')], [run('T1', { note: 'plain note' })])
    expect(rows[0]).toMatchObject({ status: 'passing', tiers: null })
  })
})

describe('formatScorecard', () => {
  it('prints the by-tier line with not run for a tier without a run', () => {
    const rows = buildScorecard([measure('S14')], [run('S14', { value: 0.85, ran_at: '2026-10-20T06:00:00Z', note: 'tier=free model=g/m:free core=deep' })])
    expect(formatScorecard(rows)).toContain('by tier: local not run; free 0.85 passing (g/m:free, 2026-10-20); paid not run')
  })

  it('says FAILING for a failing tier and cannot read for a tier with no number', () => {
    const rows = buildScorecard([measure('S14')], [
      run('S14', { value: 0.4, passed: false, note: 'tier=paid model=p core=deep' }),
      run('S14', { value: null, passed: false, ran_at: '2026-10-19T06:00:00Z', note: 'tier=local model=q core=deep' }),
    ])
    const text = formatScorecard(rows)
    expect(text).toContain('local cannot read FAILING (q, 2026-10-19)')
    expect(text).toContain('paid 0.4 FAILING (p, 2026-10-08)')
  })

  it('prints no by-tier line for a measure without tiers', () => {
    expect(formatScorecard(buildScorecard([measure('T1')], [run('T1')]))).not.toContain('by tier')
  })

  it('says FAILING, "No run yet" and the pinned note in words', () => {
    const rows = buildScorecard(
      [measure('S4', { bar: 'a rise of at least 0.10' }), measure('T1')],
      [run('S4', { value: 0.7, passed: false, note: 'Pinned 2026-10-05: the shortlist was not proven.' })]
    )
    const text = formatScorecard(rows)
    expect(text).toContain('2 measures, 1 failing, 1 with no run yet.')
    expect(text).toMatch(/FAILING\s+S4/)
    expect(text).toContain('Latest: 0.7 on 2026-10-08')
    expect(text).toContain('Pinned 2026-10-05: the shortlist was not proven.')
    expect(text).toContain('Latest: No run yet.')
    expect(text.indexOf('S4')).toBeLessThan(text.indexOf('T1'))
    expect(text).not.toContain('—')
  })
})

describe('the owner', () => {
  const env = { OWNER_USER_ID: 'owner-1' }

  it('is the one user OWNER_USER_ID names, and nobody when it is not set', () => {
    expect(isOwner('owner-1', env)).toBe(true)
    expect(isOwner('someone-else', env)).toBe(false)
    expect(isOwner(null, env)).toBe(false)
    expect(isOwner('owner-1', {})).toBe(false)
    expect(isOwner('', { OWNER_USER_ID: '' })).toBe(false)
  })

  it('gives a non-owner null, which the command wrapper answers with 404, and reads nothing for them', async () => {
    let reads = 0
    const admin = {
      from: () => {
        reads++
        throw new Error('must not read')
      },
    } as never
    expect(await ownerScorecard({ userId: 'someone-else', admin, env })).toBeNull()
    expect(await ownerScorecard({ userId: undefined, admin, env })).toBeNull()
    expect(reads).toBe(0)
  })

  it('gives the owner the rows', async () => {
    const tables: Record<string, unknown[]> = { measures: [measure('T5')], measure_runs: [run('T5', { passed: false, value: 12 })] }
    const admin = {
      from: (t: string) => {
        const b: Record<string, unknown> = {
          select: () => b,
          order: () => b,
          limit: () => Promise.resolve({ data: tables[t] ?? [], error: null }),
          like: () => Promise.resolve({ data: [], error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: tables[t] ?? [], error: null }),
        }
        return b
      },
    } as never
    const rows = await ownerScorecard({ userId: 'owner-1', admin, env })
    expect(rows?.[0]).toMatchObject({ id: 'T5', status: 'failing' })
  })
})
