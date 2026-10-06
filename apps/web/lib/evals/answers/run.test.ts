// The answers eval's four gates, as a test: the hand-labelled set stays inside its thresholds.

import { describe, expect, it } from 'vitest'
import { run } from './run'

describe('answers eval (S10)', () => {
  it('has the 120 labelled questions and passes its four gates', () => {
    const r = run()
    expect(r.questions).toBe(120)
    expect(r.misses.filter((m) => !m.includes('labelled'))).toEqual([])
    expect(r.modelAnswers).toBe(0)
    expect(r.nearPairsMatched).toBe(0)
    expect(r.wrongWorkAuth).toBe(0)
    expect(r.sensitiveRecall).toBeGreaterThanOrEqual(0.95)
    expect(r.passed).toBe(true)
  })
})
