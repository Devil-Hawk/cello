import { describe, expect, it } from 'vitest'
import { agreement, auc, brier, cohenKappa, mulberry32, precisionAtK, stratifiedSplit } from './metrics'

describe('metrics', () => {
  it('precision at k counts wanted roles in the top k', () => {
    expect(precisionAtK(['a', 'b', 'c', 'd', 'e', 'f'], new Set(['a', 'c', 'f']), 5)).toBeCloseTo(0.4)
    expect(precisionAtK([], new Set(['a']), 5)).toBe(0)
  })

  it('brier is 0 for perfect and 0.25 for always-half', () => {
    expect(brier([1, 0], [1, 0])).toBe(0)
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25)
  })

  it('auc is 1 for a perfect ranking and 0.5 for ties', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1)
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5)
  })

  it('kappa is 1 for identical labels, near 0 for chance agreement, and ignores raw agreement from a lopsided base rate', () => {
    expect(cohenKappa(['x', 'y', 'x', 'y'], ['x', 'y', 'x', 'y'])).toBe(1)
    // 9 of 10 agree, but both say "x" almost always: kappa is far below 0.9.
    const a = ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'y']
    const b = ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'y', 'x']
    expect(agreement(a, b)).toBe(0.8)
    expect(cohenKappa(a, b)).toBeLessThan(0.1)
  })

  it('a stratified split is repeatable and keeps each group on both sides', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: i, g: i % 2 ? 'a' : 'b' }))
    const s1 = stratifiedSplit(items, (x) => x.g, 0.4, mulberry32(42))
    const s2 = stratifiedSplit(items, (x) => x.g, 0.4, mulberry32(42))
    expect(s1.heldOut.map((x) => x.id)).toEqual(s2.heldOut.map((x) => x.id))
    expect(s1.heldOut.length).toBe(16)
    expect(new Set(s1.heldOut.map((x) => x.g)).size).toBe(2)
    expect(s1.stream.length + s1.heldOut.length).toBe(40)
  })
})
