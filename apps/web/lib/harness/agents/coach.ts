// Agent: coach — suggests a follow-up action for one application, and drafts
// the message when a follow-up is due.
//
// Ported from packages/agents/src/coach/{index,timing,message-generator,
// templates}.ts onto ctx.llm. The timing math, the message prompts and the
// deterministic fallback templates are pure (no model client, no fetch), so
// they are copied in below rather than imported from '@cello/agents' — the
// langgraph port (docs/superpowers/specs/2026-08-16-langgraph-port-design.md,
// step 12) requires nothing under apps/web to import that package any more.
// Only the thing that ACTUALLY reached a model (packages/agents/src/analyst/
// llm-client.ts's createLLMClient, which CoachAgent also used) is replaced,
// with a one-method LLMClient adapter backed by ctx.llm so
// generateMessageByType's prompt-building code runs unchanged against the
// metered/demo-gated/journaled path.
//
// app/api/agents/coach/route.ts now calls this unit via runUnitOnce('coach',
// ...) instead of constructing packages/agents' CoachAgent directly — see
// that route for the response-shape contract this unit's output must match
// exactly (components/pipeline/application-detail-dialog.tsx is the reader).

import type { AgentFn, LlmRunner } from '../types'
import { CoachInput } from '../schemas'
import type { PipelineStage } from '@cello/shared'

interface ApplicationRow {
  id: string
  stage: string
  applied_at: string | null
  updated_at: string
  job_id: string | null
  notes: string | null
}

interface JobRow {
  id: string
  title: string | null
  company_id: string | null
}

// --- timing (packages/agents/src/coach/timing.ts) ---------------------------

type FollowUpStage = 'applied' | 'screen' | 'interview' | 'offer'

function isFollowUpStage(stage: PipelineStage): stage is FollowUpStage {
  return ['applied', 'screen', 'interview', 'offer'].includes(stage)
}

interface FollowUpTiming {
  minDays: number
  maxDays: number
  suggestion: string
}

/** Follow-up timing configuration by stage — best-practice windows for job
 *  application follow-ups. Verbatim from packages/agents/src/coach/timing.ts. */
const FOLLOW_UP_TIMINGS: Record<FollowUpStage, FollowUpTiming> = {
  applied: {
    minDays: 5,
    maxDays: 7,
    suggestion: 'Check on application status with a brief, professional inquiry',
  },
  screen: {
    minDays: 3,
    maxDays: 5,
    suggestion: 'Send thank you note and reiterate your interest in the role',
  },
  interview: {
    minDays: 1,
    maxDays: 2,
    suggestion: 'Send thank you note and ask about next steps in the process',
  },
  offer: {
    minDays: 2,
    maxDays: 3,
    suggestion: 'Follow up with questions about the offer or negotiation points',
  },
}

/** Returns null for stages that don't support a follow-up. */
function getFollowUpTiming(stage: PipelineStage): FollowUpTiming | null {
  if (!isFollowUpStage(stage)) return null
  return FOLLOW_UP_TIMINGS[stage]
}

function daysSince(date: Date | null): number {
  if (!date) return 0
  const diffTime = Math.abs(Date.now() - date.getTime())
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

function shouldSuggestFollowUp(stage: PipelineStage, lastActivityDate: Date | null): boolean {
  if (!lastActivityDate) return false
  const timing = getFollowUpTiming(stage)
  if (!timing) return false
  return daysSince(lastActivityDate) >= timing.minDays
}

/** Human-readable suggestion based on stage and elapsed time. */
function getTimingSuggestion(stage: PipelineStage, daysSinceActivity: number): string {
  const timing = getFollowUpTiming(stage)
  if (!timing) return 'No follow-up needed for this stage.'

  const urgency =
    daysSinceActivity < timing.minDays ? 'none' : daysSinceActivity <= timing.maxDays ? 'suggested' : 'urgent'

  switch (stage) {
    case 'applied':
      return urgency === 'none'
        ? `It's only been ${daysSinceActivity} days since you applied. Wait until day ${timing.minDays} to follow up.`
        : `It's been ${daysSinceActivity} days since you applied. Consider sending a brief follow up to check on your application status.`
    case 'screen':
      return urgency === 'none'
        ? `It's been ${daysSinceActivity} days since your screen. Wait a bit longer before following up.`
        : `It's been ${daysSinceActivity} days since your screen. Send a thank you note and reiterate your interest.`
    case 'interview':
      return urgency === 'none'
        ? `It's been ${daysSinceActivity} days since your interview. Consider sending a thank you note soon.`
        : `It's been ${daysSinceActivity} days since your interview. Send a thank you note and ask about next steps.`
    case 'offer':
      return urgency === 'none'
        ? `It's been ${daysSinceActivity} days since receiving the offer. Take time to review it carefully.`
        : `It's been ${daysSinceActivity} days since receiving the offer. Follow up with any questions about the offer or negotiation.`
    default:
      return timing.suggestion
  }
}

/** Uses appliedAt as the baseline activity date (proxy for last activity —
 *  a more complete implementation would track actual email/interview dates). */
function getLastActivityDate(application: { appliedAt: Date | null; updatedAt: Date }): Date | null {
  return application.appliedAt
}

// --- message generation (packages/agents/src/coach/{templates,message-
// generator}.ts) --------------------------------------------------------------

type MessageType = 'follow_up' | 'thank_you' | 'cold_outreach' | 'check_in'

interface MessageContext {
  userName: string
  companyName: string
  jobTitle: string
  stage?: PipelineStage
  daysSinceLastActivity?: number
  contactName?: string
  contactTitle?: string
  relationship?: string
  applicationNotes?: string
}

interface CoachCompletionOptions {
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

/** The one-method shape generateMessageByType needs — satisfied here by
 *  llmClientFrom() below, which adapts ctx.llm. */
interface LLMClient {
  complete(prompt: string, options?: CoachCompletionOptions): Promise<string>
}

const COACH_SYSTEM_PROMPT = `You are an expert career coach specializing in professional communication for job seekers.

## Your Communication Philosophy

1. **AUTHENTIC** - Messages should sound like a real person, not a template
2. **PURPOSEFUL** - Every sentence should serve a goal
3. **RESPECTFUL** - Value the recipient's time and attention
4. **CONFIDENT** - Not arrogant, not desperate - professionally confident

## Your Reasoning Process

Before writing any message, think through:
1. What is the GOAL of this message?
2. What does the RECIPIENT care about?
3. What ACTION do I want them to take?
4. What TONE is appropriate for this context?

## Quality Standards

- Under 150 words for emails, under 50 for LinkedIn
- Specific to the role and company (no generic templates)
- Clear call-to-action or next step
- Professional but warm tone

Respond with ONLY the message text, ready to send. No subject lines or commentary.`

function generateFollowUpPrompt(context: MessageContext): string {
  const contactPart = context.contactName ? `to ${context.contactName}` : 'to the hiring team'
  return `Write a professional follow-up email for a job application.

## CONTEXT

**Applicant:** ${context.userName}
**Company:** ${context.companyName}
**Position:** ${context.jobTitle}
**Current Stage:** ${context.stage || 'applied'}
**Days Since Last Activity:** ${context.daysSinceLastActivity || 'unknown'}
**Sending:** ${contactPart}
${context.applicationNotes ? `**Notes:** ${context.applicationNotes}` : ''}

---

## REASONING PROCESS

<think>
1. ASSESS THE SITUATION
   - How long has it been? (${context.daysSinceLastActivity} days)
   - Is this an appropriate time to follow up?
   - What stage are they at? What's the normal timeline?

2. DETERMINE THE GOAL
   - Primary: Get an update on status
   - Secondary: Reaffirm interest and value
   - Tertiary: Stay top of mind

3. CHOOSE THE RIGHT TONE
   - Too soon (< 5 days): Risk seeming impatient
   - Appropriate (5-14 days): Professional persistence
   - Overdue (> 14 days): May need a softer approach

4. CRAFT THE MESSAGE
   - Opening: Brief, warm, reference the application
   - Middle: Express continued interest, add value if possible
   - Closing: Polite ask for update, make it easy to respond
</think>

---

## REQUIREMENTS

- Address it ${contactPart}
- Reference the specific position (${context.jobTitle})
- Express genuine interest without being desperate
- Make a specific, easy-to-respond-to ask
- Keep under 100 words

Write the follow-up email now:`
}

function generateThankYouPrompt(context: MessageContext): string {
  const interviewerPart = context.contactName
    ? `to ${context.contactName}${context.contactTitle ? ` (${context.contactTitle})` : ''}`
    : 'to the interviewer(s)'
  return `Write a professional thank you email after a job interview.

## CONTEXT

**Applicant:** ${context.userName}
**Company:** ${context.companyName}
**Position:** ${context.jobTitle}
**Sending:** ${interviewerPart}
${context.applicationNotes ? `**Discussion Topics/Notes:** ${context.applicationNotes}` : ''}

---

## REASONING PROCESS

<think>
1. WHAT MAKES A GREAT THANK YOU?
   - Sent within 24 hours (timing matters)
   - References something SPECIFIC from the conversation
   - Adds value or reinforces a key point
   - Shows genuine enthusiasm without being over-the-top

2. COMMON MISTAKES TO AVOID
   - Generic "thanks for your time" with no specifics
   - Too long (they're busy)
   - Re-pitching yourself too aggressively
   - Forgetting to reaffirm interest

3. STRUCTURE
   - Opening: Sincere thanks, reference when you met
   - Middle: One specific thing from the conversation + why it excited you
   - Closing: Reiterate interest, look forward to next steps
</think>

---

## REQUIREMENTS

- Send ${interviewerPart}
- Reference something specific (if notes available: "${context.applicationNotes || 'use a general reference'}")
- Show genuine enthusiasm for ${context.companyName}
- Keep under 100 words
- End with forward momentum

Write the thank you email now:`
}

function generateColdOutreachPrompt(context: MessageContext): string {
  return `Write a professional cold outreach message to request a referral or informational chat.

## CONTEXT

**Your Name:** ${context.userName}
**Target Company:** ${context.companyName}
**Position of Interest:** ${context.jobTitle}
**Contact Name:** ${context.contactName || 'Unknown'}
**Contact Title:** ${context.contactTitle || 'Unknown'}
**Connection/Relationship:** ${context.relationship || 'No prior connection'}

---

## REASONING PROCESS

<think>
1. WHY COLD OUTREACH FAILS
   - Too long (didn't respect their time)
   - No clear ask (what do you want?)
   - All about you (what's in it for them?)
   - Generic message (clearly a template)

2. WHY COLD OUTREACH WORKS
   - Short and scannable
   - Clear, specific, easy-to-answer ask
   - Shows you did research (not mass-sending)
   - Makes it easy to say yes OR no

3. THE STRUCTURE THAT WORKS
   - Line 1: Who you are + how you found them (if applicable)
   - Line 2: Why you're reaching out (specific to them/company)
   - Line 3: Your specific ask (informational chat, advice, referral)
   - Line 4: Make it easy (15 min call, answer via email, etc.)

4. CONNECTION LEVERAGE
   ${context.relationship
     ? `- You have a connection: "${context.relationship}" - USE THIS
   - Reference it early to establish trust`
     : `- No prior connection - you need a compelling reason
   - Focus on genuine interest in their work/company`}
</think>

---

## REQUIREMENTS

- Maximum 75 words (LinkedIn-friendly)
- ${context.relationship ? `Reference the connection: "${context.relationship}"` : 'Explain why you chose to reach out to THEM'}
- Make ONE specific ask (chat, referral, or advice)
- Make it trivially easy to respond
- Be genuinely interested, not transactional

Write the outreach message now:`
}

function generateCheckInPrompt(context: MessageContext): string {
  return `Write a gentle, professional check-in message about a job application.

## CONTEXT

**Applicant:** ${context.userName}
**Company:** ${context.companyName}
**Position:** ${context.jobTitle}
**Current Stage:** ${context.stage || 'applied'}
**Days Since Last Activity:** ${context.daysSinceLastActivity || 'unknown'}
${context.contactName ? `**Contact:** ${context.contactName}` : ''}

---

## REASONING PROCESS

<think>
1. CHECK-IN VS FOLLOW-UP
   - Follow-up: More formal, asks for status
   - Check-in: Lighter touch, maintains connection
   - This is a CHECK-IN: softer, shorter, less demanding

2. WHEN CHECK-INS WORK BEST
   - Between formal follow-ups
   - When you have something small to add (article, update)
   - When maintaining relationship is more important than getting an answer

3. THE GENTLE APPROACH
   - Don't demand an update
   - Offer something of value if possible
   - Show you're still interested without being pushy
   - Give them an easy out

4. TONE CALIBRATION
   - ${(context.daysSinceLastActivity || 0) > 14
       ? 'Been a while - be understanding, they may be busy'
       : 'Recent activity - keep it light and brief'}
</think>

---

## REQUIREMENTS

- Maximum 50 words
- Friendly and non-demanding
- Briefly mention continued interest
- Optional: Offer to provide additional info
- No pressure, easy to ignore if needed

Write the check-in message now:`
}

const DEFAULT_TEMPLATES: Record<MessageType, (context: MessageContext) => string> = {
  follow_up: (ctx) => `Dear Hiring Manager,

I hope this message finds you well. I recently applied for the ${ctx.jobTitle} position at ${ctx.companyName} and wanted to follow up on my application.

I remain very interested in this opportunity and would welcome the chance to discuss how my experience aligns with your team's needs.

Thank you for your consideration.

Best regards,
${ctx.userName}`,

  thank_you: (ctx) => `Dear ${ctx.contactName || 'Hiring Team'},

Thank you for taking the time to speak with me about the ${ctx.jobTitle} position at ${ctx.companyName}. I enjoyed learning more about the role and the team.

Our conversation reinforced my enthusiasm for this opportunity. I am confident that my skills and experience would be a great fit for your team.

I look forward to hearing about next steps.

Best regards,
${ctx.userName}`,

  cold_outreach: (ctx) => `Hi ${ctx.contactName || 'there'},

I hope this message finds you well. I came across the ${ctx.jobTitle} position at ${ctx.companyName} and I am very interested in learning more.

${
    ctx.relationship
      ? `We connected at ${ctx.relationship}, and I was hoping you might be willing to share a bit about your experience at the company.`
      : `I noticed you work there as a ${ctx.contactTitle || 'team member'}, and I was hoping you might be willing to share a bit about your experience.`
  }

Would you be open to a brief chat or call?

Best regards,
${ctx.userName}`,

  check_in: (ctx) => `Hi,

I wanted to check in regarding my application for the ${ctx.jobTitle} position at ${ctx.companyName}.

I am still very interested in the role and happy to provide any additional information that would be helpful.

Thank you for your time.

Best,
${ctx.userName}`,
}

/** Generate any type of message via the given LLM client. */
async function generateMessageByType(client: LLMClient, messageType: MessageType, context: MessageContext): Promise<string> {
  const prompt = {
    follow_up: generateFollowUpPrompt,
    thank_you: generateThankYouPrompt,
    cold_outreach: generateColdOutreachPrompt,
    check_in: generateCheckInPrompt,
  }[messageType](context)

  const response = await client.complete(prompt, { maxTokens: 500, temperature: 0.7, systemPrompt: COACH_SYSTEM_PROMPT })
  return response.trim()
}

/** Deterministic template used when the LLM is unavailable or errors. */
function getFallbackMessage(messageType: MessageType, context: MessageContext): string {
  return DEFAULT_TEMPLATES[messageType](context)
}

/** Same stage -> message-type mapping as packages/agents/src/coach/
 *  index.ts#getSuggestedMessageType. */
function suggestedMessageType(stage: string, days: number): MessageType {
  switch (stage) {
    case 'interview':
      return days <= 2 ? 'thank_you' : 'follow_up'
    case 'screen':
      return days <= 3 ? 'thank_you' : 'check_in'
    case 'offer':
      return 'follow_up'
    case 'applied':
    default:
      return 'follow_up'
  }
}

/** Adapts ctx.llm to the LLMClient interface generateMessageByType expects,
 *  so the prompt construction above runs unchanged against the metered path. */
function llmClientFrom(llm: LlmRunner): LLMClient {
  return {
    async complete(prompt, options) {
      const res = await llm({
        system: options?.systemPrompt,
        prompt,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
      })
      return res.content
    },
  }
}

export const coach: AgentFn = async (ctx) => {
  const input = CoachInput.parse(ctx.input ?? {})

  const { data: appData, error: appErr } = await ctx.admin
    .from('applications')
    .select('id, stage, applied_at, updated_at, job_id, notes')
    .eq('id', input.applicationId)
    .eq('user_id', ctx.userId)
    .single()
  if (appErr || !appData) {
    throw new Error(`coach: application ${input.applicationId} not found: ${appErr?.message ?? 'no row'}`)
  }
  const application = appData as ApplicationRow

  let job: JobRow | null = null
  let companyName = 'the company'
  if (application.job_id) {
    const { data: jobData } = await ctx.admin
      .from('jobs')
      .select('id, title, company_id')
      .eq('id', application.job_id)
      .single()
    job = (jobData as JobRow | null) ?? null
    if (job?.company_id) {
      const { data: companyData } = await ctx.admin
        .from('companies')
        .select('name')
        .eq('id', job.company_id)
        .single()
      const name = (companyData as { name?: string | null } | null)?.name
      if (name) companyName = name
    }
  }

  const { data: profile } = await ctx.admin.from('profiles').select('full_name').eq('id', ctx.userId).single()
  const userName = (profile?.full_name as string | null) || 'Job Seeker'

  let contactRows: { name: string; title: string | null }[] = []
  if (job?.company_id) {
    const { data: contactsData } = await ctx.admin
      .from('contacts')
      .select('name, title')
      .eq('user_id', ctx.userId)
      .eq('company_id', job.company_id)
    contactRows = (contactsData as { name: string; title: string | null }[] | null) ?? []
  }
  // Computed once, used regardless of which branch below runs — a "too soon
  // to follow up" response still carries suggestedContacts when contacts
  // exist, same as packages/agents/src/coach/index.ts did.
  const suggestedContacts = contactRows.map((c) => c.name)

  const lastActivity = getLastActivityDate({
    appliedAt: application.applied_at ? new Date(application.applied_at) : null,
    updatedAt: new Date(application.updated_at),
  })
  const days = daysSince(lastActivity)
  const stage = application.stage as PipelineStage
  const timing = getFollowUpTiming(stage)
  const willFollowUp = shouldSuggestFollowUp(stage, lastActivity)

  if (!willFollowUp) {
    const suggestion = timing
      ? `It's too soon to follow up. Wait until day ${timing.minDays} since applying (currently day ${days}).`
      : 'No follow-up action needed at this stage.'
    return {
      output: {
        applicationId: application.id,
        suggestion,
        suggestedContacts: suggestedContacts.length > 0 ? suggestedContacts : undefined,
        draftMessage: undefined,
      },
      tokensUsed: 0,
    }
  }

  const suggestion = getTimingSuggestion(stage, days)
  const messageType = suggestedMessageType(application.stage, days)
  const messageContext: MessageContext = {
    userName,
    companyName,
    jobTitle: job?.title || 'the position',
    stage,
    daysSinceLastActivity: days,
    contactName: contactRows[0]?.name,
    contactTitle: contactRows[0]?.title || undefined,
    applicationNotes: application.notes || undefined,
  }

  let draftMessage: string
  try {
    draftMessage = await generateMessageByType(llmClientFrom(ctx.llm), messageType, messageContext)
  } catch {
    // No key, a provider failure, an aborted budget — the coach degrades to
    // a deterministic template rather than leaving the suggestion undrafted.
    draftMessage = getFallbackMessage(messageType, messageContext)
  }

  return {
    output: {
      applicationId: application.id,
      suggestion,
      suggestedContacts: suggestedContacts.length > 0 ? suggestedContacts : undefined,
      draftMessage,
    },
    // ctx.llm already metered the tokens when it was actually called; the
    // fallback-template path spends none.
    tokensUsed: 0,
  }
}
