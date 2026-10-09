// Cold-outreach draft writer.
//
// Framework-free (no next/* imports) and takes an injected LlmRunner, so it runs
// in a request handler (app/api/outreach/*), in the harness, and in the evals.
//
// `outreach` is NOT a registered agent_type in the harness registry: the DAG
// executor never calls it. It is the shared drafting core used by the outreach
// routes and the review in lib/graph/verify/outreach.ts.
//
// What the writer sees is what the judges see: the resume and the job post are
// numbered (R1.., J1..), company research is D1.. with links, earlier contact is
// H1... A draft is signed with the sender's real name; there is no spoofing in
// this path, and no draft is written without one (the routes refuse first).
//
// A draft is either written by the model or it is the standard template, and the
// result says which and why. The template is a usable starting point, never
// presented as written work.

import type { LlmRunner } from '../types'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../prompts'
import { MissingKeyError } from '../providers'
import { BudgetCapError } from '../spend'
import { formatLines, jobLines, resumeLines, type NumberedLine } from '@/lib/resume/lines'
import { frameJobText } from '@/lib/security/job-text'

import type { TemplateReason } from '@/lib/outreach/types'
export type { TemplateReason }

export interface SourceLine {
  id: string
  text: string
  url?: string
}

export interface OutreachDraftInput {
  /** The sender's real name, used for the sign-off. */
  userName: string
  /** The sender's real email (identity shown to the recipient). */
  userEmail: string
  /** Null when the draft is about the company, not one posted role. */
  jobTitle: string | null
  companyName: string | null
  contactName?: string | null
  contactTitle?: string | null
  /** The user's own resume text: the only source for claims about the sender. */
  resumeText?: string | null
  /** The matcher's notes on what fits. Hints, not sources. */
  matchHighlights?: string[]
  jobDescription?: string | null
  /** Researched company facts (D1..), each with the page it came from. */
  facts?: SourceLine[]
  /** Real earlier contact with this person or company (H1..). */
  history?: SourceLine[]
  /** What has worked in this user's past outreach. */
  patterns?: string[]
  /** 'initial' cold email or the single 'follow_up'. */
  kind?: 'initial' | 'follow_up'
  /** For a follow-up: the email that got no answer. */
  previousEmail?: { subject: string; body: string; sentAt?: string | null } | null
  daysSinceSent?: number | null
  /** Set by the one regeneration in lib/graph/verify/outreach.ts: a numbered list of what to fix. */
  correctiveContext?: string | null
}

export interface OutreachDraftResult {
  subject: string
  body: string
  tokensUsed: number
  source?: 'model' | 'template'
  /** Why the text is the template. Set when source is 'template'. */
  templateReason?: TemplateReason
}

/** The numbered sources a draft is written from and judged against. */
export interface OutreachSources {
  resume: NumberedLine[]
  job: NumberedLine[]
  facts: SourceLine[]
  history: SourceLine[]
}

export function outreachSources(input: Pick<OutreachDraftInput, 'resumeText' | 'jobDescription' | 'facts' | 'history'>): OutreachSources {
  return {
    resume: resumeLines(input.resumeText),
    job: jobLines(input.jobDescription),
    facts: input.facts ?? [],
    history: input.history ?? [],
  }
}

function firstName(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first || 'there'
}

function followUpSubject(previous?: string | null): string | null {
  const s = (previous ?? '').trim()
  if (!s) return null
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

/**
 * The standard template. It makes no claim about the sender, names the role and
 * company when they are known, asks once, and is signed with the real name, so
 * it passes every check a written draft has to pass.
 */
export function fallbackOutreachDraft(input: OutreachDraftInput, reason: TemplateReason = 'missing_key'): OutreachDraftResult {
  const greeting = `Hi ${firstName(input.contactName)},`
  const company = input.companyName?.trim() || null
  const title = input.jobTitle?.trim() || null
  const interest =
    title && company
      ? `I am interested in the ${title} role at ${company}.`
      : company
        ? `I am interested in working at ${company}.`
        : title
          ? `I am interested in the ${title} role.`
          : 'I am interested in working with your team.'
  const ask =
    input.kind === 'follow_up'
      ? 'Would you be open to pointing me to the right person?'
      : 'Would you be open to a short chat, or could you point me to the right person?'
  const lead = input.kind === 'follow_up' ? interest.replace('I am interested in', 'I am still interested in') : interest
  const body = [greeting, '', `${lead} ${ask}`, '', 'Thanks,', input.userName].join('\n')
  const subject =
    (input.kind === 'follow_up' ? followUpSubject(input.previousEmail?.subject) : null) ??
    (title && company ? `${title} at ${company}` : company ? `Interested in ${company}` : 'Introduction')
  return { subject, body, tokensUsed: 0, source: 'template', templateReason: reason }
}

function sourceBlock(tag: string, lines: SourceLine[]): string {
  return `<${tag}>\n${lines.map((l) => `${l.id}: ${l.text}${l.url ? ` (${l.url})` : ''}`).join('\n')}\n</${tag}>`
}

function templateReasonFor(err: unknown): TemplateReason {
  if (err instanceof MissingKeyError) return 'missing_key'
  if (err instanceof BudgetCapError) return 'spend_cap'
  return 'provider_error'
}

/**
 * Draft one outreach email with the injected model, or return the standard
 * template with the reason when no model draft could be made. Never throws.
 *
 * The resume (stable across every draft a user asks for) sits in `system` with
 * `cachePrefix`, so it is a cache hit from the second draft on; the role,
 * contact and job post go in `prompt`.
 */
export async function generateOutreachDraft(llm: LlmRunner, input: OutreachDraftInput): Promise<OutreachDraftResult> {
  const kind = input.kind ?? 'initial'
  const src = outreachSources(input)

  const system = composeSystemPrompt({
    mode: loadModeDoc('outreach'),
    stableContext: src.resume.length ? `<resume>\n${formatLines(src.resume)}\n</resume>` : '<resume>\nNo resume on file.\n</resume>',
  })

  const role =
    input.jobTitle && input.companyName
      ? `${input.jobTitle} at ${input.companyName}`
      : input.companyName
        ? `No specific role. Write to the team at ${input.companyName} about working there.`
        : input.jobTitle ?? 'No specific role or company is known.'
  const prompt = [
    kind === 'follow_up' ? 'Kind: follow_up' : 'Kind: initial',
    `Sender: ${input.userName}`,
    `Role: ${role}`,
    input.contactName
      ? `Recipient: ${input.contactName}${input.contactTitle ? `, ${input.contactTitle}` : ''}`
      : 'Recipient: unknown. Greet with "Hi there,".',
    src.job.length
      ? `<job_post>\n${frameJobText(formatLines(src.job), { label: 'JOB POST', maxChars: 9000 })}\n</job_post>`
      : 'No job post on file.',
    src.facts.length ? `<company_facts>\n${frameJobText(src.facts.map((f) => `${f.id}: ${f.text}${f.url ? ` (${f.url})` : ''}`).join('\n'), { label: 'COMPANY FACTS', maxChars: 4000 })}\n</company_facts>` : 'No company research on file.',
    src.history.length ? sourceBlock('history', src.history) : 'No earlier contact on record. This is a first contact.',
    kind === 'follow_up' && input.previousEmail
      ? `<previous_email>\nSubject: ${input.previousEmail.subject}\n${input.previousEmail.body}\n</previous_email>\nSent ${input.daysSinceSent != null ? `${input.daysSinceSent} days ago` : 'earlier'}.`
      : '',
    input.matchHighlights?.length
      ? `Fit notes (hints only; every claim must still trace to an R line): ${input.matchHighlights.join('; ')}`
      : '',
    input.patterns?.length ? `What has worked in this person's past outreach (apply if it fits, never state as fact about this recipient):\n${input.patterns.map((p) => `- ${p}`).join('\n')}` : '',
    input.correctiveContext ? `Fix these before you answer:\n${input.correctiveContext}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const res = await llm({
      system,
      promptRef: promptRef('outreach'),
      prompt,
      json: true,
      maxTokens: 1200,
      temperature: 0.6,
      reasoning: { effort: 'medium' },
      cachePrefix: true,
    })
    let parsed: { subject?: unknown; body?: unknown } = {}
    try {
      parsed = JSON.parse(res.content)
    } catch {
      const match = res.content.match(/\{[\s\S]*\}/)
      try {
        parsed = match ? JSON.parse(match[0]) : {}
      } catch {
        parsed = {}
      }
    }
    const subject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : null
    const body = typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body.trim() : null
    if (!subject || !body) return { ...fallbackOutreachDraft(input, 'unusable_output'), tokensUsed: res.tokensUsed }
    return {
      subject: (kind === 'follow_up' ? followUpSubject(input.previousEmail?.subject) : null) ?? subject,
      body,
      tokensUsed: res.tokensUsed,
      source: 'model',
    }
  } catch (err) {
    return fallbackOutreachDraft(input, templateReasonFor(err))
  }
}
