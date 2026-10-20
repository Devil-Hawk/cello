import { describe, expect, it } from 'vitest'
import { decideModel, decideRuns } from './decide'

const model = (over: Record<string, unknown> = {}) => ({
  model: 'm:free',
  s14: { right: 25, cases: 32, errored: 0 },
  s21: { right: 30, cases: 12, errored: 0 },
  injection: { violations: [] as string[], errored: 0 },
  promptTokensPerTurn: 10000,
  ...over,
})

describe('decideModel', () => {
  it('picks plain only when it matches deep and sends 20 percent fewer tokens', () => {
    expect(decideModel(model(), model({ promptTokensPerTurn: 7000 })).pick).toBe('plain')
    expect(decideModel(model(), model({ promptTokensPerTurn: 9000 })).pick).toBe('deep')
  })
  it('keeps deep when most runs of either core errored', () => {
    const out = decideModel(model(), model({ promptTokensPerTurn: 1, s14: { right: 30, cases: 32, errored: 20 } }))
    expect(out.pick).toBe('deep')
    expect(out.why[0]).toMatch(/cannot be read/)
  })
})

describe('decideRuns', () => {
  const s14 = (right: number) => ({ right, cases: 32, errored: 0 })
  const run = (right: number, tokens: number, extra: Record<string, unknown> = {}) => model({ s14: s14(right), promptTokensPerTurn: tokens, ...extra })

  it('does not decide on one run of each core', () => {
    const out = decideRuns([run(20, 10000)], [run(30, 5000)])
    expect(out).toMatchObject({ pick: 'deep', decided: false })
    expect(out.why.join(' ')).toMatch(/1 deep and 1 plain/)
  })

  it('does not decide when the gap between the cores sits inside the spread of the runs', () => {
    // Plain's mean is higher, but deep itself moved from 15 to 21 between runs.
    const out = decideRuns([run(15, 10000), run(21, 10000)], [run(17, 5000), run(18, 5000)])
    expect(out).toMatchObject({ pick: 'deep', decided: false })
    expect(out.why.join(' ')).toMatch(/S14 ranges overlap \(deep 15 to 21, plain 17 to 18\)/)
  })

  it('picks plain when it is clearly ahead on both numbers and lighter', () => {
    const out = decideRuns([run(15, 10000, { s21: { right: 3, cases: 12, errored: 0 } }), run(16, 10000, { s21: { right: 4, cases: 12, errored: 0 } })], [run(24, 5000, { s21: { right: 8, cases: 12, errored: 0 } }), run(25, 5000, { s21: { right: 9, cases: 12, errored: 0 } })])
    expect(out).toMatchObject({ pick: 'plain', decided: true })
  })

  it('keeps deep, decided, when plain is clearly behind', () => {
    expect(decideRuns([run(25, 10000), run(26, 10000)], [run(15, 5000), run(16, 5000)])).toMatchObject({ pick: 'deep', decided: true })
  })

  it('counts a violation in any plain run', () => {
    const bad = run(25, 5000, { injection: { violations: ['i1: called x'], errored: 0 } })
    expect(decideRuns([run(25, 10000), run(25, 10000)], [run(25, 5000), bad]).pick).toBe('deep')
  })

  it('refuses to compare when any run mostly errored', () => {
    const out = decideRuns([run(25, 10000), run(25, 10000)], [run(25, 5000), run(25, 5000, { s14: { right: 5, cases: 32, errored: 20 } })])
    expect(out).toMatchObject({ pick: 'deep', decided: false })
    expect(out.why[0]).toMatch(/cannot be read/)
  })
})
