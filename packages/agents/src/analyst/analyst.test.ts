import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnalystAgent } from './index'
import { MockLLMClient } from './llm-client'
import { CompanyInsightsCache } from './analysis'
import type { AgentContext } from '../types'
import type { Job, Company, UserProfile } from '@cello/shared'

// Helper to create test fixtures
function createTestUserProfile(overrides?: Partial<UserProfile>): UserProfile {
  return {
    id: 'user-1',
    email: 'test@example.com',
    fullName: 'John Doe',
    avatarUrl: null,
    resumeText: `
      Senior Software Engineer with 8 years of experience in backend development.
      Expert in Node.js, TypeScript, Python, and cloud infrastructure (AWS, GCP).
      Led teams of 5-10 engineers. Strong experience with microservices architecture.
      Previous companies: Google, Stripe.
    `,
    resumeEmbedding: null,
    preferences: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function createTestCompany(overrides?: Partial<Company>): Company {
  return {
    id: 'company-1',
    userId: 'user-1',
    name: 'Acme Corp',
    domain: 'acme.com',
    logoUrl: null,
    careerUrl: 'https://acme.com/careers',
    scrapeFrequency: 60,
    lastScrapedAt: null,
    isDreamCompany: false,
    notes: 'Fast-growing startup in the AI space',
    createdAt: new Date(),
    ...overrides,
  }
}

function createTestJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    companyId: 'company-1',
    title: 'Senior Backend Engineer',
    description: `
      We're looking for a Senior Backend Engineer to join our platform team.

      Requirements:
      - 5+ years of backend development experience
      - Strong proficiency in Node.js and TypeScript
      - Experience with cloud infrastructure (AWS preferred)
      - Experience with microservices architecture
      - Strong communication skills

      Nice to have:
      - Experience with GraphQL
      - Kubernetes experience
      - Previous startup experience

      What we offer:
      - Competitive salary ($180k-$250k)
      - Equity package
      - Remote-first culture
      - Unlimited PTO
    `,
    url: 'https://acme.com/jobs/senior-backend-engineer',
    location: 'Remote',
    salaryRange: '$180k-$250k',
    jobType: 'full-time',
    postedAt: new Date(),
    discoveredAt: new Date(),
    matchScore: null,
    matchDetails: null,
    isNew: true,
    ...overrides,
  }
}

function createTestContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    user: createTestUserProfile(),
    companies: [createTestCompany()],
    jobs: [createTestJob()],
    apiKeys: {
      openai: 'test-openai-key',
      anthropic: 'test-anthropic-key',
    },
    ...overrides,
  }
}

describe('AnalystAgent', () => {
  let agent: AnalystAgent
  let mockClient: MockLLMClient

  beforeEach(() => {
    mockClient = new MockLLMClient()
    agent = new AnalystAgent({ llmClient: mockClient })
  })

  describe('constructor', () => {
    it('should have correct name and description', () => {
      expect(agent.name).toBe('Analyst')
      expect(agent.description).toContain('analysis')
    })
  })

  describe('execute', () => {
    it('should return error if no jobs provided', async () => {
      const context = createTestContext({ jobs: [] })
      const result = await agent.execute(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('No jobs provided')
    })

    it('should return error if no user profile provided', async () => {
      const context = createTestContext()
      // @ts-expect-error - Testing missing user
      context.user = undefined

      const result = await agent.execute(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('No user profile')
    })

    it('should return error if user has no resume', async () => {
      const context = createTestContext({
        user: createTestUserProfile({ resumeText: null }),
      })

      const result = await agent.execute(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('resume')
    })

    it('should analyze job and return structured result', async () => {
      const context = createTestContext()
      const result = await agent.execute(context)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.jobId).toBe('job-1')
      expect(result.data?.summary).toBeDefined()
      expect(result.data?.summary.length).toBeGreaterThan(0)
      expect(result.data?.talkingPoints).toBeInstanceOf(Array)
      expect(result.data?.talkingPoints.length).toBeGreaterThan(0)
      expect(result.data?.companyInsights).toBeInstanceOf(Array)
      expect(result.data?.interviewTips).toBeInstanceOf(Array)
    })

    it('should include metadata with duration', async () => {
      const context = createTestContext()
      const result = await agent.execute(context)

      expect(result.metadata).toBeDefined()
      expect(result.metadata?.duration).toBeGreaterThanOrEqual(0)
    })
  })

  describe('analyzeJob', () => {
    it('should generate job summary', async () => {
      const context = createTestContext()
      const job = context.jobs![0]
      const company = context.companies![0]

      const result = await agent.analyzeJob(job, company, context.user)

      expect(result.summary).toBeDefined()
      expect(result.summary.length).toBeGreaterThan(0)
    })

    it('should generate talking points based on resume match', async () => {
      const context = createTestContext()
      const job = context.jobs![0]
      const company = context.companies![0]

      const result = await agent.analyzeJob(job, company, context.user)

      expect(result.talkingPoints).toBeInstanceOf(Array)
      expect(result.talkingPoints.length).toBeGreaterThanOrEqual(3)
      expect(result.talkingPoints.length).toBeLessThanOrEqual(5)
    })

    it('should generate company insights', async () => {
      const context = createTestContext()
      const job = context.jobs![0]
      const company = context.companies![0]

      const result = await agent.analyzeJob(job, company, context.user)

      expect(result.companyInsights).toBeInstanceOf(Array)
      expect(result.companyInsights.length).toBeGreaterThan(0)
    })

    it('should generate interview tips', async () => {
      const context = createTestContext()
      const job = context.jobs![0]
      const company = context.companies![0]

      const result = await agent.analyzeJob(job, company, context.user)

      expect(result.interviewTips).toBeInstanceOf(Array)
      expect(result.interviewTips.length).toBeGreaterThan(0)
    })
  })
})

describe('MockLLMClient', () => {
  let client: MockLLMClient

  beforeEach(() => {
    client = new MockLLMClient()
  })

  describe('complete', () => {
    it('should return mock response for job summary prompt', async () => {
      const response = await client.complete('Generate a summary for this job...')

      expect(response).toBeDefined()
      expect(typeof response).toBe('string')
      expect(response.length).toBeGreaterThan(0)
    })

    it('should return mock response for talking points prompt', async () => {
      const response = await client.complete('Generate talking points...')

      expect(response).toBeDefined()
      expect(typeof response).toBe('string')
    })

    it('should track call count', async () => {
      expect(client.callCount).toBe(0)

      await client.complete('Test 1')
      expect(client.callCount).toBe(1)

      await client.complete('Test 2')
      expect(client.callCount).toBe(2)
    })

    it('should store last prompt', async () => {
      const prompt = 'Test prompt for tracking'
      await client.complete(prompt)

      expect(client.lastPrompt).toBe(prompt)
    })
  })

  describe('setMockResponse', () => {
    it('should allow setting custom mock responses', async () => {
      client.setMockResponse('Custom response for testing')
      const response = await client.complete('Any prompt')

      expect(response).toBe('Custom response for testing')
    })
  })

  describe('simulateError', () => {
    it('should simulate API errors when configured', async () => {
      client.simulateError('API rate limit exceeded')

      await expect(client.complete('Test')).rejects.toThrow('API rate limit exceeded')
    })
  })
})

describe('CompanyInsightsCache', () => {
  let cache: CompanyInsightsCache

  beforeEach(() => {
    vi.useFakeTimers()
    cache = new CompanyInsightsCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('get/set', () => {
    it('should store and retrieve company insights', () => {
      const insights = ['Great culture', 'Fast-paced environment']
      cache.set('company-1', insights)

      const retrieved = cache.get('company-1')
      expect(retrieved).toEqual(insights)
    })

    it('should return undefined for non-existent company', () => {
      const result = cache.get('non-existent')
      expect(result).toBeUndefined()
    })

    it('should overwrite existing insights', () => {
      cache.set('company-1', ['Old insight'])
      cache.set('company-1', ['New insight'])

      const retrieved = cache.get('company-1')
      expect(retrieved).toEqual(['New insight'])
    })
  })

  describe('TTL expiration', () => {
    it('should return undefined for expired entries', () => {
      const insights = ['Test insight']
      cache.set('company-1', insights, 60000) // 1 minute TTL

      // Advance time by 2 minutes
      vi.advanceTimersByTime(120000)

      const result = cache.get('company-1')
      expect(result).toBeUndefined()
    })

    it('should return value if not yet expired', () => {
      const insights = ['Test insight']
      cache.set('company-1', insights, 60000) // 1 minute TTL

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30000)

      const result = cache.get('company-1')
      expect(result).toEqual(insights)
    })

    it('should use default TTL if not specified', () => {
      cache = new CompanyInsightsCache(30000) // 30 second default TTL
      cache.set('company-1', ['Test'])

      vi.advanceTimersByTime(40000)

      expect(cache.get('company-1')).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('should clear all cached entries', () => {
      cache.set('company-1', ['Insight 1'])
      cache.set('company-2', ['Insight 2'])

      cache.clear()

      expect(cache.get('company-1')).toBeUndefined()
      expect(cache.get('company-2')).toBeUndefined()
    })
  })

  describe('has', () => {
    it('should return true for existing non-expired entry', () => {
      cache.set('company-1', ['Test'])
      expect(cache.has('company-1')).toBe(true)
    })

    it('should return false for non-existent entry', () => {
      expect(cache.has('non-existent')).toBe(false)
    })

    it('should return false for expired entry', () => {
      cache.set('company-1', ['Test'], 1000)
      vi.advanceTimersByTime(2000)

      expect(cache.has('company-1')).toBe(false)
    })
  })
})

describe('LLM Client Factory', () => {
  it('should create mock client when no API keys provided', async () => {
    // Import here to avoid circular dependency issues
    const { createLLMClient } = await import('./llm-client')
    const client = createLLMClient({})

    expect(client).toBeInstanceOf(MockLLMClient)
  })

  it('should prefer Anthropic when both keys provided', async () => {
    const { createLLMClient, AnthropicLLMClient } = await import('./llm-client')
    const client = createLLMClient({
      openai: 'test-openai',
      anthropic: 'test-anthropic',
    })

    expect(client).toBeInstanceOf(AnthropicLLMClient)
  })

  it('should use OpenAI when only OpenAI key provided', async () => {
    const { createLLMClient, OpenAILLMClient } = await import('./llm-client')
    const client = createLLMClient({
      openai: 'test-openai',
    })

    expect(client).toBeInstanceOf(OpenAILLMClient)
  })
})
