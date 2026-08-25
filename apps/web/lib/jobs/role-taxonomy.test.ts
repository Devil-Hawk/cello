import { describe, expect, it } from 'vitest'
import {
  ROLE_TAXONOMY,
  classifyTitleForIntent,
  getRoleIntent,
  keywordsForIntent,
  resolveRoleIntent,
} from './role-taxonomy'

describe('resolveRoleIntent', () => {
  it('resolves the canonical phrasing for each taxonomy entry', () => {
    expect(resolveRoleIntent('SWE - AI/ML')?.id).toBe('swe-ai-ml')
    expect(resolveRoleIntent('AI Engineer')?.id).toBe('ai-engineer')
    expect(resolveRoleIntent('Machine Learning Engineer')?.id).toBe('ml-engineer')
    expect(resolveRoleIntent('Data Scientist')?.id).toBe('data-scientist')
    expect(resolveRoleIntent('Data Engineer')?.id).toBe('data-engineer')
    expect(resolveRoleIntent('Data Analyst')?.id).toBe('data-analyst')
    expect(resolveRoleIntent('Backend Engineer')?.id).toBe('swe-backend')
    expect(resolveRoleIntent('Frontend Engineer')?.id).toBe('swe-frontend')
    expect(resolveRoleIntent('Full Stack Engineer')?.id).toBe('swe-fullstack')
    expect(resolveRoleIntent('iOS Engineer')?.id).toBe('mobile-engineer')
    expect(resolveRoleIntent('Site Reliability Engineer')?.id).toBe('devops-sre')
    expect(resolveRoleIntent('Security Engineer')?.id).toBe('security-engineer')
    expect(resolveRoleIntent('QA Engineer')?.id).toBe('qa-engineer')
    expect(resolveRoleIntent('Product Manager')?.id).toBe('product-manager')
  })

  it('is order-independent — "AI/ML SWE" and "SWE - AI/ML" resolve the same', () => {
    expect(resolveRoleIntent('AI/ML SWE')?.id).toBe('swe-ai-ml')
    expect(resolveRoleIntent('SWE - AI/ML')?.id).toBe('swe-ai-ml')
    expect(resolveRoleIntent('find me 10 SWE AI/ML roles')?.id).toBe('swe-ai-ml')
  })

  it('picks the more specific intent when several could match', () => {
    // {ai, ml, engineer} matches swe-ai-ml's 3-token group AND could loosely
    // relate to ai-engineer/ml-engineer's 2-token groups — the 3-token group
    // must win.
    expect(resolveRoleIntent('AI/ML Engineer')?.id).toBe('swe-ai-ml')
    // Only "ai" + "engineer" present (no "ml") -> the dedicated ai-engineer
    // intent, not the combined ai/ml one.
    expect(resolveRoleIntent('AI Engineer')?.id).toBe('ai-engineer')
    // Only "ml" + "engineer" present (no "ai") -> ml-engineer specifically.
    expect(resolveRoleIntent('ML Engineer')?.id).toBe('ml-engineer')
  })

  it('does not cross-match unrelated roles', () => {
    expect(resolveRoleIntent('Data Scientist with ML background')?.id).toBe('data-scientist')
    expect(resolveRoleIntent('Executive Assistant')).toBeNull()
    expect(resolveRoleIntent('')).toBeNull()
    expect(resolveRoleIntent(undefined)).toBeNull()
    expect(resolveRoleIntent('   ')).toBeNull()
  })

  it('every taxonomy entry is reachable via getRoleIntent', () => {
    for (const intent of ROLE_TAXONOMY) {
      expect(getRoleIntent(intent.id)).toBe(intent)
    }
  })
})

describe('classifyTitleForIntent — AI/ML precision', () => {
  const sweAiMl = getRoleIntent('swe-ai-ml')!

  it('classifies real in-role titles', () => {
    expect(classifyTitleForIntent('Software Engineer, AI/ML', sweAiMl)).toBe('in-role')
    expect(classifyTitleForIntent('Machine Learning Engineer', sweAiMl)).toBe('in-role')
    expect(classifyTitleForIntent('Senior AI Engineer', sweAiMl)).toBe('in-role')
    expect(classifyTitleForIntent('MLOps Engineer', sweAiMl)).toBe('in-role')
  })

  it('classifies adjacent titles as adjacent, not in-role', () => {
    expect(classifyTitleForIntent('Data Scientist', sweAiMl)).toBe('adjacent')
    expect(classifyTitleForIntent('Research Scientist', sweAiMl)).toBe('adjacent')
  })

  it('excludes adjacent-sounding non-IC roles even though they mention AI', () => {
    expect(classifyTitleForIntent('AI Product Manager', sweAiMl)).toBe('excluded')
    expect(classifyTitleForIntent('Executive Assistant, AI Team', sweAiMl)).toBe('excluded')
    expect(classifyTitleForIntent('Technical Recruiter - AI/ML', sweAiMl)).toBe('excluded')
  })

  it('exclusion wins even when a title keyword also matches', () => {
    // Contains both "ai engineer" (title keyword) and "recruiter" (exclude).
    expect(classifyTitleForIntent('AI Engineer Technical Recruiter', sweAiMl)).toBe('excluded')
  })

  it('leaves genuinely unrelated titles unmatched', () => {
    expect(classifyTitleForIntent('Warehouse Associate', sweAiMl)).toBe('unmatched')
    expect(classifyTitleForIntent('Barista', sweAiMl)).toBe('unmatched')
  })
})

describe('classifyTitleForIntent — bare short-acronym keywords use word boundaries', () => {
  // devops-sre.titleKeywords and ml-engineer.titleKeywords each carry a bare
  // 2-3 letter all-alpha keyword ("sre", "mle") — the exact shape that
  // triggers the \b-wrapped acronym path in titleContainsKeyword (mirroring
  // lib/sources/util.ts's compileKeyword; see util.test.ts for the
  // dedicated false-substring-match proof against "HTML5").
  it('"sre" matches as a standalone word', () => {
    const devops = getRoleIntent('devops-sre')!
    expect(classifyTitleForIntent('SRE', devops)).toBe('in-role')
    expect(classifyTitleForIntent('Senior SRE', devops)).toBe('in-role')
  })

  it('"mle" matches as a standalone word', () => {
    const mlEngineer = getRoleIntent('ml-engineer')!
    expect(classifyTitleForIntent('MLE', mlEngineer)).toBe('in-role')
    expect(classifyTitleForIntent('MLE II', mlEngineer)).toBe('in-role')
  })
})

describe('keywordsForIntent', () => {
  it('round 0 is title keywords only', () => {
    const intent = getRoleIntent('data-scientist')!
    const kws = keywordsForIntent(intent)
    expect(kws).toEqual([...intent.titleKeywords])
  })

  it('broadened round includes adjacent keywords too', () => {
    const intent = getRoleIntent('data-scientist')!
    const kws = keywordsForIntent(intent, { includeAdjacent: true })
    expect(kws).toEqual([...intent.titleKeywords, ...intent.adjacentKeywords])
  })
})
