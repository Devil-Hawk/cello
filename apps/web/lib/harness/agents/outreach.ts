// Cold-outreach draft "brain".
//
// OWNER: contacts + cold-outreach workstream (P5). This module is intentionally
// framework-free (no next/* imports) and takes an injected LlmRunner so it runs
// in BOTH a request handler (app/api/outreach/*) and the cron/harness context.
//
// `outreach` is NOT a registered agent_type in the harness registry — the DAG
// executor never calls it. It is the shared, testable drafting core used by the
// outreach API routes (and available for future harness wiring).
//
// GUARDRAILS baked into the prompt: the email must be SHORT, genuinely
// personalized (one concrete, TRUE reason the user fits — pulled from resume +
// match highlights), reference the specific role, and NEVER fabricate
// experience or credentials. It is signed with the user's real identity; there
// is no spoofing anywhere in this path.

import type { LlmRunner } from '../types'
import { composeSystemPrompt, loadModeDoc } from '../prompts'

export interface OutreachDraftInput {
  /** The sender's real name (used in the sign-off — never spoofed). */
  userName: string
  /** The sender's real email (identity shown to the recipient). */
  userEmail: string
  jobTitle: string
  companyName: string
  contactName?: string | null
  contactTitle?: string | null
  /** The user's own resume text — the ONLY source of truth for fit claims. */
  resumeText?: string | null
  /** Matcher highlights ("skills matched") to anchor the concrete reason. */
  matchHighlights?: string[]
  jobDescription?: string | null
  /** Pre-assembled relationship context — buildOutreachContext
   *  (lib/context/assemble.ts): chronological history + provenance-constrained
   *  phrasing rules + reply-pattern insights. Cello's own records and its own
   *  instruction lines, not employer text, so nothing here needs frameJobText. */
  relationshipContext?: string | null
  /** 'initial' cold email or a single polite 'follow_up'. */
  kind?: 'initial' | 'follow_up'
  /** Set by lib/graph/verify/outreach.ts's ONE bounded regeneration when the
   *  groundedness/specificity judge failed the first draft. */
  correctiveContext?: string | null
}

export interface OutreachDraftResult {
  subject: string
  body: string
  tokensUsed: number
}

const MAX_RESUME_CHARS = 4000
const MAX_JD_CHARS = 1500

function firstName(name?: string | null): string {
  if (!name) return 'there'
  const trimmed = name.trim()
  if (!trimmed) return 'there'
  return trimmed.split(/\s+/)[0]
}

function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text.trim()
  return words.slice(0, maxWords).join(' ')
}

/** Deterministic, never-fabricating fallback used when no LLM key / LLM fails. */
export function fallbackOutreachDraft(input: OutreachDraftInput): OutreachDraftResult {
  const greeting = `Hi ${firstName(input.contactName)},`
  const reason =
    input.matchHighlights && input.matchHighlights.length > 0
      ? `In particular, my background in ${input.matchHighlights.slice(0, 2).join(' and ')} lines up closely with what the role calls for.`
      : `I believe my background is a strong match for what the role calls for.`
  const follow =
    input.kind === 'follow_up'
      ? `\n\nI wanted to gently follow up on my note below in case it slipped through — no worries at all if the timing isn't right.`
      : ''
  const body = [
    greeting,
    '',
    `I came across the ${input.jobTitle} role at ${input.companyName} and wanted to reach out directly. ${reason}${follow}`,
    '',
    `Would you be open to a brief chat, or could you point me to the right person? Happy to share more on how I can contribute.`,
    '',
    `Thanks for your time,`,
    input.userName,
    input.userEmail,
  ].join('\n')
  const subject =
    input.kind === 'follow_up'
      ? `Following up: ${input.jobTitle} at ${input.companyName}`
      : `${input.jobTitle} at ${input.companyName} — quick note`
  return { subject, body, tokensUsed: 0 }
}

/**
 * Draft a short, genuinely personalized cold-outreach email via the injected
 * LLM. Falls back to a safe template on any error. NEVER fabricates: the prompt
 * constrains the model to the user's real resume + match highlights.
 *
 * The resume (stable across every draft this user asks for in a session) lives
 * in `system` with `cachePrefix: true`; only the per-role/contact facts go in
 * `prompt`. That's what makes the resume block a cache hit on the 2nd, 3rd, ...
 * draft instead of a full-price re-send every time.
 */
export async function generateOutreachDraft(
  llm: LlmRunner,
  input: OutreachDraftInput
): Promise<OutreachDraftResult> {
  const kind = input.kind ?? 'initial'
  const hasResume = !!(input.resumeText && input.resumeText.trim())

  // _shared.md + _voice.md + prompts/outreach.md (the house-style mode
  // document — see docs/PROMPT-GENERATOR.md) already state both the
  // resume-present/resume-absent and initial/follow-up decision rules; only
  // the resume block itself (when present) is call-specific stable context.
  const system = composeSystemPrompt({
    mode: loadModeDoc('outreach'),
    stableContext: hasResume
      ? `CANDIDATE RESUME (the ONLY source of truth for fit claims):\n${(input.resumeText ?? '').slice(0, MAX_RESUME_CHARS)}`
      : undefined,
  })

  const promptParts = [
    kind === 'follow_up'
      ? 'Email kind: FOLLOW-UP to an unanswered initial email. Apply the follow-up decision rule.'
      : 'Email kind: INITIAL cold outreach. Apply the initial decision rule.',
    `Sender: ${input.userName} <${input.userEmail}>`,
    `Target role: ${input.jobTitle}`,
    `Target company: ${input.companyName}`,
    input.contactName
      ? `Recipient: ${input.contactName}${input.contactTitle ? `, ${input.contactTitle}` : ''}`
      : 'Recipient name unknown — use a neutral greeting ("Hi there,").',
    input.matchHighlights && input.matchHighlights.length > 0
      ? `Verified match highlights (true, from the matcher — pick the single strongest): ${input.matchHighlights.join('; ')}`
      : hasResume
        ? 'No match highlights supplied — find the one strongest true fit yourself from the resume.'
        : 'No match highlights and no resume supplied — keep the reason general (interest in the role/company), not a fabricated skill claim.',
    input.jobDescription
      ? `Role description (context only, may inform the one reason you pick):\n${input.jobDescription.slice(0, MAX_JD_CHARS)}`
      : 'No role description supplied — do not invent role specifics beyond the title.',
    input.relationshipContext ? input.relationshipContext : '',
    input.correctiveContext
      ? `CORRECTIVE INSTRUCTION (a prior draft was rejected — fix this before returning): ${input.correctiveContext}`
      : '',
  ].filter(Boolean)

  try {
    const res = await llm({
      system,
      prompt: promptParts.join('\n\n'),
      json: true,
      maxTokens: 1200,
      temperature: 0.6,
      reasoning: { effort: 'medium' },
      cachePrefix: true,
    })
    let parsed: { subject?: unknown; body?: unknown }
    try {
      parsed = JSON.parse(res.content)
    } catch {
      const match = res.content.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : {}
    }
    const subject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : null
    const body = typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body.trim() : null
    if (!subject || !body) {
      const fb = fallbackOutreachDraft(input)
      return { ...fb, tokensUsed: res.tokensUsed }
    }
    return {
      subject: clampWords(subject, 18),
      body,
      tokensUsed: res.tokensUsed,
    }
  } catch {
    return fallbackOutreachDraft(input)
  }
}
