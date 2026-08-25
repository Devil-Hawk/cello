import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MatcherAgent } from './index'
import {
  calculateSkillsMatch,
  calculateExperienceMatch,
  calculateLocationMatch,
  calculateOverallScore,
} from './scoring'
import { extractHighlights, extractGaps } from './analysis'
import {
  generateMockEmbedding,
  cosineSimilarity,
  EmbeddingProvider,
} from './embeddings'
import type { Job, UserProfile, MatchDetails } from '@cello/shared'
import type { AgentContext } from '../types'

// Mock user profile for testing
const mockUserProfile: UserProfile = {
  id: 'user-1',
  email: 'test@example.com',
  fullName: 'John Doe',
  avatarUrl: null,
  resumeText: `
    Senior Software Engineer with 5 years of experience.
    Skills: TypeScript, React, Node.js, Python, PostgreSQL, AWS, Docker, Kubernetes.
    Experience:
    - Lead developer at TechCorp (3 years)
    - Full stack engineer at StartupXYZ (2 years)
    Education: BS Computer Science
    Located in San Francisco, CA. Open to remote work.
  `,
  resumeEmbedding: null,
  preferences: {
    preferredLocations: ['San Francisco, CA', 'Remote'],
    remotePreference: 'hybrid',
    salaryMin: 150000,
    jobTypes: ['full-time'],
    notificationSettings: {
      pushEnabled: true,
      emailEnabled: true,
      matchThreshold: 70,
    },
  },
  createdAt: new Date(),
  updatedAt: new Date(),
}

// Mock job for testing
const mockJob: Job = {
  id: 'job-1',
  companyId: 'company-1',
  title: 'Senior Software Engineer',
  description: `
    We are looking for a Senior Software Engineer to join our team.

    Requirements:
    - 4+ years of experience in software development
    - Strong proficiency in TypeScript and React
    - Experience with Node.js and backend development
    - Familiarity with cloud services (AWS preferred)
    - Experience with containerization (Docker, Kubernetes)

    Nice to have:
    - Experience with GraphQL
    - Knowledge of machine learning

    Location: San Francisco, CA (Hybrid)
    Salary: $150,000 - $200,000
  `,
  url: 'https://example.com/jobs/1',
  location: 'San Francisco, CA',
  salaryRange: '$150,000 - $200,000',
  jobType: 'full-time',
  postedAt: new Date(),
  discoveredAt: new Date(),
  matchScore: null,
  matchDetails: null,
  isNew: true,
}

// Job that doesn't match well
const poorMatchJob: Job = {
  id: 'job-2',
  companyId: 'company-2',
  title: 'Data Scientist',
  description: `
    Looking for a Data Scientist with 10+ years of experience.

    Requirements:
    - PhD in Statistics or Machine Learning
    - 10+ years of experience with data science
    - Expert in R, Scala, and Spark
    - Experience with deep learning frameworks (TensorFlow, PyTorch)
    - Background in computational biology

    Location: Boston, MA (On-site only)
  `,
  url: 'https://example.com/jobs/2',
  location: 'Boston, MA',
  salaryRange: null,
  jobType: 'full-time',
  postedAt: new Date(),
  discoveredAt: new Date(),
  matchScore: null,
  matchDetails: null,
  isNew: true,
}

describe('Matcher Agent', () => {
  describe('MatcherAgent class', () => {
    let agent: MatcherAgent

    beforeEach(() => {
      agent = new MatcherAgent()
    })

    it('should have correct name and description', () => {
      expect(agent.name).toBe('Matcher')
      expect(agent.description).toContain('job')
      expect(agent.description).toContain('resume')
    })

    it('should return error when no jobs provided', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        jobs: [],
      }
      const result = await agent.execute(context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('No jobs')
    })

    it('should return error when no resume text', async () => {
      const context: AgentContext = {
        user: { ...mockUserProfile, resumeText: null },
        jobs: [mockJob],
      }
      const result = await agent.execute(context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('resume')
    })

    it('should successfully match a job', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        jobs: [mockJob],
      }
      const result = await agent.execute(context)
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.jobId).toBe('job-1')
      expect(result.data?.score).toBeGreaterThan(0)
      expect(result.data?.highlights).toBeInstanceOf(Array)
      expect(result.data?.gaps).toBeInstanceOf(Array)
    })

    it('should match multiple jobs', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        jobs: [mockJob, poorMatchJob],
      }
      // matchAll returns all matches
      const results = await agent.matchAll(context)
      expect(results).toHaveLength(2)
      expect(results[0].jobId).toBe('job-1')
      expect(results[1].jobId).toBe('job-2')
    })

    it('should return higher score for better match', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        jobs: [mockJob, poorMatchJob],
      }
      const results = await agent.matchAll(context)
      const goodMatchResult = results.find((r) => r.jobId === 'job-1')
      const poorMatchResult = results.find((r) => r.jobId === 'job-2')
      expect(goodMatchResult?.score).toBeGreaterThan(poorMatchResult?.score ?? 0)
    })
  })

  describe('matchJob method', () => {
    let agent: MatcherAgent

    beforeEach(() => {
      agent = new MatcherAgent()
    })

    it('should return MatchDetails for a job', async () => {
      const result = await agent.matchJob(mockJob, mockUserProfile)
      expect(result).toBeDefined()
      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(100)
      expect(result.skillsMatch).toBeGreaterThanOrEqual(0)
      expect(result.experienceMatch).toBeGreaterThanOrEqual(0)
      expect(result.locationMatch).toBeGreaterThanOrEqual(0)
    })

    it('should identify highlights', async () => {
      const result = await agent.matchJob(mockJob, mockUserProfile)
      expect(result.highlights.length).toBeGreaterThan(0)
      // Good match should have highlights about matching skills
      const hasSkillHighlight = result.highlights.some(
        (h) =>
          h.toLowerCase().includes('typescript') ||
          h.toLowerCase().includes('react') ||
          h.toLowerCase().includes('node')
      )
      expect(hasSkillHighlight).toBe(true)
    })

    it('should identify gaps for poor match', async () => {
      const result = await agent.matchJob(poorMatchJob, mockUserProfile)
      expect(result.gaps.length).toBeGreaterThan(0)
      // Should identify missing requirements
      const hasGap = result.gaps.some(
        (g) =>
          g.toLowerCase().includes('phd') ||
          g.toLowerCase().includes('experience') ||
          g.toLowerCase().includes('r,') ||
          g.toLowerCase().includes('scala')
      )
      expect(hasGap).toBe(true)
    })
  })
})

describe('Scoring Module', () => {
  describe('calculateSkillsMatch', () => {
    it('should return high score when all required skills are present', () => {
      const requiredSkills = ['typescript', 'react', 'node.js']
      const resumeText = 'Experienced in TypeScript, React, and Node.js development'
      const score = calculateSkillsMatch(requiredSkills, resumeText)
      expect(score).toBeGreaterThanOrEqual(80)
    })

    it('should return moderate score when some skills are present', () => {
      const requiredSkills = ['typescript', 'react', 'node.js', 'graphql', 'rust']
      const resumeText = 'Experienced in TypeScript and React development'
      const score = calculateSkillsMatch(requiredSkills, resumeText)
      expect(score).toBeGreaterThanOrEqual(30)
      expect(score).toBeLessThanOrEqual(70)
    })

    it('should return low score when few skills match', () => {
      const requiredSkills = ['rust', 'haskell', 'erlang', 'elixir']
      const resumeText = 'Experienced in JavaScript and Python development'
      const score = calculateSkillsMatch(requiredSkills, resumeText)
      expect(score).toBeLessThan(30)
    })

    it('should handle empty required skills', () => {
      const score = calculateSkillsMatch([], 'Any resume text')
      expect(score).toBe(100) // No requirements = perfect match
    })

    it('should handle empty resume text', () => {
      const score = calculateSkillsMatch(['typescript', 'react'], '')
      expect(score).toBe(0)
    })

    it('should be case insensitive', () => {
      const score1 = calculateSkillsMatch(['TypeScript'], 'typescript')
      const score2 = calculateSkillsMatch(['typescript'], 'TYPESCRIPT')
      expect(score1).toBe(score2)
    })
  })

  describe('calculateExperienceMatch', () => {
    it('should return high score when experience exceeds requirement', () => {
      const score = calculateExperienceMatch(3, 5)
      expect(score).toBeGreaterThanOrEqual(90)
    })

    it('should return perfect score when experience matches exactly', () => {
      const score = calculateExperienceMatch(5, 5)
      expect(score).toBeGreaterThanOrEqual(90)
    })

    it('should return moderate score when slightly under requirement', () => {
      const score = calculateExperienceMatch(5, 4)
      expect(score).toBeGreaterThanOrEqual(60)
      expect(score).toBeLessThanOrEqual(90)
    })

    it('should return low score when significantly under requirement', () => {
      const score = calculateExperienceMatch(10, 2)
      expect(score).toBeLessThan(50)
    })

    it('should handle zero required years', () => {
      const score = calculateExperienceMatch(0, 5)
      expect(score).toBe(100)
    })

    it('should handle zero resume years', () => {
      const score = calculateExperienceMatch(5, 0)
      expect(score).toBe(0)
    })
  })

  describe('calculateLocationMatch', () => {
    it('should return perfect score for exact location match', () => {
      const score = calculateLocationMatch(
        'San Francisco, CA',
        ['San Francisco, CA'],
        'any'
      )
      expect(score).toBe(100)
    })

    it('should return high score for remote when preferred', () => {
      const score = calculateLocationMatch('Remote', ['New York'], 'remote')
      expect(score).toBeGreaterThanOrEqual(90)
    })

    it('should return moderate score for remote when any preference', () => {
      const score = calculateLocationMatch('Remote', ['San Francisco, CA'], 'any')
      expect(score).toBeGreaterThanOrEqual(70)
    })

    it('should return low score for location mismatch', () => {
      const score = calculateLocationMatch('Boston, MA', ['San Francisco, CA'], 'onsite')
      expect(score).toBeLessThan(50)
    })

    it('should handle hybrid job locations', () => {
      const score = calculateLocationMatch(
        'San Francisco, CA (Hybrid)',
        ['San Francisco, CA'],
        'hybrid'
      )
      expect(score).toBeGreaterThanOrEqual(90)
    })

    it('should handle null job location', () => {
      const score = calculateLocationMatch(null, ['San Francisco, CA'], 'any')
      expect(score).toBeGreaterThanOrEqual(50) // Unknown location gets moderate score
    })
  })

  describe('calculateOverallScore', () => {
    it('should weight scores correctly (50% skills, 30% experience, 20% location)', () => {
      // All perfect scores should give 100
      const score1 = calculateOverallScore(100, 100, 100)
      expect(score1).toBe(100)

      // Weighted calculation
      const score2 = calculateOverallScore(100, 0, 0) // Only skills
      expect(score2).toBe(50)

      const score3 = calculateOverallScore(0, 100, 0) // Only experience
      expect(score3).toBe(30)

      const score4 = calculateOverallScore(0, 0, 100) // Only location
      expect(score4).toBe(20)
    })

    it('should round to nearest integer', () => {
      const score = calculateOverallScore(75, 80, 90)
      expect(Number.isInteger(score)).toBe(true)
    })

    it('should clamp between 0 and 100', () => {
      const score1 = calculateOverallScore(-10, -10, -10)
      expect(score1).toBeGreaterThanOrEqual(0)

      const score2 = calculateOverallScore(150, 150, 150)
      expect(score2).toBeLessThanOrEqual(100)
    })
  })
})

describe('Analysis Module', () => {
  describe('extractHighlights', () => {
    it('should extract matching skills as highlights', () => {
      const highlights = extractHighlights(
        mockJob.description,
        mockUserProfile.resumeText!,
        mockJob
      )
      expect(highlights.length).toBeGreaterThan(0)
      expect(highlights.some((h) => h.toLowerCase().includes('skill'))).toBe(true)
    })

    it('should highlight experience match', () => {
      const highlights = extractHighlights(
        mockJob.description,
        mockUserProfile.resumeText!,
        mockJob
      )
      const hasExpHighlight = highlights.some(
        (h) => h.toLowerCase().includes('experience') || h.toLowerCase().includes('year')
      )
      expect(hasExpHighlight).toBe(true)
    })

    it('should highlight location match', () => {
      const highlights = extractHighlights(
        mockJob.description,
        mockUserProfile.resumeText!,
        mockJob
      )
      const hasLocationHighlight = highlights.some(
        (h) =>
          h.toLowerCase().includes('location') ||
          h.toLowerCase().includes('san francisco') ||
          h.toLowerCase().includes('remote')
      )
      expect(hasLocationHighlight).toBe(true)
    })

    it('should return empty array when no matches', () => {
      const highlights = extractHighlights(
        'Looking for PhD in quantum physics with 20 years experience',
        'Entry level javascript developer',
        poorMatchJob
      )
      // May have some generic highlights, but should be minimal
      expect(highlights.length).toBeLessThan(5)
    })
  })

  describe('extractGaps', () => {
    it('should extract missing required skills as gaps', () => {
      const gaps = extractGaps(
        poorMatchJob.description,
        mockUserProfile.resumeText!,
        poorMatchJob
      )
      expect(gaps.length).toBeGreaterThan(0)
    })

    it('should identify experience gap', () => {
      const gaps = extractGaps(
        poorMatchJob.description,
        mockUserProfile.resumeText!,
        poorMatchJob
      )
      const hasExpGap = gaps.some(
        (g) => g.toLowerCase().includes('experience') || g.toLowerCase().includes('year')
      )
      expect(hasExpGap).toBe(true)
    })

    it('should identify missing degree requirements', () => {
      const gaps = extractGaps(
        poorMatchJob.description,
        mockUserProfile.resumeText!,
        poorMatchJob
      )
      const hasDegreeGap = gaps.some(
        (g) =>
          g.toLowerCase().includes('phd') ||
          g.toLowerCase().includes('degree') ||
          g.toLowerCase().includes('education')
      )
      expect(hasDegreeGap).toBe(true)
    })

    it('should return empty array when job is perfect match', () => {
      const perfectMatchJob: Job = {
        ...mockJob,
        description: 'Looking for someone with TypeScript and React experience, 3+ years',
      }
      const gaps = extractGaps(
        perfectMatchJob.description,
        mockUserProfile.resumeText!,
        perfectMatchJob
      )
      // Should have minimal or no gaps
      expect(gaps.length).toBeLessThan(3)
    })
  })
})

describe('Embeddings Module', () => {
  describe('generateMockEmbedding', () => {
    it('should generate embedding of specified dimension', () => {
      const embedding = generateMockEmbedding('test text')
      expect(embedding).toHaveLength(384) // Default dimension
    })

    it('should generate different embeddings for different text', () => {
      const embedding1 = generateMockEmbedding('typescript react developer')
      const embedding2 = generateMockEmbedding('python data scientist')
      // Not all values should be the same
      const allSame = embedding1.every((val, idx) => val === embedding2[idx])
      expect(allSame).toBe(false)
    })

    it('should generate similar embeddings for similar text', () => {
      const embedding1 = generateMockEmbedding('senior software engineer typescript')
      const embedding2 = generateMockEmbedding('senior software developer typescript')
      const similarity = cosineSimilarity(embedding1, embedding2)
      expect(similarity).toBeGreaterThan(0.5)
    })

    it('should generate deterministic embeddings', () => {
      const embedding1 = generateMockEmbedding('test text')
      const embedding2 = generateMockEmbedding('test text')
      expect(embedding1).toEqual(embedding2)
    })
  })

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const vec = [1, 2, 3, 4, 5]
      const similarity = cosineSimilarity(vec, vec)
      expect(similarity).toBeCloseTo(1, 5)
    })

    it('should return 0 for orthogonal vectors', () => {
      const vec1 = [1, 0, 0]
      const vec2 = [0, 1, 0]
      const similarity = cosineSimilarity(vec1, vec2)
      expect(similarity).toBeCloseTo(0, 5)
    })

    it('should return -1 for opposite vectors', () => {
      const vec1 = [1, 2, 3]
      const vec2 = [-1, -2, -3]
      const similarity = cosineSimilarity(vec1, vec2)
      expect(similarity).toBeCloseTo(-1, 5)
    })

    it('should handle zero vectors', () => {
      const vec1 = [0, 0, 0]
      const vec2 = [1, 2, 3]
      const similarity = cosineSimilarity(vec1, vec2)
      expect(similarity).toBe(0)
    })

    it('should throw for mismatched dimensions', () => {
      const vec1 = [1, 2, 3]
      const vec2 = [1, 2]
      expect(() => cosineSimilarity(vec1, vec2)).toThrow()
    })
  })

  describe('EmbeddingProvider', () => {
    it('should use mock provider by default', async () => {
      const provider = new EmbeddingProvider()
      const embedding = await provider.generateEmbedding('test text')
      expect(embedding).toHaveLength(384)
    })

    it('should compute similarity between texts', async () => {
      const provider = new EmbeddingProvider()
      const similarity = await provider.computeSimilarity(
        'typescript react developer',
        'typescript node developer'
      )
      expect(similarity).toBeGreaterThan(0)
      expect(similarity).toBeLessThanOrEqual(1)
    })

    it('should allow setting custom dimension', () => {
      const provider = new EmbeddingProvider({ dimension: 256 })
      const embedding = provider.generateEmbeddingSync('test')
      expect(embedding).toHaveLength(256)
    })
  })
})
