// The central claim of relevance.ts is that "is this contact worth emailing?"
// has no fixed answer for an executive — it depends on whether the company is
// small enough to lack a recruiter. These tests pin exactly that: the SAME
// founder ranks first at a startup and near-last at a large company.

import { describe, expect, it } from 'vitest'
import {
  isSmallCompany,
  rankContactsForRole,
  scoreContactRelevance,
  SMALL_COMPANY_ROLE_CEILING,
  type RoleContext,
} from './relevance'

const ENG_ROLE_AT_BIGCO: RoleContext = {
  jobFunction: 'engineering',
  jobTitle: 'Senior Backend Engineer',
  openRoleCount: 240,
}

const ENG_ROLE_AT_STARTUP: RoleContext = {
  jobFunction: 'engineering',
  jobTitle: 'Senior Backend Engineer',
  openRoleCount: 4,
}

describe('company size decides whether an executive is worth contacting', () => {
  const ceo = { name: 'Patrick Collison', title: 'CEO' }

  it('ranks a CEO as peripheral at a large company', () => {
    const v = scoreContactRelevance(ceo, ENG_ROLE_AT_BIGCO)
    expect(v.bucket).toBe('peripheral')
    expect(v.score).toBeLessThan(0.3)
    expect(v.reason).toMatch(/large company|will not reach/i)
  })

  it('ranks the SAME CEO highly at a startup', () => {
    const v = scoreContactRelevance(ceo, ENG_ROLE_AT_STARTUP)
    expect(v.bucket).toBe('founder-small-co')
    expect(v.score).toBeGreaterThan(0.8)
    expect(v.reason).toMatch(/small company|hires directly/i)
  })

  it('treats a founder the same way as a CEO', () => {
    const founder = { name: 'Ada L', title: 'Co-Founder' }
    expect(scoreContactRelevance(founder, ENG_ROLE_AT_STARTUP).bucket).toBe('founder-small-co')
    expect(scoreContactRelevance(founder, ENG_ROLE_AT_BIGCO).bucket).toBe('peripheral')
  })

  it('treats unknown company size as small, so a startup founder is never buried', () => {
    expect(isSmallCompany(null)).toBe(true)
    const v = scoreContactRelevance({ name: 'X', title: 'Founder' }, {
      jobFunction: 'engineering',
      jobTitle: 'Backend Engineer',
      openRoleCount: null,
    })
    expect(v.bucket).toBe('founder-small-co')
    expect(v.reason).toMatch(/size unknown/i)
  })

  it('puts the size boundary where the ceiling says', () => {
    expect(isSmallCompany(SMALL_COMPANY_ROLE_CEILING)).toBe(true)
    expect(isSmallCompany(SMALL_COMPANY_ROLE_CEILING + 1)).toBe(false)
  })
})

describe('whoever owns the requisition outranks everyone', () => {
  it('puts a recruiter top even at a startup where the founder also scores high', () => {
    const ranked = rankContactsForRole(
      [
        { name: 'Founder Person', title: 'Co-Founder & CEO' },
        { name: 'Recruiter Person', title: 'Technical Recruiter' },
      ],
      ENG_ROLE_AT_STARTUP
    )
    expect(ranked[0].name).toBe('Recruiter Person')
    expect(ranked[0].relevance.bucket).toBe('hiring-path')
  })

  it('recognises a named hiring manager as the very top', () => {
    const v = scoreContactRelevance({ name: 'H M', title: 'Hiring Manager, Platform' }, ENG_ROLE_AT_BIGCO)
    expect(v.bucket).toBe('hiring-path')
    expect(v.score).toBeGreaterThan(0.95)
  })

  it('counts people/talent titles as the hiring path', () => {
    for (const title of ['Head of Talent', 'People Operations', 'Technical Sourcer', 'HR Business Partner']) {
      expect(scoreContactRelevance({ name: 'n', title }, ENG_ROLE_AT_BIGCO).bucket).toBe('hiring-path')
    }
  })
})

describe('function matching finds the manager and the future teammate', () => {
  it('treats an engineering leader as the likely hiring manager', () => {
    const v = scoreContactRelevance({ name: 'E L', title: 'Head of Engineering' }, ENG_ROLE_AT_BIGCO)
    expect(v.bucket).toBe('hiring-manager')
  })

  it('treats a same-function IC as a referral path', () => {
    const v = scoreContactRelevance({ name: 'I C', title: 'Backend Engineer' }, ENG_ROLE_AT_BIGCO)
    expect(v.bucket).toBe('future-teammate')
    expect(v.reason).toMatch(/refer/i)
  })

  it('does not mistake a leader in another function for the hiring manager', () => {
    const v = scoreContactRelevance({ name: 'S L', title: 'Director of Sales' }, ENG_ROLE_AT_BIGCO)
    expect(v.bucket).toBe('peripheral')
    expect(v.reason).toMatch(/different function/i)
  })

  it('matches on title overlap when the function is unknown', () => {
    const v = scoreContactRelevance(
      { name: 'P M', title: 'Head of Backend Platform' },
      { jobFunction: null, jobTitle: 'Backend Platform Engineer', openRoleCount: 200 }
    )
    expect(v.bucket).toBe('hiring-manager')
  })

  it('ignores seniority and formatting noise when comparing titles', () => {
    const v = scoreContactRelevance(
      { name: 'D', title: 'Design Lead' },
      { jobFunction: 'design', jobTitle: 'Senior Product Designer (m/w/d) — Remote', openRoleCount: 300 }
    )
    expect(['hiring-manager', 'future-teammate']).toContain(v.bucket)
  })
})

describe('honesty of the output', () => {
  it('always explains itself', () => {
    const cases = ['CEO', 'Recruiter', 'Backend Engineer', 'Director of Sales', '']
    for (const title of cases) {
      const v = scoreContactRelevance({ name: 'n', title }, ENG_ROLE_AT_BIGCO)
      expect(v.reason.length).toBeGreaterThan(10)
    }
  })

  it('handles a missing title without inventing a connection', () => {
    const v = scoreContactRelevance({ name: 'Someone', title: null }, ENG_ROLE_AT_STARTUP)
    expect(v.bucket).toBe('peripheral')
    expect(v.reason).toMatch(/no title/i)
  })

  it('orders a realistic mixed list the way a job seeker would want it', () => {
    const ranked = rankContactsForRole(
      [
        { name: 'Sales Director', title: 'Director of Sales' },
        { name: 'Backend IC', title: 'Senior Backend Engineer' },
        { name: 'Eng Leader', title: 'VP of Engineering' },
        { name: 'Recruiter', title: 'Technical Recruiter' },
        { name: 'Big Boss', title: 'Chief Executive Officer' },
      ],
      ENG_ROLE_AT_BIGCO
    )
    expect(ranked.map((r) => r.name)).toEqual([
      'Recruiter',
      'Eng Leader',
      'Backend IC',
      'Sales Director',
      'Big Boss',
    ])
  })
})
