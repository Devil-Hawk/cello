import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { chatReady, recordMeasure, recordS21 } from './record'

const run = (measure: string, passed: boolean | null, ranAt: string) => ({ measure_id: measure, passed, ran_at: ranAt })

describe('chatReady', () => {
  it('is ready only when all four gating measures have a latest run that passed', async () => {
    const db = makeFakeAdmin({ measure_runs: ['S13', 'S14', 'S15', 'S21'].map((m) => run(m, true, '2026-10-05T10:00:00Z')) })
    expect(await chatReady(db)).toMatchObject({ ready: true, sentence: 'Ready: S13, S14, S15 and S21 pass.' })
  })

  it('says which measure has no run and which is failing, and refuses to say ready', async () => {
    const db = makeFakeAdmin({ measure_runs: [run('S13', true, '2026-10-05T10:00:00Z'), run('S14', false, '2026-10-05T10:00:00Z'), run('S21', true, '2026-10-05T10:00:00Z')] })
    const out = await chatReady(db)
    expect(out.ready).toBe(false)
    expect(out.sentence).toBe('Not ready. No run yet: S15. Not passing: S14.')
  })

  it('judges the latest run, not an old pass', async () => {
    const db = makeFakeAdmin({
      measure_runs: [...['S13', 'S14', 'S15'].map((m) => run(m, true, '2026-10-05T10:00:00Z')), run('S21', true, '2026-10-01T10:00:00Z'), run('S21', false, '2026-10-05T10:00:00Z')],
    })
    expect((await chatReady(db)).sentence).toBe('Not ready. Not passing: S21.')
  })

  it('does not count a run with no verdict as a pass', async () => {
    const db = makeFakeAdmin({ measure_runs: ['S13', 'S14', 'S15', 'S21'].map((m) => run(m, m === 'S15' ? null : true, '2026-10-05T10:00:00Z')) })
    expect((await chatReady(db)).sentence).toBe('Not ready. Not passing: S15.')
  })
})

describe('recording', () => {
  it('writes one row for a measure and S21\'s row from its score', async () => {
    const db = makeFakeAdmin({ measure_runs: [] })
    expect(await recordMeasure(db, { measure: 'S13', value: 1, passed: true, sampleN: 12 })).toBe(true)
    expect(await recordS21(db, { parts: 20, right: 19, share: 0.95, wrongObjectFacts: 0, passed: true })).toBe(true)
    expect(db.tables.measure_runs).toMatchObject([
      { measure_id: 'S13', value: 1, passed: true, sample_n: 12 },
      { measure_id: 'S21', value: 0.95, passed: true, sample_n: 20, note: '0 facts on the wrong object' },
    ])
  })
})
