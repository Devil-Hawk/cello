// The title-word filter the one judge (lib/roles/keep.ts) uses while role_types_live is off.
// It is a strict NO-OP when the user has configured no target titles.

import { describe, expect, it } from 'vitest'
import {
  assessTargetRelevance,
  filterToTargets,
  prepareTargets,
  MIN_INGEST_TITLE_SCORE,
} from './target-relevance'

const TARGETS = ['AI Engineer', 'Machine Learning Engineer']

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
