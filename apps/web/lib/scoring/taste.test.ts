import { describe, expect, it } from 'vitest'
import { PRIOR_STRENGTH, blendWant, chooseTau, defaultWeights, fitBlend, kernelWant, toExamples } from './taste'
import type { PassReason, Predicted, Reaction, ReactionRecord } from './types'

function mulberry(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rec(partial: Partial<ReactionRecord> & { reaction: Reaction }): ReactionRecord {
  return {
    jobId: null,
    reason: null,
    title: 't',
    company: 'c',
    location: null,
    text: 't',
    embedding: null,
    embeddingModel: null,
    predicted: null,
    at: '2026-10-06T00:00:00Z',
    ...partial,
  }
}

describe('toExamples', () => {
  it('counts applied twice and ignores level, place and pay passes as taste', () => {
    const v = [1, 0]
    const ex = toExamples([
      rec({ reaction: 'interested', embedding: v }),
      rec({ reaction: 'applied', embedding: v }),
      rec({ reaction: 'not_for_me', reason: 'domain', embedding: v }),
      rec({ reaction: 'not_for_me', reason: null, embedding: v }),
      ...(['too_junior', 'too_senior', 'location', 'pay'] as PassReason[]).map((reason) =>
        rec({ reaction: 'not_for_me', reason, embedding: v })
      ),
      rec({ reaction: 'interested', embedding: null }),
    ])
    expect(ex.map((e) => [e.label, e.mass])).toEqual([
      [1, 1],
      [1, 2],
      [0, 1],
      [0, 1],
    ])
  })
})

describe('kernelWant', () => {
  const liked = { vec: [1, 0.1], label: 1 as const, mass: 1 }
  const passed = { vec: [0.1, 1], label: 0 as const, mass: 1 }

  it('is null with no examples', () => {
    expect(kernelWant([1, 0], [])).toBeNull()
  })

  it('leans toward the class a role resembles', () => {
    const ex = [liked, passed]
    expect(kernelWant([1, 0], ex)!).toBeGreaterThan(0.6)
    expect(kernelWant([0, 1], ex)!).toBeLessThan(0.4)
  })

  it('never reaches certainty from a single example', () => {
    const p = kernelWant([1, 0.1], [liked])!
    expect(p).toBeGreaterThan(0.5)
    expect(p).toBeLessThan(0.8)
  })

  it('counts an applied role more than a tap', () => {
    const tap = kernelWant([1, 0.1], [liked, { ...passed, vec: [1, 0.12] }])!
    const applied = kernelWant([1, 0.1], [{ ...liked, mass: 2 }, { ...passed, vec: [1, 0.12] }])!
    expect(applied).toBeGreaterThan(tap)
  })
})

describe('chooseTau', () => {
  it('keeps the default with too little history', () => {
    expect(chooseTau([{ vec: [1, 0], label: 1, mass: 1 }])).toBe(0.06)
  })
})

describe('default weights', () => {
  const all = { judge: true, embedding: true, stated: true }

  it('start with the stated preferences carrying most of the weight', () => {
    const w = defaultWeights(0, all)
    expect(w.stated).toBeCloseTo(1, 5)
  })

  it('give the stated preferences half their starting weight after PRIOR_STRENGTH reactions', () => {
    const w = defaultWeights(PRIOR_STRENGTH, all)
    expect(w.stated).toBeCloseTo(0.5, 5)
    expect(w.judge).toBeCloseTo(0.25, 5)
    expect(w.embedding).toBeCloseTo(0.25, 5)
  })

  it('fade toward the learned signals as reactions accumulate', () => {
    const a = defaultWeights(5, all).stated
    const b = defaultWeights(50, all).stated
    expect(b).toBeLessThan(a / 4)
  })

  it('renormalise over the signals that exist and always sum to 1', () => {
    const w = defaultWeights(10, { judge: true, embedding: false, stated: false })
    expect(w).toEqual({ judge: 1, embedding: 0, stated: 0 })
    const x = defaultWeights(10, all)
    expect(x.judge + x.embedding + x.stated).toBeCloseTo(1, 10)
  })
})

describe('blendWant', () => {
  it('is the stated read at cold start and moves to the learned signals with reactions', () => {
    const c = { judge: 0.9, embedding: 0.4, stated: 0.2 }
    const cold = blendWant(c, { kind: 'default', n0: PRIOR_STRENGTH }, 0)
        const warm = blendWant(c, { kind: 'default', n0: PRIOR_STRENGTH }, 200)
    expect(cold).toBeCloseTo(0.2, 3)
    expect(warm).toBeGreaterThan(0.5)
  })

  it('stays inside (0, 1) for extreme inputs', () => {
    const p = blendWant({ judge: 1, embedding: 1, stated: 1 }, { kind: 'default', n0: 5 }, 30)
    expect(p).toBeLessThan(1)
    expect(p).toBeGreaterThan(0.9)
  })
})

describe('fitBlend', () => {
  function history(n: number, signal: (y: number, rnd: () => number) => Predicted, seed = 1, base = 0.45) {
    const rnd = mulberry(seed)
    return Array.from({ length: n }, () => {
      const y = rnd() < base ? 1 : 0
      return rec({ reaction: y ? 'interested' : 'not_for_me', predicted: signal(y, rnd) })
    })
  }

  it('refuses below the minimum history and says why', () => {
    const r = fitBlend(history(10, () => ({ judge: 0.5, embedding: 0.5, stated: 0.5, blended: 0.5 })))
    expect(r.model.kind).toBe('default')
    expect(r.evidence.adopted).toBe(false)
    expect(r.evidence.reason).toMatch(/needs 20 reactions/)
  })

  it('refuses when one outcome is too rare', () => {
    const rnd = mulberry(7)
    const h = Array.from({ length: 30 }, (_, i) =>
      rec({ reaction: i < 2 ? 'interested' : 'not_for_me', predicted: { judge: rnd(), embedding: rnd(), stated: rnd(), blended: 0.5 } })
    )
    const r = fitBlend(h)
    expect(r.model.kind).toBe('default')
    expect(r.evidence.reason).toMatch(/at least 5 of each outcome/)
  })

  it('adopts a fitted blend that leans on the signal that actually predicts this person', () => {
    // judge is informative; the embedding is noise; the stated read is mildly informative
    const h = history(
      120,
      (y, rnd) => ({
        judge: y ? 0.55 + rnd() * 0.4 : 0.05 + rnd() * 0.4,
        embedding: 0.2 + rnd() * 0.6,
        stated: 0.3 + rnd() * 0.4 + (y ? 0.05 : 0),
        blended: 0.5,
      }),
      3
    )
    const r = fitBlend(h)
    expect(r.evidence.adopted).toBe(true)
    expect(r.model.kind).toBe('fitted')
    if (r.model.kind !== 'fitted') return
    expect(r.model.wJudge).toBeGreaterThan(r.model.wEmbedding)
    expect(r.evidence.cvFitted!).toBeLessThan(r.evidence.cvDefault!)
  })

  it('learns to ignore signals that carry no information about this person', () => {
    const h = history(60, (_y, rnd) => ({ judge: rnd(), embedding: rnd(), stated: rnd(), blended: 0.5 }), 11)
    const r = fitBlend(h)
    if (r.model.kind === 'fitted') {
      // Equal-weight averaging of noise is overconfident; the fit shrinks it toward the base rate.
      expect(Math.abs(r.model.wJudge) + Math.abs(r.model.wEmbedding) + Math.abs(r.model.wStated)).toBeLessThan(1)
    } else {
      expect(r.evidence.reason).toMatch(/did not beat the default/)
    }
  })

  it('ignores reactions that carry no prediction', () => {
    const h = history(40, () => ({ judge: 0.5, embedding: 0.5, stated: 0.5, blended: 0.5 }), 5).map((r) => ({ ...r, predicted: null }))
    expect(fitBlend(h).evidence.n).toBe(0)
  })
})
