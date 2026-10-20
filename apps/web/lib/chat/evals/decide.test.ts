import { describe, expect, it } from 'vitest'
import { decideModel } from './decide'

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
