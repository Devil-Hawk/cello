// Email classification: LLM-based (when an OpenRouter key is present) with a
// regex/pattern fallback that always works. Both paths return the same
// ParsedEmail shape and both are explicitly told the sending domain may be
// an ATS, not the employer.

import type { ParsedEmail } from './types'
import { inboxClassifyStep } from '../steps'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { frameJobText } from '../security/job-text'
import type { DecryptedApiKeys, LlmRunner } from '../harness/types'
import { warnLlmFallback } from '../observability/llm-fallback'
import { extractEmployerFromContent } from './employer'
import { isAtsOrJobBoardDomain, isAtsOrJobBoardName } from './skip-lists'
import { extractInterviewDateTime, normalizeIsoDateTime } from './datetime'

/** Cheap on purpose: one short classification per email, run in bulk on every sync. */
export const CLASSIFY_MODEL = 'google/gemini-2.0-flash-001'

const VALID_STATUSES = ['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected']

function extractDomain(email: string): string | null {
  const match = email.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1].toLowerCase() : null
}

function normalizeSpace(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The user message: the email as one fenced block of third-party text. */
function buildPrompt(from: string, subject: string, body: string): string {
  return frameJobText(`From: ${from}\nSubject: ${subject}\n\n${body}`, { label: 'EMAIL', maxChars: 3200 })
}

/**
 * Classify one email with the injected model. Throws when the model fails or its
 * answer cannot be read, so the caller can fall back to the patterns and say why.
 *
 * A status other than `unknown` has to come with an `evidence` quote that is
 * really in the subject or body; without one the status is `unknown` and the
 * confidence 0, so a hallucinated rejection cannot move a live application.
 * A missing confidence is 0, not a middling guess.
 */
export async function classifyEmailWith(
  run: LlmRunner,
  from: string,
  subject: string,
  body: string,
  referenceDate: Date
): Promise<ParsedEmail> {
  const fromDomain = extractDomain(from)
  const senderIsAts = isAtsOrJobBoardDomain(fromDomain)

  const response = await run({
    system: composeSystemPrompt({ mode: loadModeDoc('gmail_classify'), includeVoice: false }),
    promptRef: promptRef('gmail_classify'),
    prompt: buildPrompt(from, subject, body),
    json: true,
    maxTokens: 350,
    temperature: 0.1,
  })

  const content = response.content || '{}'
  const jsonStr = content.trim().replace(/```json\s*/gi, '').replace(/```\s*/gi, '')
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('no JSON in LLM response')
  const parsed = JSON.parse(jsonMatch[0])

  if (parsed.isJobRelated === false) {
    return {
      companyName: null,
      jobTitle: null,
      status: 'unknown',
      companyDomain: null,
      careerPageUrl: null,
      confidence: 0,
      isJobRelated: false,
      reasoning: parsed.reasoning || null,
      interviewDateTime: null,
    }
  }

  // Never trust an ATS/job-board domain as the employer, even if the model
  // hallucinated one back.
  let employerDomain: string | null =
    typeof parsed.employerDomain === 'string' ? parsed.employerDomain.toLowerCase().trim() || null : null
  if (isAtsOrJobBoardDomain(employerDomain)) employerDomain = null
  if (!employerDomain && !senderIsAts) employerDomain = fromDomain

  let employerName: string | null = typeof parsed.employerName === 'string' ? parsed.employerName.trim() || null : null
  // Guard against the model naming the ATS itself as the employer.
  if (employerName && (isAtsOrJobBoardDomain(employerName.toLowerCase().replace(/\s+/g, '')) || isAtsOrJobBoardName(employerName))) {
    employerName = null
  }

  // If the sender is an ATS and the model still failed to extract a real
  // employer, fall back to our own heuristic extraction before giving up.
  if (senderIsAts && !employerName && !employerDomain) {
    const guess = extractEmployerFromContent(from, subject, body)
    employerName = guess.name
    employerDomain = guess.domain
  }

  let status: ParsedEmail['status'] = VALID_STATUSES.includes(parsed.status) ? parsed.status : 'unknown'
  let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
  if (status !== 'unknown') {
    const quote = typeof parsed.evidence === 'string' ? normalizeSpace(parsed.evidence) : ''
    if (quote.length < 8 || !normalizeSpace(`${subject}\n${body}`).includes(quote)) {
      status = 'unknown'
      confidence = 0
    }
  }

  return {
    companyName: employerName,
    jobTitle: typeof parsed.jobTitle === 'string' ? parsed.jobTitle.trim() || null : null,
    status,
    companyDomain: employerDomain,
    careerPageUrl: typeof parsed.careerPageUrl === 'string' ? parsed.careerPageUrl : null,
    confidence,
    isJobRelated: parsed.isJobRelated !== false,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
    interviewDateTime: normalizeIsoDateTime(parsed.interviewDateTime, referenceDate),
  }
}

/**
 * Use an LLM (through the inbox.classify step, so budget-checked, spend-recorded and traced) to
 * parse an email into structured job-application info. Takes the whole
 * DecryptedApiKeys (with userId), never a bare key: without a userId it
 * cannot meter or trace the call.
 */
export async function parseEmailWithAI(
  from: string,
  subject: string,
  body: string,
  apiKeys: DecryptedApiKeys,
  referenceDate: Date
): Promise<ParsedEmail> {
  try {
    return await classifyEmailWith(
      (opts) =>
        inboxClassifyStep.call(apiKeys, {
          ...opts,
          model: CLASSIFY_MODEL,
          // The account-wide default effort would add thinking tokens to a call
          // that never used them.
          reasoning: { effort: 'none' },
        }),
      from,
      subject,
      body,
      referenceDate
    )
  } catch (err) {
    // Fall through to the regex/pattern-based classifier below, but say why: a
    // 402, a retired model or a spent budget must not look like "the model
    // found nothing".
    warnLlmFallback('gmail-classify', 'regex-patterns', err)
  }

  return classifyWithPatterns(from, subject, body, referenceDate)
}

// --- Regex/pattern fallback (no LLM key configured, or LLM call failed) ---

interface StatusPattern {
  pattern: RegExp
  status: ParsedEmail['status']
  confidence: number
  /** Words that must be in the same sentence for the phrase to count: marketing uses these phrases too. */
  context?: RegExp
}

const ABOUT_APPLICATION = /application|applied|applying|candidacy|position|role|interview/i
const ABOUT_SCHEDULING = /application|candidacy|position|role|interview|call|chat|conversation/i

const STATUS_PATTERNS: StatusPattern[] = [
  { pattern: /thank you for (applying|your application)/i, status: 'applied', confidence: 0.85 },
  { pattern: /thank you for your interest/i, status: 'applied', confidence: 0.8, context: ABOUT_APPLICATION },
  { pattern: /application (received|confirmed|submitted)/i, status: 'applied', confidence: 0.9 },
  { pattern: /we('d| would) (like|love) to (schedule|set up|invite|move forward)/i, status: 'screen', confidence: 0.85, context: ABOUT_SCHEDULING },
  { pattern: /phone (screen|interview|call)/i, status: 'screen', confidence: 0.8 },
  { pattern: /technical interview/i, status: 'interview', confidence: 0.85 },
  { pattern: /on-?site interview/i, status: 'interview', confidence: 0.9 },
  { pattern: /final (round|interview)/i, status: 'interview', confidence: 0.85 },
  { pattern: /interview (is )?(confirmed|scheduled)/i, status: 'interview', confidence: 0.85 },
  { pattern: /we('re| are) (pleased|excited|happy) to (offer|extend)/i, status: 'offer', confidence: 0.95 },
  { pattern: /offer letter/i, status: 'offer', confidence: 0.9 },
  { pattern: /welcome to the team|excited to have you join|welcome aboard/i, status: 'accepted', confidence: 0.75 },
  { pattern: /unfortunately|regret to inform/i, status: 'rejected', confidence: 0.85, context: ABOUT_APPLICATION },
  { pattern: /other candidates|moved forward with other/i, status: 'rejected', confidence: 0.8 },
  { pattern: /position has been filled/i, status: 'rejected', confidence: 0.9 },
  { pattern: /not moving forward/i, status: 'rejected', confidence: 0.85 },
]

const STATUS_PRIORITY: ParsedEmail['status'][] = ['offer', 'accepted', 'rejected', 'interview', 'screen', 'applied']

/** Job board digests and alerts are never about one application. */
const DIGEST_SUBJECT = /jobs you may like|recommended jobs|new jobs for you|job alert/i
/** Footers that mark bulk marketing mail. */
const MARKETING_FOOTER = /unsubscribe|view (this|it) in (your )?browser|manage (your )?(email )?preferences|email preferences/i
/** A phrase that is about one application even in a mail with a footer (ATS mail has one too). */
const STRONG_APPLICATION = /application (received|confirmed|submitted)|thank you for (applying|your application)|your application (to|for|has|was)|interview (is )?(confirmed|scheduled)|offer letter|we('re| are) (pleased|excited|happy) to (offer|extend)|not moving forward|other candidates/i

function matchesInSentence(text: string, pattern: RegExp, context: RegExp): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => pattern.test(sentence) && context.test(sentence))
}

function detectStatusFromPatterns(subject: string, body: string): { status: ParsedEmail['status']; confidence: number } {
  if (DIGEST_SUBJECT.test(subject)) return { status: 'unknown', confidence: 0 }
  const text = `${subject}\n${body}`
  // Bulk mail with an unsubscribe footer is marketing unless it also says something about one application.
  if (MARKETING_FOOTER.test(text) && !STRONG_APPLICATION.test(text)) return { status: 'unknown', confidence: 0 }
  // A decision outranks a confirmation: "thank you for your interest ... unfortunately"
  // is a rejection, not an application received.
  for (const wanted of STATUS_PRIORITY) {
    for (const { pattern, status, confidence, context } of STATUS_PATTERNS) {
      if (status !== wanted) continue
      if (context ? matchesInSentence(text, pattern, context) : pattern.test(text)) return { status, confidence }
    }
  }
  return { status: 'unknown', confidence: 0 }
}

/** Deterministic classifier used when no LLM key is configured. */
export function classifyWithPatterns(from: string, subject: string, body: string, referenceDate: Date, calendar?: string): ParsedEmail {
  const { status, confidence } = detectStatusFromPatterns(subject, body)
  const employer = extractEmployerFromContent(from, subject, body)

  return {
    companyName: employer.name,
    jobTitle: null,
    status,
    companyDomain: employer.domain,
    careerPageUrl: null,
    confidence,
    isJobRelated: status !== 'unknown',
    reasoning: null,
    interviewDateTime:
      status === 'interview' || status === 'screen'
        ? extractInterviewDateTime(`${subject}\n${body}`, referenceDate, calendar).iso
        : null,
  }
}
