// release/1 email classification, frozen for the "before" measurement: the inline
// model prompt, the pattern fallback and the reply mapping. Not used by the app.

import type { LlmRunner } from '@/lib/harness/types'

type Status = 'applied' | 'screen' | 'interview' | 'offer' | 'accepted' | 'rejected' | 'unknown'
const VALID_STATUSES = ['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected']

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


export interface LegacyParsed {
  isJobRelated: boolean
  status: Status
  confidence: number
}

/** The model path as release/1 ran it: trust the status, default a missing confidence to 0.5. */
export async function legacyClassifyWithModel(run: LlmRunner, from: string, subject: string, body: string): Promise<LegacyParsed> {
  const response = await run({ prompt: buildPrompt(from, subject, body), json: true, maxTokens: 350, temperature: 0.1 })
  const jsonStr = (response.content || '{}').trim().replace(/```json\s*/gi, '').replace(/```\s*/gi, '')
  const jsonMatch = jsonStr.match(/\{[\s\S]*?\}(?=\s*$|\s*[^{]|$)/)
  if (!jsonMatch) throw new Error('no JSON in LLM response')
  const parsed = JSON.parse(jsonMatch[0])
  if (parsed.isJobRelated === false) return { isJobRelated: false, status: 'unknown', confidence: 0 }
  return {
    isJobRelated: parsed.isJobRelated !== false,
    status: VALID_STATUSES.includes(parsed.status) ? parsed.status : 'unknown',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  }
}

const STATUS_PATTERNS: Array<{ pattern: RegExp; status: Status; confidence: number }> = [
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

function detectStatusFromPatterns(subject: string, body: string): { status: Status; confidence: number } {
  const text = `${subject} ${body}`.toLowerCase()
  for (const { pattern, status, confidence } of STATUS_PATTERNS) {
    if (pattern.test(text)) return { status, confidence }
  }
  return { status: 'unknown', confidence: 0 }
}


/** The pattern path as release/1 ran it. */
export function legacyPatternStatus(subject: string, body: string): Status {
  return detectStatusFromPatterns(subject, body).status
}

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery subsystem/i
const BOUNCE_SUBJECT = /undeliverable|delivery (has )?fail|delivery status notification|returned to sender/i

/**
 * Coarse polarity for an inbound reply matched to an outreach thread —
 * positive|neutral|negative|bounce, NOT the Status vocabulary the
 * rest of this classifier speaks (a reply "sounds good, let's talk Tuesday"
 * has no job-application stage). Reduces the SAME parsed status the sync
 * loop already computed for the job-application pipeline down to what the
 * reward signal (lib/strategy/questions/outreachImpact.ts) needs: did this
 * contact engage, and how. Pure — no I/O; the write lives in
 * lib/outreach/store.ts#recordOutreachReply.
 */
export function legacyClassifyReply(from: string, subject: string, status: Status): 'positive' | 'neutral' | 'negative' | 'bounce' {
  if (BOUNCE_SENDER.test(from) || BOUNCE_SUBJECT.test(subject)) return 'bounce'
  if (status === 'rejected') return 'negative'
  if (status === 'unknown') return 'neutral'
  // applied | screen | interview | offer | accepted — any forward-moving
  // signal the classifier detected reads as engagement.
  return 'positive'
}
