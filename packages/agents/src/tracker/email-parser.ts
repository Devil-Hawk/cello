import type { PipelineStage } from '@cello/shared'
import type { EmailInput, ParsedEmail, StatusSignal, EmailPattern } from './types'

/**
 * Email patterns for detecting application status changes.
 * Ordered by specificity - more specific patterns first.
 */
export const EMAIL_PATTERNS: EmailPattern[] = [
  // Offer patterns (highest confidence)
  {
    pattern: /we['']re pleased to offer/i,
    stage: 'offer',
    confidence: 0.95,
    source: 'both',
  },
  {
    pattern: /pleased to extend.{0,20}offer/i,
    stage: 'offer',
    confidence: 0.95,
    source: 'both',
  },
  {
    pattern: /offer letter/i,
    stage: 'offer',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /formal offer/i,
    stage: 'offer',
    confidence: 0.9,
    source: 'both',
  },

  // Rejection patterns
  {
    pattern: /position has been filled/i,
    stage: 'rejected',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /unfortunately/i,
    stage: 'rejected',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /other candidates/i,
    stage: 'rejected',
    confidence: 0.8,
    source: 'both',
  },
  {
    pattern: /not (moving|proceeding) forward/i,
    stage: 'rejected',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /regret to inform/i,
    stage: 'rejected',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /decided not to (move|proceed)/i,
    stage: 'rejected',
    confidence: 0.85,
    source: 'both',
  },

  // Interview patterns
  {
    pattern: /onsite interview/i,
    stage: 'interview',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /on-site interview/i,
    stage: 'interview',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /technical interview/i,
    stage: 'interview',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /coding interview/i,
    stage: 'interview',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /final.{0,10}interview/i,
    stage: 'interview',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /interview.{0,10}panel/i,
    stage: 'interview',
    confidence: 0.85,
    source: 'both',
  },

  // Screen patterns
  {
    pattern: /we['']d like to schedule/i,
    stage: 'screen',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /like to schedule/i,
    stage: 'screen',
    confidence: 0.8,
    source: 'both',
  },
  {
    pattern: /phone interview/i,
    stage: 'screen',
    confidence: 0.8,
    source: 'both',
  },
  {
    pattern: /phone screen/i,
    stage: 'screen',
    confidence: 0.8,
    source: 'both',
  },
  {
    pattern: /initial (call|conversation|chat)/i,
    stage: 'screen',
    confidence: 0.75,
    source: 'both',
  },
  {
    pattern: /recruiter (call|screen)/i,
    stage: 'screen',
    confidence: 0.8,
    source: 'both',
  },
  {
    pattern: /schedule.{0,20}(call|conversation)/i,
    stage: 'screen',
    confidence: 0.75,
    source: 'both',
  },

  // Applied patterns
  {
    pattern: /thank you for applying/i,
    stage: 'applied',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /thanks for applying/i,
    stage: 'applied',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /application received/i,
    stage: 'applied',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /received your application/i,
    stage: 'applied',
    confidence: 0.9,
    source: 'both',
  },
  {
    pattern: /application.{0,10}submitted/i,
    stage: 'applied',
    confidence: 0.85,
    source: 'both',
  },
  {
    pattern: /successfully applied/i,
    stage: 'applied',
    confidence: 0.9,
    source: 'both',
  },
]

/**
 * Normalize text for pattern matching
 * - Lowercase
 * - Collapse whitespace
 * - Remove excessive punctuation
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse an email and prepare it for pattern matching
 */
export function parseEmail(email: EmailInput): ParsedEmail {
  return {
    id: email.id,
    from: email.from,
    subject: email.subject,
    body: email.body,
    normalizedSubject: normalizeText(email.subject),
    normalizedBody: normalizeText(email.body),
    receivedAt: email.receivedAt,
  }
}

/**
 * Extract status signals from an email by matching patterns
 * Returns all matching signals sorted by confidence (highest first)
 */
export function extractStatusSignals(email: EmailInput): StatusSignal[] {
  const parsed = parseEmail(email)
  const signals: StatusSignal[] = []
  const seenStages = new Set<PipelineStage>()

  for (const pattern of EMAIL_PATTERNS) {
    let matched = false
    let matchSource = ''

    // Check subject
    if (pattern.source === 'subject' || pattern.source === 'both') {
      if (pattern.pattern.test(parsed.normalizedSubject)) {
        matched = true
        matchSource = 'subject'
      }
    }

    // Check body
    if (pattern.source === 'body' || pattern.source === 'both') {
      if (pattern.pattern.test(parsed.normalizedBody)) {
        matched = true
        matchSource = matchSource ? 'subject and body' : 'body'
      }
    }

    if (matched && !seenStages.has(pattern.stage)) {
      signals.push({
        stage: pattern.stage,
        confidence: pattern.confidence,
        reason: `Pattern "${pattern.pattern.source}" matched in ${matchSource}`,
      })
      // Only add the highest confidence match per stage
      seenStages.add(pattern.stage)
    }
  }

  // Sort by confidence descending
  return signals.sort((a, b) => b.confidence - a.confidence)
}
