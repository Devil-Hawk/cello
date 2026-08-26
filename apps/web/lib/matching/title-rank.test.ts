import { describe, expect, it } from 'vitest'
import {
  parseTitle,
  rankJobsByTargetTitles,
  scoreTitleAgainstTarget,
  scoreTitleAgainstTargets,
} from './title-rank'

describe('parseTitle', () => {
  it('treats every separator style as the same title', () => {
    const stems = (s: string) => parseTitle(s).words.map((w) => w.stem)
    const expected = stems('Software Engineer Backend')
    expect(stems('Software Engineer - Backend')).toEqual(expected)
    expect(stems('Software Engineer / Backend')).toEqual(expected)
    expect(stems('Software Engineer, Backend')).toEqual(expected)
    expect(stems('Software Engineer (Backend)')).toEqual(expected)
  })

  it('drops grammatical filler so "Head of Data" reads as "Head Data"', () => {
    expect(parseTitle('Head of Data').words.map((w) => w.display)).toEqual(['head', 'data'])
  })

  it('counts only non-seniority words as core', () => {
    expect(parseTitle('Senior Staff Data Scientist').coreCount).toBe(2)
    // A title that is nothing but a level has no core words at all, which is
    // what makes it unusable as a target.
    expect(parseTitle('Senior').coreCount).toBe(0)
  })
})

describe('scoreTitleAgainstTarget', () => {
  it('scores an exact match 100', () => {
    expect(scoreTitleAgainstTarget('Senior Product Designer', 'Senior Product Designer').score).toBe(100)
  })

  it('is case-insensitive', () => {
    expect(scoreTitleAgainstTarget('SENIOR PRODUCT DESIGNER', 'senior product designer').score).toBe(100)
  })

  it('barely penalises a seniority variation in either direction', () => {
    // The user wants the role, not the level. Both of these are "the job".
    const targetHasLevel = scoreTitleAgainstTarget('Product Designer', 'Senior Product Designer')
    const jobHasLevel = scoreTitleAgainstTarget('Senior Product Designer', 'Product Designer')
    expect(targetHasLevel.score).toBeGreaterThanOrEqual(90)
    expect(jobHasLevel.score).toBeGreaterThanOrEqual(90)
    // ...and an exact hit still edges out the variation, so level is a
    // tiebreaker rather than something the ranking ignores entirely.
    const exact = scoreTitleAgainstTarget('Senior Product Designer', 'Senior Product Designer')
    expect(exact.score).toBeGreaterThanOrEqual(targetHasLevel.score)
  })

  it('reads abbreviated seniority as the same level', () => {
    expect(scoreTitleAgainstTarget('Sr. Product Designer', 'Senior Product Designer').score).toBe(100)
    expect(scoreTitleAgainstTarget('Jr Data Analyst', 'Junior Data Analyst').score).toBe(100)
  })

  it('scores a multi-word partial match in the middle, above nothing and below exact', () => {
    const partial = scoreTitleAgainstTarget('Data Engineer', 'Senior Machine Learning Engineer')
    const exact = scoreTitleAgainstTarget('Senior Machine Learning Engineer', 'Senior Machine Learning Engineer')
    expect(partial.score).toBeGreaterThan(0)
    expect(partial.score).toBeLessThan(exact.score)
    expect(partial.matchedWords).toContain('engineer')
  })

  it('scores an unrelated title 0', () => {
    const match = scoreTitleAgainstTarget('Warehouse Associate', 'Product Designer')
    expect(match.score).toBe(0)
    expect(match.target).toBeNull()
    expect(match.matchedWords).toEqual([])
  })

  it('never lets a shared seniority word alone count as a match', () => {
    // Both titles say "Senior". That is not a reason to surface a marketing
    // job to someone targeting data science.
    expect(scoreTitleAgainstTarget('Senior Marketing Manager', 'Senior Data Scientist').score).toBe(0)
  })

  it('ranks a strong partial above a weak one', () => {
    const strong = scoreTitleAgainstTarget('Staff Data Scientist, Search', 'Senior Data Scientist')
    const weak = scoreTitleAgainstTarget('Data Center Technician', 'Senior Data Scientist')
    expect(strong.score).toBeGreaterThan(weak.score)
    expect(weak.score).toBeGreaterThan(0)
  })

  it('prefers the tighter title when both cover the target', () => {
    const tight = scoreTitleAgainstTarget('Data Scientist', 'Data Scientist')
    const noisy = scoreTitleAgainstTarget('Data Scientist, Trust & Safety Platform Operations', 'Data Scientist')
    expect(tight.score).toBeGreaterThan(noisy.score)
    // ...but the noisy one is still obviously the job, not a near-miss.
    expect(noisy.score).toBeGreaterThanOrEqual(80)
  })

  it('matches across word forms via stemming', () => {
    expect(scoreTitleAgainstTarget('Software Developer', 'Software Development Engineer').score).toBeGreaterThan(0)
    expect(scoreTitleAgainstTarget('Engineering Manager', 'Engineer Manager').score).toBe(100)
  })

  it('treats a spelled-out AI/ML phrase and its abbreviation as the same title', () => {
    expect(scoreTitleAgainstTarget('ML Engineer', 'Machine Learning Engineer').score).toBe(100)
    expect(scoreTitleAgainstTarget('Artificial Intelligence Engineer', 'AI Engineer').score).toBe(100)
  })

  it('returns 0 for a target with no core words, rather than matching everything', () => {
    expect(scoreTitleAgainstTarget('Senior Data Scientist', 'Senior').score).toBe(0)
    expect(scoreTitleAgainstTarget('Senior Data Scientist', '   ').score).toBe(0)
  })

  it('returns 0 for a job with no usable title', () => {
    expect(scoreTitleAgainstTarget(null, 'Data Scientist').score).toBe(0)
    expect(scoreTitleAgainstTarget(undefined, 'Data Scientist').score).toBe(0)
    expect(scoreTitleAgainstTarget('', 'Data Scientist').score).toBe(0)
  })
})

describe('scoreTitleAgainstTargets', () => {
  it('takes the best target and names it, not the average', () => {
    const match = scoreTitleAgainstTargets('Senior Data Engineer', [
      'Product Manager',
      'Data Engineer',
      'UX Researcher',
    ])
    expect(match.score).toBeGreaterThanOrEqual(90)
    expect(match.target).toBe('Data Engineer')
  })

  it('handles an arbitrary number of targets', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Role Number ${i}`)
    many.push('Staff Product Designer')
    const match = scoreTitleAgainstTargets('Product Designer', many)
    expect(match.target).toBe('Staff Product Designer')
    expect(match.score).toBeGreaterThanOrEqual(90)
  })

  it('scores 0 against an empty target list', () => {
    const match = scoreTitleAgainstTargets('Senior Data Scientist', [])
    expect(match.score).toBe(0)
    expect(match.target).toBeNull()
  })
})

describe('rankJobsByTargetTitles', () => {
  const jobs = [
    { id: 'a', title: 'Warehouse Associate' },
    { id: 'b', title: 'Data Engineer' },
    { id: 'c', title: 'Office Manager' },
    { id: 'd', title: 'Senior Data Engineer' },
    { id: 'e', title: 'Data Analyst' },
  ]

  it('puts target matches first and keeps non-matches in their original order', () => {
    const ranked = rankJobsByTargetTitles(jobs, ['Data Engineer'])
    const ids = ranked.map((r) => r.job.id)
    // b and d both fully cover the target, so the incoming order decides
    // between them; e is a partial; a and c never matched and stay put.
    expect(ids.slice(0, 2)).toEqual(['b', 'd'])
    expect(ids[2]).toBe('e')
    expect(ids.slice(3)).toEqual(['a', 'c'])
  })

  it('never drops a job — it ranks, it does not filter', () => {
    const ranked = rankJobsByTargetTitles(jobs, ['Data Engineer'])
    expect(ranked).toHaveLength(jobs.length)
    expect(ranked.filter((r) => r.titleMatch.score === 0)).toHaveLength(2)
  })

  it('preserves the caller ordering exactly when no titles are configured', () => {
    const ranked = rankJobsByTargetTitles(jobs, [])
    expect(ranked.map((r) => r.job.id)).toEqual(jobs.map((j) => j.id))
    expect(ranked.every((r) => r.titleMatch.score === 0 && r.titleMatch.target === null)).toBe(true)
  })

  it('preserves the caller ordering when every configured title is unusable', () => {
    const ranked = rankJobsByTargetTitles(jobs, ['', '   ', 'Senior'])
    expect(ranked.map((r) => r.job.id)).toEqual(jobs.map((j) => j.id))
  })

  it('reports which target each job matched, so the UI can explain the order', () => {
    const ranked = rankJobsByTargetTitles(jobs, ['Office Manager', 'Data Engineer'])
    const byId = new Map(ranked.map((r) => [r.job.id, r.titleMatch]))
    expect(byId.get('b')?.target).toBe('Data Engineer')
    expect(byId.get('c')?.target).toBe('Office Manager')
    expect(byId.get('a')?.target).toBeNull()
  })

  it('is stable across repeated calls (pure and deterministic)', () => {
    const first = rankJobsByTargetTitles(jobs, ['Data Engineer', 'Office Manager'])
    const second = rankJobsByTargetTitles(jobs, ['Data Engineer', 'Office Manager'])
    expect(first.map((r) => r.job.id)).toEqual(second.map((r) => r.job.id))
  })

  it('does not mutate the array it was given', () => {
    const input = [...jobs]
    rankJobsByTargetTitles(input, ['Data Engineer'])
    expect(input.map((j) => j.id)).toEqual(jobs.map((j) => j.id))
  })
})
