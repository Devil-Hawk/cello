import { describe, expect, it } from 'vitest'
import {
  hasRelevanceTerms,
  isRelevantJob,
  parseRelevanceQuery,
  rankJobsByRelevance,
  scoreJobRelevance,
} from './relevance'

describe('parseRelevanceQuery', () => {
  it('drops filler words and keeps real terms', () => {
    const q = parseRelevanceQuery('Show me the latest AI Engineer roles')
    expect(q.concepts.map((c) => c.display)).toEqual(['ai', 'engineer'])
  })

  it('is empty for an empty or all-stopword query', () => {
    expect(parseRelevanceQuery('').concepts).toEqual([])
    expect(parseRelevanceQuery('the roles please').concepts).toEqual([])
    expect(hasRelevanceTerms('')).toBe(false)
    expect(hasRelevanceTerms('the roles please')).toBe(false)
    expect(hasRelevanceTerms('AI Engineer')).toBe(true)
  })

  it('expands a synonym term into its group forms', () => {
    const q = parseRelevanceQuery('ai engineer')
    const aiConcept = q.concepts.find((c) => c.display === 'ai')
    expect(aiConcept?.tokens).toContain('ai')
    expect(aiConcept?.phrases).toContain('artificial intelligence')
  })
})

describe('scoreJobRelevance — the ai/go substring bug this module exists to fix', () => {
  // ILIKE '%ai%' would have matched all of these on substring alone; none of
  // them contain "ai" as a standalone word.
  it('does not match "ai" against words that merely contain the substring', () => {
    const decoys = [
      { title: 'Email Marketing Specialist' },
      { title: 'Detail-Oriented Data Entry Clerk' },
      { title: 'Chairman of the Board — Executive Assistant' },
      { title: 'Maintenance Technician' },
    ]
    for (const job of decoys) {
      expect(scoreJobRelevance(job, 'ai roles').score).toBe(0)
    }
  })

  it('does not match "go" against words that merely contain the substring', () => {
    const decoys = [
      { title: 'Software Engineer, Google Cloud Partnerships' },
      { title: 'Diego Regional Sales Manager' },
      { title: 'Algorithm Research Scientist' },
      { title: 'Chicago Office Coordinator' },
    ]
    for (const job of decoys) {
      expect(scoreJobRelevance(job, 'go developer').score).toBe(0)
    }
  })

  it('matches "ai" and "go" as real standalone-word titles', () => {
    expect(scoreJobRelevance({ title: 'AI Engineer' }, 'ai roles').score).toBeGreaterThan(0)
    expect(scoreJobRelevance({ title: 'Go Backend Developer' }, 'go developer').score).toBeGreaterThan(0)
  })
})

describe('scoreJobRelevance — ranking behavior', () => {
  it('ranks a title match above a description-only match', () => {
    const titleMatch = scoreJobRelevance({ title: 'AI Engineer', description: 'Build things.' }, 'ai engineer')
    const descOnlyMatch = scoreJobRelevance(
      { title: 'Software Engineer', description: 'You will work closely with our AI engineer team.' },
      'ai engineer'
    )
    expect(titleMatch.score).toBeGreaterThan(descOnlyMatch.score)
    expect(descOnlyMatch.score).toBeGreaterThan(0)
  })

  it('matches via synonym expansion in either direction', () => {
    const spelledOut = scoreJobRelevance({ title: 'Artificial Intelligence Engineer' }, 'ai engineer')
    const abbreviated = scoreJobRelevance({ title: 'AI Engineer' }, 'artificial intelligence engineer')
    expect(spelledOut.score).toBeGreaterThan(0)
    expect(abbreviated.score).toBeGreaterThan(0)
  })

  it('scores 0 for a job that matches none of the query concepts', () => {
    const m = scoreJobRelevance({ title: 'Enterprise Account Executive', description: 'Own the sales cycle.' }, 'ai engineer')
    expect(m.score).toBe(0)
    expect(m.titleHits).toEqual([])
    expect(m.descriptionHits).toEqual([])
  })

  it('an empty query matches nothing scored (0), but isRelevantJob treats it as no-filter', () => {
    expect(scoreJobRelevance({ title: 'Anything' }, '').score).toBe(0)
    expect(isRelevantJob({ title: 'Anything' }, '')).toBe(true)
  })
})

describe('rankJobsByRelevance', () => {
  it('ranks AI-Engineer-related jobs above unrelated jobs for an AI Engineer query', () => {
    const jobs = [
      { title: 'Enterprise Account Executive', description: 'Own the full sales cycle for enterprise deals.' },
      { title: 'Senior Recruiter, Technical', description: 'Source and screen engineering candidates.' },
      { title: 'AI Engineer - Forward Deployed', description: 'Build LLM-powered agents for customers.' },
      { title: 'Regional Sales Manager', description: null },
      { title: 'Senior Machine Learning Engineer', description: 'Train and ship ML models in production.' },
      { title: 'Office Coordinator', description: 'Manage front-desk operations.' },
    ]
    const ranked = rankJobsByRelevance(jobs, 'AI Engineer')
    const titles = ranked.map((r) => r.job.title)

    // Both AI/ML-related jobs must outrank every unrelated job.
    const aiIndex = titles.indexOf('AI Engineer - Forward Deployed')
    const mlIndex = titles.indexOf('Senior Machine Learning Engineer')
    const unrelatedIndices = titles
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !['AI Engineer - Forward Deployed', 'Senior Machine Learning Engineer'].includes(t as string))
      .map(({ i }) => i)

    for (const i of unrelatedIndices) {
      expect(aiIndex).toBeLessThan(i)
      expect(mlIndex).toBeLessThan(i)
    }
    expect(ranked[0].relevance.score).toBeGreaterThan(0)
  })

  it('is stable (preserves original order) for ties', () => {
    const jobs = [{ title: 'AI Engineer A' }, { title: 'AI Engineer B' }, { title: 'AI Engineer C' }]
    const ranked = rankJobsByRelevance(jobs, 'ai engineer')
    expect(ranked.map((r) => r.job.title)).toEqual(['AI Engineer A', 'AI Engineer B', 'AI Engineer C'])
  })

  it('handles null/undefined title and description without throwing', () => {
    const jobs = [{ title: null, description: undefined }, { title: 'AI Engineer' }]
    expect(() => rankJobsByRelevance(jobs, 'ai engineer')).not.toThrow()
  })
})

describe('scoreJobRelevance — generic-role-noun dilution and AI-family cross-linking', () => {
  // The live defect: 'engineer' alone satisfied half of a 2-concept "AI
  // Engineer" query, tying a totally unrelated generic-Engineer title against
  // a genuine AI-relevant one (both scored 50) because (a) 'engineer' carried
  // the same weight as 'ai' and (b) 'ai' had no link to the separate
  // 'ml'/'machine learning' synonym group.
  it('no longer ties a generic-Engineer title with an AI-relevant one', () => {
    const generic = scoreJobRelevance({ title: 'Principal Software Engineer' }, 'AI Engineer')
    const aiRelevant = scoreJobRelevance({ title: 'AI Engineer - Forward Deployed' }, 'AI Engineer')
    expect(generic.score).toBeLessThan(aiRelevant.score)
  })

  it('credits "Machine Learning Engineer" for an "AI Engineer" query well above a generic Engineer title', () => {
    const generic = scoreJobRelevance({ title: 'Principal Software Engineer' }, 'AI Engineer')
    const mlEngineer = scoreJobRelevance(
      { title: 'Senior Machine Learning Engineer - Bees Data' },
      'AI Engineer'
    )
    expect(mlEngineer.score).toBeGreaterThan(generic.score)
    // Was a literal tie at 50/50 before the fix — must not still be equal.
    expect(mlEngineer.score).not.toBe(generic.score)
  })

  it('does not let "Engineer" alone pull unrelated generic-Engineer titles into a same-tier match as real AI/ML roles', () => {
    const decoys = [
      { title: 'Sr. Forward Deployed Engineer' },
      { title: 'Senior DevOps Engineer' },
      { title: 'Research Engineer Intern' },
    ]
    const real = [
      { title: 'AI Engineer' },
      { title: 'Machine Learning Engineer' },
    ]
    const decoyScores = decoys.map((d) => scoreJobRelevance(d, 'AI Engineer').score)
    const realScores = real.map((r) => scoreJobRelevance(r, 'AI Engineer').score)
    for (const d of decoyScores) {
      for (const r of realScores) {
        expect(d).toBeLessThan(r)
      }
    }
  })
})
