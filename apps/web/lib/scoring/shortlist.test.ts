import { describe, expect, it } from 'vitest'
import { chanceClause, chooseShortlist, compareRankable, explainPick, pickExploration, toPicks, wantTier, type Rankable } from './shortlist'

function r(jobId: string, p: number, chance: Rankable['chance'] = 'possible', gaps: string[] = [], reason = 'Payments backend like the Stripe role you applied to.'): Rankable {
  return { jobId, p, chance, gaps, reason }
}

describe('wantTier', () => {
  it('names the band', () => {
    expect(wantTier(0.9)).toBe('high')
    expect(wantTier(0.5)).toBe('medium')
    expect(wantTier(0.1)).toBe('low')
  })
})

describe('compareRankable', () => {
  it('puts a likely-wanted role ahead of an unlikely one whatever its chance', () => {
    const wanted = r('a', 0.8, 'stretch')
    const lukewarm = r('b', 0.4, 'strong')
    expect([lukewarm, wanted].sort(compareRankable).map((x) => x.jobId)).toEqual(['a', 'b'])
  })

  it('orders by chance within a want band', () => {
    const strong = r('a', 0.7, 'strong')
    const possible = r('b', 0.9, 'possible')
    const stretch = r('c', 0.95, 'stretch')
    expect([stretch, possible, strong].sort(compareRankable).map((x) => x.jobId)).toEqual(['a', 'b', 'c'])
  })

  it('breaks ties on the probability then the id, so the order is stable', () => {
    expect([r('b', 0.7), r('a', 0.7), r('c', 0.8)].sort(compareRankable).map((x) => x.jobId)).toEqual(['c', 'a', 'b'])
  })
})

describe('chooseShortlist', () => {
  const pool = [
    r('t1', 0.9, 'strong'),
    r('t2', 0.85, 'possible'),
    r('t3', 0.8, 'strong'),
    r('t4', 0.75, 'possible'),
    r('t5', 0.7, 'possible'),
    r('t6', 0.68, 'possible'),
    r('u1', 0.5, 'possible'),
    r('u2', 0.2, 'strong'),
    r('hopeless', 0.5, 'stretch'),
  ]

  it('takes the best for the top picks and one exploration pick of the most uncertain role', () => {
    const picks = chooseShortlist(pool)
    expect(picks).toHaveLength(6)
    expect(picks.filter((p) => p.kind === 'top').map((p) => p.item.jobId)).toEqual(['t1', 't3', 't2', 't4', 't5'])
    const explore = picks.filter((p) => p.kind === 'explore')
    expect(explore).toHaveLength(1)
    expect(explore[0].item.jobId).toBe('u1')
  })

  it('never explores a role whose chance is a stretch', () => {
    expect(pickExploration([r('hopeless', 0.5, 'stretch')], new Set(), 1)).toEqual([])
  })

  it('never lists a role twice and never exceeds the size', () => {
    const picks = chooseShortlist(pool, { size: 3, exploreCount: 1 })
    expect(picks).toHaveLength(3)
    expect(new Set(picks.map((p) => p.item.jobId)).size).toBe(3)
  })

  it('returns what it has when the pool is small', () => {
    expect(chooseShortlist([r('only', 0.9)])).toHaveLength(1)
    expect(chooseShortlist([])).toEqual([])
  })

  it('keeps at least one top pick even when exploration is asked for everything', () => {
    const picks = chooseShortlist(pool, { size: 2, exploreCount: 5 })
    expect(picks.some((p) => p.kind === 'top')).toBe(true)
  })
})

describe('explanations', () => {
  it('is one sentence that names the reason and the chance', () => {
    const s = explainPick(r('a', 0.8, 'strong'), 'top')
    expect(s).toBe('Payments backend like the Stripe role you applied to, and your resume shows everything it asks for.')
    expect(s.match(/[.!?]/g)).toHaveLength(1)
  })

  it('names the specific gap for a possible or a stretch', () => {
    expect(chanceClause('possible', ['Kubernetes'])).toBe('it is within reach, though Kubernetes is not clearly on your resume')
    expect(chanceClause('stretch', ['Only partly shown: 8+ years of backend work'])).toBe('it is a stretch, since 8+ years of backend work is not on your resume')
    expect(chanceClause('stretch', [])).toBe('it is a stretch on what your resume shows')
  })

  it('is honest when the posting is too thin', () => {
    expect(chanceClause('cannot_assess', [])).toContain('too thin')
  })

  it('labels an exploration pick in the sentence itself', () => {
    expect(explainPick(r('a', 0.5, 'possible', [], 'You have not seen much healthcare yet.'), 'explore')).toMatch(/^Outside your usual picks: you have not seen/)
  })

  it('falls back to an honest line when the model gave no reason', () => {
    expect(explainPick(r('a', 0.5, 'strong', [], ''), 'top')).toMatch(/^Nothing you have said or done points to this one either way, and/)
  })

  it('numbers the picks from 1', () => {
    const picks = toPicks(chooseShortlist([r('a', 0.9, 'strong'), r('b', 0.8, 'strong')]))
    expect(picks.map((p) => p.position)).toEqual([1, 2])
  })
})
