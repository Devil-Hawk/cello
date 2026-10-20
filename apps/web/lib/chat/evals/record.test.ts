import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { chatReady, recordMeasure, recordS14, recordS21 } from './record'

const run = (measure: string, passed: boolean | null, ranAt: string, note?: string) => ({ measure_id: measure, passed, ran_at: ranAt, ...(note === undefined ? {} : { note }) })

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

describe('chatReady across tiers and cores', () => {
  const old = '2026-10-05T10:00:00Z'
  const newer = '2026-10-10T10:00:00Z'
  const freeDeep = 'tier=free model=m core=deep prompt_tokens=900; injection=0'
  const base = (note?: string) => ['S13', 'S14', 'S15', 'S21'].map((m) => run(m, true, old, note))

  it('is not made ready by a newer passing paid row, and not unready by a newer failing one', async () => {
    const notReady = makeFakeAdmin({ measure_runs: [...base(freeDeep).map((r) => ({ ...r, passed: r.measure_id === 'S14' ? false : true })), run('S14', true, newer, 'tier=paid model=p core=deep')] })
    expect((await chatReady(notReady)).sentence).toBe('Not ready. Not passing: S14.')
    const ready = makeFakeAdmin({ measure_runs: [...base(freeDeep), run('S14', false, newer, 'tier=paid model=p core=deep'), run('S21', false, newer, 'tier=local model=q core=deep')] })
    expect((await chatReady(ready)).ready).toBe(true)
  })

  it('is not made ready by a newer plain-core pass', async () => {
    const db = makeFakeAdmin({ measure_runs: [run('S13', true, old), run('S15', true, old), run('S21', true, old), run('S14', false, old, freeDeep), run('S14', true, newer, 'tier=free model=m core=plain')] })
    expect((await chatReady(db)).sentence).toBe('Not ready. Not passing: S14.')
  })

  it('is ready on a free deep pass, even with a newer paid failure', async () => {
    const db = makeFakeAdmin({ measure_runs: [...base(old), run('S14', true, '2026-10-08T10:00:00Z', freeDeep), run('S14', false, newer, 'tier=paid model=p core=deep')] })
    expect((await chatReady(db)).ready).toBe(true)
  })

  it('counts legacy rows with no note, and rows with a note but no tier', async () => {
    const db = makeFakeAdmin({ measure_runs: [run('S13', true, old), run('S14', true, old, '0 facts on the wrong object'), run('S15', true, old), run('S21', true, old, 'tier=free model=m core=deep')] })
    expect((await chatReady(db)).ready).toBe(true)
  })

  it('says no run yet when only paid or plain rows exist', async () => {
    const db = makeFakeAdmin({ measure_runs: [run('S13', true, old), run('S15', true, old), run('S21', true, old), run('S14', true, old, 'tier=paid model=p core=deep')] })
    expect((await chatReady(db)).sentence).toBe('Not ready. No run yet: S14.')
  })

  it('finds the free deep run behind many newer paid rows', async () => {
    const paid = Array.from({ length: 30 }, (_, i) => run('S14', false, `2026-10-${String(10 + (i % 10)).padStart(2, '0')}T0${i % 10}:00:00Z`, 'tier=paid model=p core=deep'))
    const db = makeFakeAdmin({ measure_runs: [...base(old), ...paid] })
    expect((await chatReady(db)).ready).toBe(true)
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

  it('prefixes S21\'s note with the run meta when given', async () => {
    const db = makeFakeAdmin({ measure_runs: [] })
    await recordS21(db, { parts: 20, right: 19, share: 0.95, wrongObjectFacts: 0, passed: true }, { tier: 'free', model: 'a/b:free', core: 'deep', promptTokens: 1200 })
    expect(db.tables.measure_runs[0]).toMatchObject({ note: 'tier=free model=a/b:free core=deep prompt_tokens=1200; 0 facts on the wrong object' })
  })

  it('writes one S14 row from the score and the injection run', async () => {
    const db = makeFakeAdmin({ measure_runs: [] })
    const score = { cases: 20, right: 17, errored: 0, overall: 0.85, passed: true }
    const meta = { tier: 'free', model: 'a/b:free', core: 'deep', promptTokens: 1834 } as const
    expect(await recordS14(db, score, { cases: 4, violations: [], errored: 0, passed: true }, meta)).toBe(true)
    expect(await recordS14(db, score, { cases: 4, violations: ['i1: called x', 'i2: said y'], errored: 0, passed: false }, meta)).toBe(true)
    expect(db.tables.measure_runs).toMatchObject([
      { measure_id: 'S14', value: 0.85, passed: true, sample_n: 20, note: 'tier=free model=a/b:free core=deep prompt_tokens=1834; injection=0' },
      { measure_id: 'S14', value: 0.85, passed: false, sample_n: 20, note: 'tier=free model=a/b:free core=deep prompt_tokens=1834; injection=2' },
    ])
  })

  it('writes no value for a number that cannot be read', async () => {
    const db = makeFakeAdmin({ measure_runs: [] })
    await recordS14(db, { cases: 20, right: 3, errored: 15, overall: null, passed: false }, { cases: 4, violations: [], errored: 0, passed: true }, { tier: 'free', model: 'm', core: 'deep' })
    expect(db.tables.measure_runs[0]).toMatchObject({ value: null, passed: false })
  })
})
