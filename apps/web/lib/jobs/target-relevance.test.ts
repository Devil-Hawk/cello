// The batch scorer used to pick candidates by `posted_at desc` alone, so every
// click spent metered LLM calls on whatever a watched company posted most
// recently. Measured against the live table: 35,109 jobs, only 7.2% mentioning
// AI/ML/GenAI/LLM, and `job_function = engineering` alone matching 12,924 rows.
// The user's description was exact: it "just scores randomly 25 jobs which you
// might be bad for".
//
// These tests pin the two properties that fix it without breaking anything:
// ordering puts on-target jobs first, and it is a strict NO-OP when the user
// has configured no target titles.

import { describe, expect, it } from 'vitest'
import {
  assessTargetRelevance,
  filterToTargets,
  prioritiseByTargetTitles,
  prepareTargets,
  MIN_INGEST_TITLE_SCORE,
} from './target-relevance'

const TARGETS = ['AI Engineer', 'Machine Learning Engineer']

describe('prioritiseByTargetTitles — spend on the promising jobs first', () => {
  it('moves on-target jobs ahead of unrelated ones', () => {
    const pool = [
      { title: 'Enterprise Account Executive' },
      { title: 'Regional Sales Manager' },
      { title: 'Senior AI Engineer' },
      { title: 'Payroll Specialist' },
    ]
    const out = prioritiseByTargetTitles(pool, TARGETS)
    expect(out[0].title).toBe('Senior AI Engineer')
  })

  it('is a strict no-op when no target titles are configured', () => {
    const pool = [{ title: 'Sales Lead' }, { title: 'AI Engineer' }, { title: 'Paralegal' }]
    expect(prioritiseByTargetTitles(pool, []).map((j) => j.title)).toEqual(pool.map((j) => j.title))
  })

  it('is stable — equal relevance keeps the incoming freshest-first order', () => {
    // Three equally-unrelated jobs must not be shuffled; the caller's pool is
    // already ordered by posted_at desc and that contract still holds within a
    // relevance band.
    const pool = [{ title: 'Paralegal' }, { title: 'Office Manager' }, { title: 'Bookkeeper' }]
    expect(prioritiseByTargetTitles(pool, TARGETS).map((j) => j.title)).toEqual([
      'Paralegal',
      'Office Manager',
      'Bookkeeper',
    ])
  })

  it('never drops a job — ordering only, so nothing goes unscored forever', () => {
    const pool = [
      { title: 'Enterprise Account Executive' },
      { title: 'Senior AI Engineer' },
      { title: 'Paralegal' },
    ]
    const out = prioritiseByTargetTitles(pool, TARGETS)
    expect(out).toHaveLength(pool.length)
    expect(new Set(out.map((j) => j.title))).toEqual(new Set(pool.map((j) => j.title)))
  })

  it('does not choke on null or empty titles', () => {
    const pool = [{ title: null }, { title: '' }, { title: 'AI Engineer' }]
    const out = prioritiseByTargetTitles(pool, TARGETS)
    expect(out).toHaveLength(3)
    expect(out[0].title).toBe('AI Engineer')
  })
})

describe('assessTargetRelevance — the ingest gate', () => {
  const targets = prepareTargets(TARGETS)

  it('keeps a clear title match and says which target matched', () => {
    const d = assessTargetRelevance({ title: 'Senior AI Engineer' }, targets)
    expect(d.keep).toBe(true)
    expect(d.score).toBeGreaterThanOrEqual(MIN_INGEST_TITLE_SCORE)
    expect(d.matchedTarget).toBeTruthy()
    expect(d.reason).toContain('matches')
  })

  it('drops an unrelated role in an unrelated function', () => {
    const d = assessTargetRelevance({ title: 'Paralegal', jobFunction: 'legal' }, targets)
    expect(d.keep).toBe(false)
    expect(d.reason).toContain('legal')
  })

  // The deliberate leak: unconventional titles for the right work must survive.
  // Only `keep` is asserted, not WHICH branch kept it — "Forward Deployed
  // Engineer" happens to clear the title threshold on the word "Engineer",
  // while "Member of Technical Staff" survives only via the function fallback.
  // Both outcomes are correct; pinning the branch would make this test fail on
  // a harmless threshold tweak.
  it('keeps an oddly-titled engineering role that a target title would never match', () => {
    for (const title of ['Member of Technical Staff', 'Forward Deployed Engineer', 'Research Scientist']) {
      const d = assessTargetRelevance({ title, jobFunction: 'engineering' }, targets)
      expect(d.keep, `${title} should survive`).toBe(true)
    }
  })

  it('the function fallback is what saves a title with no overlap at all', () => {
    const d = assessTargetRelevance({ title: 'Member of Technical Staff', jobFunction: 'engineering' }, targets)
    expect(d.keep).toBe(true)
    expect(d.reason).toContain('function')
  })

  it('keeps EVERYTHING when no targets are configured — an empty preference must never silently discard jobs', () => {
    for (const title of ['Paralegal', 'Sales Lead', 'AI Engineer']) {
      const d = assessTargetRelevance({ title, jobFunction: 'legal' }, [])
      expect(d.keep).toBe(true)
      expect(d.reason).toContain('no target titles configured')
    }
  })

  it('always explains itself', () => {
    for (const title of ['AI Engineer', 'Paralegal', '', null]) {
      expect(assessTargetRelevance({ title }, targets).reason.length).toBeGreaterThan(5)
    }
  })
})

describe('filterToTargets — countable, never silent', () => {
  it('reports what it dropped and why', () => {
    const jobs = [
      { title: 'Senior AI Engineer', jobFunction: 'engineering' },
      { title: 'Enterprise Account Executive', jobFunction: 'sales' },
      { title: 'Paralegal', jobFunction: 'legal' },
    ]
    const out = filterToTargets(jobs, TARGETS)
    expect(out.kept.map((j) => j.title)).toContain('Senior AI Engineer')
    expect(out.dropped).toBe(2)
    // A silent filter is indistinguishable from a broken scraper.
    expect(Object.keys(out.droppedReasons).length).toBeGreaterThan(0)
  })

  it('drops nothing when unconfigured', () => {
    const jobs = [{ title: 'Paralegal', jobFunction: 'legal' }]
    const out = filterToTargets(jobs, [])
    expect(out.dropped).toBe(0)
    expect(out.kept).toHaveLength(1)
  })
})
