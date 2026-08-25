// Email classification: LLM-based (when an OpenRouter key is present) with a
// regex/pattern fallback that always works. Both paths return the same
// ParsedEmail shape and both are explicitly told the sending domain may be
// an ATS, not the employer.

import OpenAI from 'openai'
import type { ParsedEmail } from './types'
import { extractEmployerFromContent } from './employer'
import { isAtsOrJobBoardDomain } from './skip-lists'
import { extractInterviewDateTime, normalizeIsoDateTime } from './datetime'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const VALID_STATUSES = ['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected']

function extractDomain(email: string): string | null {
  const match = email.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1].toLowerCase() : null
}

function buildPrompt(from: string, subject: string, body: string): string {
  return `You are a strict email classifier determining if an email is DIRECTLY related to a specific job application the user submitted, and — if so — who the REAL employer is.

EMAIL DETAILS:
From: ${from}
Subject: ${subject}
Body:
${body.substring(0, 3000)}

CRITICAL RULES - BE CONSERVATIVE:
1. ONLY mark as job-related if it's a DIRECT response to a job application the user submitted
2. FALSE POSITIVES TO AVOID:
   - Company newsletters or marketing emails (even from recruiters)
   - Job board digest emails (LinkedIn jobs, Indeed weekly)
   - General career advice or tips
   - Promotional content mentioning "careers" or "opportunities"
   - Cold outreach from recruiters about roles user didn't apply to
   - Welcome emails from job boards
   - Password reset or account emails from career sites
3. TRUE POSITIVES - Email should contain:
   - Specific reference to a role/position the user applied for
   - "Thank you for applying to [specific role]"
   - Interview scheduling for a specific position
   - Offer or rejection for a specific application
   - Reference to user's resume/application being reviewed
4. THE SENDING DOMAIN IS OFTEN NOT THE EMPLOYER. Applicant-tracking systems
   and job boards (Greenhouse, Lever, Ashby, Workday, iCIMS, Taleo,
   SmartRecruiters, Jobvite, LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice,
   Wellfound, Hired, Otta, Monster, SEEK, or any "...@notifications.*",
   "...@mail.*" address for one of these) send email ON BEHALF OF the real
   employer. When the sender looks like one of these, you MUST extract the
   real employer's name from the subject/body/signature — do NOT return the
   ATS's own name (e.g. never return "Greenhouse" as employerName) and do
   NOT return the ATS's domain as employerDomain.

RESPONSE FORMAT - Return ONLY this JSON:
{
  "isJobRelated": boolean,
  "employerName": "Real hiring company name (not the ATS/job board), or null",
  "employerDomain": "employer's own domain, e.g. acme.com — never greenhouse.io/lever.co/etc, or null",
  "jobTitle": "Specific Job Title or null",
  "status": "applied|screen|interview|offer|accepted|rejected|unknown",
  "careerPageUrl": "https://careers.company.com or null",
  "interviewDateTime": "ISO 8601 datetime if a specific interview/screen date+time is mentioned, else null",
  "confidence": 0.0,
  "reasoning": "Brief explanation of why this is/isn't job-related"
}

STATUS DEFINITIONS:
- "applied": Direct confirmation of a submitted application
- "screen": Phone screen or recruiter call SCHEDULED (not "we may contact you")
- "interview": Technical/onsite interview CONFIRMED (not just mentioned)
- "offer": Explicit job offer with salary/start date discussion
- "accepted": User's acceptance of an offer is confirmed (e.g. "welcome to the team", signed contract/start date confirmed)
- "rejected": Clear rejection ("we decided to move forward with other candidates")
- "unknown": Email is not about a specific job application

CONFIDENCE SCORING:
- 0.85-1.0: Definite application email with specific job title and clear action
- 0.70-0.85: Very likely application-related but missing some details
- 0.50-0.70: Possibly related but could be marketing/newsletter
- 0.0-0.50: Not job-application-related or too ambiguous

IMPORTANT: When in doubt, set isJobRelated=false and status="unknown". It's better to miss some emails than create false entries.

Return ONLY the JSON object, no markdown.`
}

/** Use an LLM (via OpenRouter) to parse an email into structured job-application info. */
export async function parseEmailWithAI(
  from: string,
  subject: string,
  body: string,
  apiKey: string,
  referenceDate: Date
): Promise<ParsedEmail> {
  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': 'https://cello.app',
      'X-Title': 'Cello - Job Search Assistant',
    },
  })

  const fromDomain = extractDomain(from)
  const senderIsAts = isAtsOrJobBoardDomain(fromDomain)

  try {
    const response = await client.chat.completions.create({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: 350,
      temperature: 0.1,
      messages: [{ role: 'user', content: buildPrompt(from, subject, body) }],
    })

    const content = response.choices[0]?.message?.content || '{}'
    let jsonStr = content.trim()
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '')

    const jsonMatch = jsonStr.match(/\{[\s\S]*?\}(?=\s*$|\s*[^{]|$)/)
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

    let employerName: string | null =
      typeof parsed.employerName === 'string' ? parsed.employerName.trim() || null : null
    // Guard against the model naming the ATS itself as the employer.
    if (employerName && isAtsOrJobBoardDomain(employerName.toLowerCase().replace(/\s+/g, ''))) {
      employerName = null
    }

    // If the sender is an ATS and the model still failed to extract a real
    // employer, fall back to our own heuristic extraction before giving up.
    if (senderIsAts && !employerName && !employerDomain) {
      const guess = extractEmployerFromContent(from, subject, body)
      employerName = guess.name
      employerDomain = guess.domain
    }

    return {
      companyName: employerName,
      jobTitle: typeof parsed.jobTitle === 'string' ? parsed.jobTitle.trim() || null : null,
      status: VALID_STATUSES.includes(parsed.status) ? parsed.status : 'unknown',
      companyDomain: employerDomain,
      careerPageUrl: typeof parsed.careerPageUrl === 'string' ? parsed.careerPageUrl : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      isJobRelated: parsed.isJobRelated !== false,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
      interviewDateTime: normalizeIsoDateTime(parsed.interviewDateTime, referenceDate),
    }
  } catch {
    // Fall through to the regex/pattern-based classifier below.
  }

  return classifyWithPatterns(from, subject, body, referenceDate)
}

// --- Regex/pattern fallback (no LLM key configured, or LLM call failed) ---

const STATUS_PATTERNS: Array<{ pattern: RegExp; status: ParsedEmail['status']; confidence: number }> = [
  { pattern: /thank you for (applying|your application|your interest)/i, status: 'applied', confidence: 0.85 },
  { pattern: /application (received|confirmed|submitted)/i, status: 'applied', confidence: 0.9 },
  { pattern: /we('d| would) (like|love) to (schedule|invite|move forward)/i, status: 'screen', confidence: 0.85 },
  { pattern: /phone (screen|interview|call)/i, status: 'screen', confidence: 0.8 },
  { pattern: /technical interview/i, status: 'interview', confidence: 0.85 },
  { pattern: /on-?site interview/i, status: 'interview', confidence: 0.9 },
  { pattern: /final (round|interview)/i, status: 'interview', confidence: 0.85 },
  { pattern: /interview (is )?(confirmed|scheduled)/i, status: 'interview', confidence: 0.85 },
  { pattern: /we('re| are) (pleased|excited|happy) to (offer|extend)/i, status: 'offer', confidence: 0.95 },
  { pattern: /offer letter/i, status: 'offer', confidence: 0.9 },
  { pattern: /welcome to the team|excited to have you join|welcome aboard/i, status: 'accepted', confidence: 0.75 },
  { pattern: /unfortunately|regret to inform/i, status: 'rejected', confidence: 0.85 },
  { pattern: /other candidates|moved forward with other/i, status: 'rejected', confidence: 0.8 },
  { pattern: /position has been filled/i, status: 'rejected', confidence: 0.9 },
  { pattern: /not moving forward/i, status: 'rejected', confidence: 0.85 },
]

function detectStatusFromPatterns(subject: string, body: string): { status: ParsedEmail['status']; confidence: number } {
  const text = `${subject} ${body}`.toLowerCase()
  for (const { pattern, status, confidence } of STATUS_PATTERNS) {
    if (pattern.test(text)) return { status, confidence }
  }
  return { status: 'unknown', confidence: 0 }
}

/** Deterministic classifier used when no LLM key is configured. */
export function classifyWithPatterns(from: string, subject: string, body: string, referenceDate: Date): ParsedEmail {
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
        ? extractInterviewDateTime(`${subject}\n${body}`, referenceDate).iso
        : null,
  }
}
