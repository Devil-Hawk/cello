import { describe, it, expect } from 'vitest'
import { calculatePriority } from './priority'
import { MATCH_THRESHOLDS } from '@cello/shared'

describe('calculatePriority', () => {
  describe('URGENT priority', () => {
    it('should return URGENT when match >=85% AND dreamCompany', () => {
      const result = calculatePriority({
        matchScore: 85,
        isDreamCompany: true,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('urgent')
      expect(result.reasons).toContain('Excellent match (85%)')
      expect(result.reasons).toContain('Dream company')
    })

    it('should return URGENT when match >=85% AND posted <2 hours ago', () => {
      const result = calculatePriority({
        matchScore: 90,
        isDreamCompany: false,
        hoursAgo: 1,
      })
      expect(result.priority).toBe('urgent')
      expect(result.reasons).toContain('Excellent match (90%)')
      expect(result.reasons).toContain('Fresh posting (1 hours ago)')
    })

    it('should return URGENT when match >=85% AND dreamCompany AND fresh', () => {
      const result = calculatePriority({
        matchScore: 95,
        isDreamCompany: true,
        hoursAgo: 0.5,
      })
      expect(result.priority).toBe('urgent')
      expect(result.recommendedActions).toContain('notify')
      expect(result.recommendedActions).toContain('analyze')
    })
  })

  describe('HIGH priority', () => {
    it('should return HIGH when match >=85% but not dream company or fresh', () => {
      const result = calculatePriority({
        matchScore: 85,
        isDreamCompany: false,
        hoursAgo: 10,
      })
      expect(result.priority).toBe('high')
      expect(result.reasons).toContain('Excellent match (85%)')
    })

    it('should return HIGH when match >=70% AND dreamCompany', () => {
      const result = calculatePriority({
        matchScore: 70,
        isDreamCompany: true,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('high')
      expect(result.reasons).toContain('Good match (70%)')
      expect(result.reasons).toContain('Dream company')
    })

    it('should return HIGH when match is 84% (just below URGENT threshold)', () => {
      const result = calculatePriority({
        matchScore: 84,
        isDreamCompany: true,
        hoursAgo: 1,
      })
      // 84% with dream company = HIGH (not urgent because score < 85)
      expect(result.priority).toBe('high')
    })
  })

  describe('MEDIUM priority', () => {
    it('should return MEDIUM when match >=70% but not dream company', () => {
      const result = calculatePriority({
        matchScore: 70,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('medium')
      expect(result.reasons).toContain('Good match (70%)')
    })

    it('should return MEDIUM when match >=50% AND dreamCompany', () => {
      const result = calculatePriority({
        matchScore: 50,
        isDreamCompany: true,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('medium')
      expect(result.reasons).toContain('Fair match (50%)')
      expect(result.reasons).toContain('Dream company')
    })

    it('should return MEDIUM when match is 69% and dream company', () => {
      const result = calculatePriority({
        matchScore: 69,
        isDreamCompany: true,
        hoursAgo: 10,
      })
      expect(result.priority).toBe('medium')
    })
  })

  describe('LOW priority', () => {
    it('should return LOW when match >=50% but not dream company', () => {
      const result = calculatePriority({
        matchScore: 50,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('low')
      expect(result.reasons).toContain('Fair match (50%)')
    })

    it('should return LOW when match is 55%', () => {
      const result = calculatePriority({
        matchScore: 55,
        isDreamCompany: false,
        hoursAgo: 48,
      })
      expect(result.priority).toBe('low')
    })
  })

  describe('SKIP priority', () => {
    it('should return SKIP when match <50%', () => {
      const result = calculatePriority({
        matchScore: 49,
        isDreamCompany: false,
        hoursAgo: 1,
      })
      expect(result.priority).toBe('skip')
      expect(result.reasons).toContain('Low match score (49%)')
      expect(result.recommendedActions).toContain('skip')
    })

    it('should return SKIP when match <50% even for dream company', () => {
      const result = calculatePriority({
        matchScore: 30,
        isDreamCompany: true,
        hoursAgo: 0.5,
      })
      expect(result.priority).toBe('skip')
    })

    it('should return SKIP when match is 0', () => {
      const result = calculatePriority({
        matchScore: 0,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('skip')
    })
  })

  describe('recommended actions', () => {
    it('should include notify and analyze for urgent priority', () => {
      const result = calculatePriority({
        matchScore: 90,
        isDreamCompany: true,
        hoursAgo: 1,
      })
      expect(result.recommendedActions).toContain('notify')
      expect(result.recommendedActions).toContain('analyze')
    })

    it('should include notify and match for high priority', () => {
      const result = calculatePriority({
        matchScore: 85,
        isDreamCompany: false,
        hoursAgo: 10,
      })
      expect(result.recommendedActions).toContain('notify')
      expect(result.recommendedActions).toContain('match')
    })

    it('should include match for medium priority', () => {
      const result = calculatePriority({
        matchScore: 70,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.recommendedActions).toContain('match')
    })

    it('should include match for low priority', () => {
      const result = calculatePriority({
        matchScore: 50,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.recommendedActions).toContain('match')
    })

    it('should only include skip for skip priority', () => {
      const result = calculatePriority({
        matchScore: 30,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.recommendedActions).toEqual(['skip'])
    })
  })

  describe('edge cases', () => {
    it('should handle exact threshold values correctly at 85%', () => {
      const result = calculatePriority({
        matchScore: MATCH_THRESHOLDS.EXCELLENT,
        isDreamCompany: false,
        hoursAgo: 10,
      })
      expect(result.priority).toBe('high')
    })

    it('should handle exact threshold values correctly at 70%', () => {
      const result = calculatePriority({
        matchScore: MATCH_THRESHOLDS.GOOD,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('medium')
    })

    it('should handle exact threshold values correctly at 50%', () => {
      const result = calculatePriority({
        matchScore: MATCH_THRESHOLDS.FAIR,
        isDreamCompany: false,
        hoursAgo: 24,
      })
      expect(result.priority).toBe('low')
    })

    it('should handle hoursAgo exactly at 2 as not fresh', () => {
      const result = calculatePriority({
        matchScore: 90,
        isDreamCompany: false,
        hoursAgo: 2,
      })
      // 2 hours is NOT fresh (must be <2)
      expect(result.priority).toBe('high')
    })

    it('should handle hoursAgo just under 2 as fresh', () => {
      const result = calculatePriority({
        matchScore: 90,
        isDreamCompany: false,
        hoursAgo: 1.9,
      })
      expect(result.priority).toBe('urgent')
    })
  })
})
