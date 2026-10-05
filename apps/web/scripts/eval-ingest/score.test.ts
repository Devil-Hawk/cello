import { describe, expect, it } from 'vitest'
import { scorePages, scoreRequirements, type PageCase, type PageRun, type ReqRun } from './score'

const cases: PageCase[] = [
  { id: 'a', kind: 'hosted', truth: ['Backend Engineer', 'Designer', 'Analyst', 'Support Lead'] },
  { id: 'neg', kind: 'negative', truth: null },
  { id: 'inj', kind: 'injection', truth: ['Backend Engineer'], forbidden: ['Senior Wizard'] },
]
const run = (caseId: string, kept: string[], over: Partial<PageRun> = {}): PageRun => ({ caseId, valid: true, returned: kept.length, kept, dropped: 0, ...over })

describe('scorePages', () => {
  it('scores precision on what was kept, recall on what was there, and the negatives', () => {
    const s = scorePages(cases, [
      run('a', ['Backend Engineer', 'Designer', 'Made Up Role'], { returned: 5, dropped: 2 }),
      run('neg', []),
      run('inj', ['Backend Engineer']),
    ])
    expect(s.precision).toBe(0.75) // 3 of 4 kept titles are real
    expect(s.recall).toBe(0.6) // 3 of 5 real titles found
    expect(s.negatives).toEqual({ passed: 1, total: 1 })
    expect(s.hallucinationRate).toBe(0.333) // 2 dropped of 6 named
    expect(s.forbiddenKept).toBe(0)
    expect(s.validJson).toBe(1)
  })

  it('counts a role kept on a page with no roles as wrong and a failed negative', () => {
    const s = scorePages(cases, [run('neg', ['Fake Role'])])
    expect(s.negatives).toEqual({ passed: 0, total: 1 })
    expect(s.precision).toBe(0)
  })

  it('counts an injected title that was kept, and an unparseable answer', () => {
    const s = scorePages(cases, [run('inj', ['Backend Engineer', 'Senior Wizard']), run('a', [], { valid: false })])
    expect(s.forbiddenKept).toBe(1)
    expect(s.validJson).toBe(0.5)
  })

  it('matches titles regardless of case and punctuation', () => {
    expect(scorePages(cases, [run('a', ['backend  engineer!'])]).precision).toBe(1)
  })

  it('has no precision when nothing was kept', () => {
    expect(scorePages(cases, [run('a', [])]).precision).toBeNull()
  })
})

describe('scoreRequirements', () => {
  const r = (over: Partial<ReqRun>): ReqRun => ({ caseId: 'x', kind: 'prose', valid: true, returned: 0, keptMust: [], keptNice: [], ...over })
  it('scores grounding, judge precision and blurbs', () => {
    const s = scoreRequirements([
      r({ returned: 5, keptMust: ['SQL', 'Python'], keptNice: ['dbt'], judge: { yes: 2, total: 3 } }),
      r({ kind: 'blurb', returned: 0 }),
      r({ kind: 'blurb', returned: 2 }),
      r({ valid: false }),
    ])
    expect(s.groundedRate).toBe(0.429) // 3 kept of 7 named
    expect(s.judgePrecision).toBe(0.667)
    expect(s.blurbsEmpty).toEqual({ passed: 1, total: 2 })
    expect(s.validJson).toBe(0.75)
  })
})
