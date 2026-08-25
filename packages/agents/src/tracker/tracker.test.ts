import { describe, it, expect, beforeEach } from 'vitest'
import { TrackerAgent } from './index'
import { parseEmail, extractStatusSignals } from './email-parser'
import { detectStatus, mapSignalToStage } from './status-detector'
import { detectGhosting, getGhostStatus, GhostStatus } from './ghost-detector'
import type { EmailInput, StatusSignal } from './types'
import type { Application } from '@cello/shared'
import { GHOST_THRESHOLDS } from '@cello/shared'

describe('Email Parser', () => {
  describe('parseEmail', () => {
    it('should parse email with subject and body', () => {
      const email: EmailInput = {
        id: 'email-1',
        from: 'recruiter@company.com',
        subject: 'Thank you for applying to Software Engineer',
        body: 'We have received your application and will review it shortly.',
        receivedAt: new Date('2024-01-15'),
      }

      const result = parseEmail(email)

      expect(result.id).toBe('email-1')
      expect(result.from).toBe('recruiter@company.com')
      expect(result.normalizedSubject).toBe('thank you for applying to software engineer')
      expect(result.normalizedBody).toContain('received your application')
    })

    it('should handle empty subject', () => {
      const email: EmailInput = {
        id: 'email-2',
        from: 'hr@company.com',
        subject: '',
        body: 'Your application status update.',
        receivedAt: new Date(),
      }

      const result = parseEmail(email)
      expect(result.normalizedSubject).toBe('')
    })

    it('should handle empty body', () => {
      const email: EmailInput = {
        id: 'email-3',
        from: 'noreply@company.com',
        subject: 'Application Update',
        body: '',
        receivedAt: new Date(),
      }

      const result = parseEmail(email)
      expect(result.normalizedBody).toBe('')
    })
  })

  describe('extractStatusSignals', () => {
    it('should detect "Thank you for applying" pattern', () => {
      const email: EmailInput = {
        id: 'email-1',
        from: 'recruiter@company.com',
        subject: 'Thank you for applying to our position',
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('applied')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect "application received" pattern', () => {
      const email: EmailInput = {
        id: 'email-2',
        from: 'hr@company.com',
        subject: 'Your application received',
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('applied')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect "schedule" pattern for screen stage', () => {
      const email: EmailInput = {
        id: 'email-3',
        from: 'recruiter@company.com',
        subject: "We'd like to schedule a call",
        body: 'Please let us know your availability for a phone screen.',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals.some((s) => s.stage === 'screen')).toBe(true)
    })

    it('should detect "phone interview" pattern', () => {
      const email: EmailInput = {
        id: 'email-4',
        from: 'recruiter@company.com',
        subject: 'Phone interview scheduled',
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('screen')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.8)
    })

    it('should detect "technical interview" pattern', () => {
      const email: EmailInput = {
        id: 'email-5',
        from: 'recruiter@company.com',
        subject: 'Technical interview next steps',
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('interview')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.85)
    })

    it('should detect "onsite interview" pattern', () => {
      const email: EmailInput = {
        id: 'email-6',
        from: 'recruiter@company.com',
        subject: 'Onsite interview invitation',
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('interview')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect "pleased to offer" pattern', () => {
      const email: EmailInput = {
        id: 'email-7',
        from: 'hr@company.com',
        subject: "We're pleased to offer you the position",
        body: '',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('offer')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.95)
    })

    it('should detect "offer letter" pattern', () => {
      const email: EmailInput = {
        id: 'email-8',
        from: 'hr@company.com',
        subject: 'Your offer letter is attached',
        body: 'Please review and sign the attached offer letter.',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('offer')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect "unfortunately" pattern for rejection', () => {
      const email: EmailInput = {
        id: 'email-9',
        from: 'recruiter@company.com',
        subject: 'Update on your application',
        body: 'Unfortunately, we have decided to move forward with other candidates.',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals.some((s) => s.stage === 'rejected')).toBe(true)
    })

    it('should detect "other candidates" pattern', () => {
      const email: EmailInput = {
        id: 'email-10',
        from: 'hr@company.com',
        subject: 'Application status',
        body: 'We have decided to proceed with other candidates at this time.',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals.some((s) => s.stage === 'rejected')).toBe(true)
    })

    it('should detect "position has been filled" pattern', () => {
      const email: EmailInput = {
        id: 'email-11',
        from: 'recruiter@company.com',
        subject: 'Position filled',
        body: 'The position has been filled. Thank you for your interest.',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals.length).toBeGreaterThan(0)
      expect(signals[0].stage).toBe('rejected')
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should return empty array for unrecognized patterns', () => {
      const email: EmailInput = {
        id: 'email-12',
        from: 'newsletter@company.com',
        subject: 'Company newsletter update',
        body: 'Check out our latest blog posts!',
        receivedAt: new Date(),
      }

      const signals = extractStatusSignals(email)

      expect(signals).toEqual([])
    })
  })
})

describe('Status Detector', () => {
  describe('detectStatus', () => {
    it('should return highest confidence signal', () => {
      const signals: StatusSignal[] = [
        { stage: 'applied', confidence: 0.9, reason: 'Pattern: thank you for applying' },
        { stage: 'screen', confidence: 0.6, reason: 'Pattern: schedule' },
      ]

      const result = detectStatus(signals)

      expect(result).not.toBeNull()
      expect(result?.stage).toBe('applied')
      expect(result?.confidence).toBe(0.9)
    })

    it('should return null for empty signals', () => {
      const result = detectStatus([])

      expect(result).toBeNull()
    })

    it('should return null for low confidence signals', () => {
      const signals: StatusSignal[] = [
        { stage: 'applied', confidence: 0.3, reason: 'Weak pattern match' },
      ]

      const result = detectStatus(signals, 0.5)

      expect(result).toBeNull()
    })

    it('should respect custom confidence threshold', () => {
      const signals: StatusSignal[] = [
        { stage: 'interview', confidence: 0.7, reason: 'Pattern match' },
      ]

      const resultLow = detectStatus(signals, 0.5)
      const resultHigh = detectStatus(signals, 0.8)

      expect(resultLow).not.toBeNull()
      expect(resultHigh).toBeNull()
    })
  })

  describe('mapSignalToStage', () => {
    it('should map applied signal correctly', () => {
      const signal: StatusSignal = {
        stage: 'applied',
        confidence: 0.9,
        reason: 'Pattern match',
      }

      const stage = mapSignalToStage(signal)
      expect(stage).toBe('applied')
    })

    it('should map offer signal correctly', () => {
      const signal: StatusSignal = {
        stage: 'offer',
        confidence: 0.95,
        reason: 'Pattern match',
      }

      const stage = mapSignalToStage(signal)
      expect(stage).toBe('offer')
    })
  })
})

describe('Ghost Detector', () => {
  const now = new Date('2024-01-20')

  describe('getGhostStatus', () => {
    it('should return NONE for recent activity (< 7 days)', () => {
      const lastActivityDate = new Date('2024-01-15') // 5 days ago

      const status = getGhostStatus(lastActivityDate, now)

      expect(status).toBe(GhostStatus.NONE)
    })

    it('should return WARNING for 7+ days of silence', () => {
      const lastActivityDate = new Date('2024-01-13') // 7 days ago

      const status = getGhostStatus(lastActivityDate, now)

      expect(status).toBe(GhostStatus.WARNING)
    })

    it('should return FOLLOW_UP for 14+ days of silence', () => {
      const lastActivityDate = new Date('2024-01-06') // 14 days ago

      const status = getGhostStatus(lastActivityDate, now)

      expect(status).toBe(GhostStatus.FOLLOW_UP)
    })

    it('should return GHOSTED for 20+ days of silence', () => {
      const lastActivityDate = new Date('2023-12-31') // 20 days ago

      const status = getGhostStatus(lastActivityDate, now)

      expect(status).toBe(GhostStatus.GHOSTED)
    })
  })

  describe('detectGhosting', () => {
    it('should detect ghosted applications and suggest stage change', () => {
      const application: Application = {
        id: 'app-1',
        userId: 'user-1',
        jobId: 'job-1',
        stage: 'interview',
        appliedAt: new Date('2024-01-01'),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2023-12-31'), // 20 days ago
      }

      const result = detectGhosting(application, now)

      expect(result.status).toBe(GhostStatus.GHOSTED)
      expect(result.shouldMoveToGhosted).toBe(true)
      expect(result.daysSinceActivity).toBe(20)
    })

    it('should not suggest stage change for warning status', () => {
      const application: Application = {
        id: 'app-2',
        userId: 'user-1',
        jobId: 'job-2',
        stage: 'screen',
        appliedAt: new Date('2024-01-01'),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-13'), // 7 days ago
      }

      const result = detectGhosting(application, now)

      expect(result.status).toBe(GhostStatus.WARNING)
      expect(result.shouldMoveToGhosted).toBe(false)
      expect(result.daysSinceActivity).toBe(7)
    })

    it('should suggest follow-up for 14+ days', () => {
      const application: Application = {
        id: 'app-3',
        userId: 'user-1',
        jobId: 'job-3',
        stage: 'applied',
        appliedAt: new Date('2024-01-01'),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-06'), // 14 days ago
      }

      const result = detectGhosting(application, now)

      expect(result.status).toBe(GhostStatus.FOLLOW_UP)
      expect(result.shouldFollowUp).toBe(true)
      expect(result.shouldMoveToGhosted).toBe(false)
    })

    it('should not flag applications already in closed states', () => {
      const closedStages = ['closed', 'ghosted', 'rejected', 'offer'] as const

      for (const stage of closedStages) {
        const application: Application = {
          id: `app-${stage}`,
          userId: 'user-1',
          jobId: `job-${stage}`,
          stage,
          appliedAt: new Date('2024-01-01'),
          source: null,
          notes: null,
          resumeVersion: null,
          coverLetter: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2023-12-01'), // Long time ago
        }

        const result = detectGhosting(application, now)

        expect(result.status).toBe(GhostStatus.NONE)
        expect(result.shouldMoveToGhosted).toBe(false)
      }
    })
  })
})

describe('TrackerAgent', () => {
  let agent: TrackerAgent

  beforeEach(() => {
    agent = new TrackerAgent()
  })

  describe('agent metadata', () => {
    it('should have correct name', () => {
      expect(agent.name).toBe('Tracker')
    })

    it('should have description', () => {
      expect(agent.description).toBeDefined()
      expect(agent.description.length).toBeGreaterThan(0)
    })
  })

  describe('execute', () => {
    it('should return error when no applications provided', async () => {
      const result = await agent.execute({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          fullName: 'Test User',
          avatarUrl: null,
          resumeText: null,
          resumeEmbedding: null,
          preferences: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('applications')
    })

    it('should successfully process applications', async () => {
      const result = await agent.execute({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          fullName: 'Test User',
          avatarUrl: null,
          resumeText: null,
          resumeEmbedding: null,
          preferences: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        applications: [
          {
            id: 'app-1',
            userId: 'user-1',
            jobId: 'job-1',
            stage: 'applied',
            appliedAt: new Date(),
            source: null,
            notes: null,
            resumeVersion: null,
            coverLetter: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      })

      expect(result.success).toBe(true)
      expect(result.metadata?.duration).toBeDefined()
    })
  })

  describe('processEmail', () => {
    it('should detect status change from email', () => {
      const email: EmailInput = {
        id: 'email-1',
        from: 'recruiter@company.com',
        subject: "We'd like to schedule a phone interview",
        body: 'Please let us know your availability.',
        receivedAt: new Date(),
      }

      const application: Application = {
        id: 'app-1',
        userId: 'user-1',
        jobId: 'job-1',
        stage: 'applied',
        appliedAt: new Date(),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      const result = agent.processEmail(email, application)

      expect(result).not.toBeNull()
      expect(result?.previousStage).toBe('applied')
      expect(result?.newStage).toBe('screen')
      expect(result?.emailSubject).toBe(email.subject)
    })

    it('should not suggest backward stage transitions', () => {
      const email: EmailInput = {
        id: 'email-2',
        from: 'recruiter@company.com',
        subject: 'Thank you for applying',
        body: 'We received your application.',
        receivedAt: new Date(),
      }

      const application: Application = {
        id: 'app-1',
        userId: 'user-1',
        jobId: 'job-1',
        stage: 'interview', // Already past applied
        appliedAt: new Date(),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      const result = agent.processEmail(email, application)

      // Should not suggest moving backward
      expect(result).toBeNull()
    })

    it('should detect rejection regardless of current stage', () => {
      const email: EmailInput = {
        id: 'email-3',
        from: 'recruiter@company.com',
        subject: 'Application Update',
        body: 'Unfortunately, we have decided to move forward with other candidates.',
        receivedAt: new Date(),
      }

      const application: Application = {
        id: 'app-1',
        userId: 'user-1',
        jobId: 'job-1',
        stage: 'interview',
        appliedAt: new Date(),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      const result = agent.processEmail(email, application)

      expect(result).not.toBeNull()
      expect(result?.newStage).toBe('rejected')
    })
  })

  describe('checkGhosting', () => {
    it('should identify ghosted applications', () => {
      const application: Application = {
        id: 'app-1',
        userId: 'user-1',
        jobId: 'job-1',
        stage: 'interview',
        appliedAt: new Date('2024-01-01'),
        source: null,
        notes: null,
        resumeVersion: null,
        coverLetter: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      }

      // Use a fixed "now" that is 21 days after the updatedAt
      const now = new Date('2024-01-22')
      const result = agent.checkGhosting(application, now)

      expect(result.status).toBe(GhostStatus.GHOSTED)
      expect(result.shouldMoveToGhosted).toBe(true)
    })
  })
})
