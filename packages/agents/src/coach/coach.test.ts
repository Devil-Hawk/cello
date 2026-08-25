import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoachAgent } from './index'
import { MockLLMClient } from '../analyst/llm-client'
import {
  getFollowUpTiming,
  shouldSuggestFollowUp,
  getTimingSuggestion,
} from './timing'
import {
  generateFollowUpMessage,
  generateThankYouMessage,
  generateColdOutreachMessage,
  generateCheckInMessage,
} from './message-generator'
import type { AgentContext } from '../types'
import type { Application, Job, Company, UserProfile, Contact } from '@cello/shared'
import type { PipelineStage } from '@cello/shared'
import type { MessageType, MessageContext } from './types'

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
      Requirements: 5+ years of backend development experience.
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

function createTestApplication(overrides?: Partial<Application>): Application {
  return {
    id: 'app-1',
    userId: 'user-1',
    jobId: 'job-1',
    stage: 'applied',
    appliedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // 6 days ago
    source: 'direct',
    notes: null,
    resumeVersion: null,
    coverLetter: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function createTestContact(overrides?: Partial<Contact>): Contact {
  return {
    id: 'contact-1',
    userId: 'user-1',
    companyId: 'company-1',
    name: 'Jane Smith',
    email: 'jane.smith@acme.com',
    linkedinUrl: 'https://linkedin.com/in/janesmith',
    title: 'Engineering Manager',
    relationship: 'Met at conference',
    lastContactAt: null,
    notes: 'Very helpful and responsive',
    createdAt: new Date(),
    ...overrides,
  }
}

function createTestContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    user: createTestUserProfile(),
    companies: [createTestCompany()],
    jobs: [createTestJob()],
    applications: [createTestApplication()],
    apiKeys: {
      openai: 'test-openai-key',
      anthropic: 'test-anthropic-key',
    },
    ...overrides,
  }
}

// Extended context with contacts for testing
interface ExtendedAgentContext extends AgentContext {
  contacts?: Contact[]
}

function createExtendedTestContext(
  overrides?: Partial<ExtendedAgentContext>
): ExtendedAgentContext {
  return {
    ...createTestContext(),
    contacts: [createTestContact()],
    ...overrides,
  }
}

describe('Follow-up Timing Logic', () => {
  describe('getFollowUpTiming', () => {
    it('should return 5-7 days for applied stage', () => {
      const timing = getFollowUpTiming('applied')
      expect(timing).not.toBeNull()
      expect(timing!.minDays).toBe(5)
      expect(timing!.maxDays).toBe(7)
      expect(timing!.suggestion).toContain('application status')
    })

    it('should return 3-5 days for screen stage', () => {
      const timing = getFollowUpTiming('screen')
      expect(timing).not.toBeNull()
      expect(timing!.minDays).toBe(3)
      expect(timing!.maxDays).toBe(5)
      expect(timing!.suggestion).toContain('interest')
    })

    it('should return 1-2 days for interview stage', () => {
      const timing = getFollowUpTiming('interview')
      expect(timing).not.toBeNull()
      expect(timing!.minDays).toBe(1)
      expect(timing!.maxDays).toBe(2)
      expect(timing!.suggestion).toContain('thank you')
    })

    it('should return 2-3 days for offer stage', () => {
      const timing = getFollowUpTiming('offer')
      expect(timing).not.toBeNull()
      expect(timing!.minDays).toBe(2)
      expect(timing!.maxDays).toBe(3)
      expect(timing!.suggestion).toContain('offer')
    })

    it('should return null for discovered stage', () => {
      const timing = getFollowUpTiming('discovered')
      expect(timing).toBeNull()
    })

    it('should return null for closed stage', () => {
      const timing = getFollowUpTiming('closed')
      expect(timing).toBeNull()
    })

    it('should return null for rejected stage', () => {
      const timing = getFollowUpTiming('rejected')
      expect(timing).toBeNull()
    })

    it('should return null for ghosted stage', () => {
      const timing = getFollowUpTiming('ghosted')
      expect(timing).toBeNull()
    })
  })

  describe('shouldSuggestFollowUp', () => {
    it('should suggest follow-up after 5 days in applied stage', () => {
      const appliedAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) // 6 days ago
      const result = shouldSuggestFollowUp('applied', appliedAt)
      expect(result).toBe(true)
    })

    it('should not suggest follow-up before 5 days in applied stage', () => {
      const appliedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
      const result = shouldSuggestFollowUp('applied', appliedAt)
      expect(result).toBe(false)
    })

    it('should suggest follow-up after 1 day in interview stage', () => {
      const appliedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
      const result = shouldSuggestFollowUp('interview', appliedAt)
      expect(result).toBe(true)
    })

    it('should not suggest follow-up for rejected stage', () => {
      const appliedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
      const result = shouldSuggestFollowUp('rejected', appliedAt)
      expect(result).toBe(false)
    })

    it('should not suggest follow-up if no appliedAt date', () => {
      const result = shouldSuggestFollowUp('applied', null)
      expect(result).toBe(false)
    })
  })

  describe('getTimingSuggestion', () => {
    it('should return appropriate suggestion for applied stage', () => {
      const suggestion = getTimingSuggestion('applied', 6)
      expect(suggestion).toContain('6 days')
      expect(suggestion).toContain('follow up')
    })

    it('should return interview-specific suggestion', () => {
      const suggestion = getTimingSuggestion('interview', 2)
      expect(suggestion).toContain('thank you')
    })

    it('should return offer-specific suggestion', () => {
      const suggestion = getTimingSuggestion('offer', 3)
      expect(suggestion).toContain('offer')
    })
  })
})

describe('Message Generator', () => {
  let mockClient: MockLLMClient

  beforeEach(() => {
    mockClient = new MockLLMClient()
  })

  describe('generateFollowUpMessage', () => {
    it('should generate follow-up message with application context', async () => {
      mockClient.setMockResponse(
        'Hi Jane, I wanted to follow up on my application for the Senior Backend Engineer position at Acme Corp...'
      )

      const context: MessageContext = {
        userName: 'John Doe',
        companyName: 'Acme Corp',
        jobTitle: 'Senior Backend Engineer',
        stage: 'applied',
        daysSinceLastActivity: 6,
      }

      const message = await generateFollowUpMessage(mockClient, context)

      expect(message).toBeDefined()
      expect(message.length).toBeGreaterThan(0)
      expect(mockClient.callCount).toBe(1)
    })

    it('should include contact name if provided', async () => {
      mockClient.setMockResponse('Hi Jane, thank you for your time...')

      const context: MessageContext = {
        userName: 'John Doe',
        companyName: 'Acme Corp',
        jobTitle: 'Senior Backend Engineer',
        stage: 'interview',
        daysSinceLastActivity: 2,
        contactName: 'Jane Smith',
      }

      const message = await generateFollowUpMessage(mockClient, context)
      expect(mockClient.lastPrompt).toContain('Jane Smith')
    })
  })

  describe('generateThankYouMessage', () => {
    it('should generate thank you message after interview', async () => {
      mockClient.setMockResponse(
        'Dear Jane, Thank you so much for taking the time to meet with me today...'
      )

      const context: MessageContext = {
        userName: 'John Doe',
        companyName: 'Acme Corp',
        jobTitle: 'Senior Backend Engineer',
        stage: 'interview',
        contactName: 'Jane Smith',
      }

      const message = await generateThankYouMessage(mockClient, context)

      expect(message).toBeDefined()
      expect(mockClient.lastPrompt).toContain('thank you')
    })
  })

  describe('generateColdOutreachMessage', () => {
    it('should generate cold outreach message for referral', async () => {
      mockClient.setMockResponse(
        'Hi Jane, I noticed you work at Acme Corp and I am very interested in the Senior Backend Engineer role...'
      )

      const context: MessageContext = {
        userName: 'John Doe',
        companyName: 'Acme Corp',
        jobTitle: 'Senior Backend Engineer',
        contactName: 'Jane Smith',
        contactTitle: 'Engineering Manager',
        relationship: 'Met at conference',
      }

      const message = await generateColdOutreachMessage(mockClient, context)

      expect(message).toBeDefined()
      expect(mockClient.lastPrompt).toContain('Engineering Manager')
      expect(mockClient.lastPrompt).toContain('Met at conference')
    })
  })

  describe('generateCheckInMessage', () => {
    it('should generate gentle check-in message', async () => {
      mockClient.setMockResponse(
        'Hi, I hope this message finds you well. I wanted to check in regarding my application...'
      )

      const context: MessageContext = {
        userName: 'John Doe',
        companyName: 'Acme Corp',
        jobTitle: 'Senior Backend Engineer',
        stage: 'screen',
        daysSinceLastActivity: 10,
      }

      const message = await generateCheckInMessage(mockClient, context)

      expect(message).toBeDefined()
      expect(mockClient.lastPrompt).toContain('check-in')
    })
  })
})

describe('CoachAgent', () => {
  let agent: CoachAgent
  let mockClient: MockLLMClient

  beforeEach(() => {
    mockClient = new MockLLMClient()
    agent = new CoachAgent({ llmClient: mockClient })
  })

  describe('constructor', () => {
    it('should have correct name and description', () => {
      expect(agent.name).toBe('Coach')
      expect(agent.description).toContain('follow-up')
    })
  })

  describe('execute', () => {
    it('should return error if no applications provided', async () => {
      const context = createTestContext({ applications: [] })
      const result = await agent.execute(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('No applications')
    })

    it('should return error if no user profile provided', async () => {
      const context = createTestContext()
      // @ts-expect-error - Testing missing user
      context.user = undefined

      const result = await agent.execute(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('No user profile')
    })

    it('should suggest follow-up for application that needs it', async () => {
      mockClient.setMockResponse(
        'Hi, I wanted to follow up on my application for the Senior Backend Engineer position...'
      )

      const context = createTestContext()
      const result = await agent.execute(context)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.applicationId).toBe('app-1')
      expect(result.data?.suggestion).toBeDefined()
    })

    it('should not suggest follow-up for recent application', async () => {
      const context = createTestContext({
        applications: [
          createTestApplication({
            appliedAt: new Date(), // Applied today
          }),
        ],
      })

      const result = await agent.execute(context)

      expect(result.success).toBe(true)
      expect(result.data?.suggestion).toContain('too soon')
    })

    it('should include draft message when follow-up is suggested', async () => {
      mockClient.setMockResponse(
        'Hi, I wanted to follow up on my application for the Senior Backend Engineer position...'
      )

      const context = createTestContext()
      const result = await agent.execute(context)

      expect(result.success).toBe(true)
      expect(result.data?.draftMessage).toBeDefined()
      expect(result.data?.draftMessage?.length).toBeGreaterThan(0)
    })

    it('should suggest contacts for the company if available', async () => {
      mockClient.setMockResponse('Hi, I wanted to follow up...')

      const context = createExtendedTestContext()
      const result = await agent.execute(context)

      expect(result.success).toBe(true)
      expect(result.data?.suggestedContacts).toBeDefined()
      expect(result.data?.suggestedContacts).toContain('Jane Smith')
    })

    it('should include metadata with duration', async () => {
      mockClient.setMockResponse('Follow up message...')

      const context = createTestContext()
      const result = await agent.execute(context)

      expect(result.metadata).toBeDefined()
      expect(result.metadata?.duration).toBeGreaterThanOrEqual(0)
    })

    it('should handle LLM errors gracefully by falling back to templates', async () => {
      mockClient.simulateError('API rate limit exceeded')

      const context = createTestContext()
      const result = await agent.execute(context)

      // Agent should still succeed by falling back to template
      expect(result.success).toBe(true)
      expect(result.data?.draftMessage).toBeDefined()
      // The fallback template should be used
      expect(result.data?.draftMessage).toContain('Dear Hiring Manager')
    })
  })

  describe('getSuggestedMessageType', () => {
    it('should suggest thank you message after interview', () => {
      const application = createTestApplication({
        stage: 'interview',
        appliedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      })

      const messageType = agent.getSuggestedMessageType(application)
      expect(messageType).toBe('thank_you')
    })

    it('should suggest follow up message for stale applications', () => {
      const application = createTestApplication({
        stage: 'applied',
        appliedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      })

      const messageType = agent.getSuggestedMessageType(application)
      expect(messageType).toBe('follow_up')
    })

    it('should suggest check in for screen stage', () => {
      const application = createTestApplication({
        stage: 'screen',
        appliedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      })

      const messageType = agent.getSuggestedMessageType(application)
      expect(messageType).toBe('check_in')
    })
  })
})
