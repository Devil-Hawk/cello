// How a reply to cold outreach is read. The old bridge ran the reply through the
// job-application classifier, whose answer for anything that is not application
// mail is "unknown", mapped to neutral, so a real "happy to chat" collapsed to
// nothing; it also read the quoted copy of the user's own email, and counted an
// out-of-office as a reply, which stamped replied_at and blocked the follow-up
// for good.
//
// Order of work: a bounce is read from the sender and subject, an auto-reply is
// not a reply at all, the quoted original is cut off, then the model reads what
// the person actually wrote (with a quote that must be in it) and the patterns
// are the fallback when there is no model or its answer cannot be used.

import type { LlmRunner } from '@/lib/harness/types'
import { composeSystemPrompt, loadModeDoc, promptRef } from '@/lib/harness/prompts'
import { frameJobText } from '@/lib/security/job-text'
import type { ReplyClassification } from './types'

export type ReplyKind = Exclude<ReplyClassification, 'bounce'>

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery subsystem/i
const BOUNCE_SUBJECT = /undeliverable|delivery (has )?fail|delivery status notification|returned to sender/i

/** A delivery failure notice, read from who sent it and what it says it is. */
export function isBounce(from: string, subject: string): boolean {
  return BOUNCE_SENDER.test(from) || BOUNCE_SUBJECT.test(subject)
}

/** An out-of-office or other automatic answer: not a person replying. */
export function isAutoReply(headers: { name: string; value: string }[], subject: string): boolean {
  const get = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value.trim().toLowerCase() ?? null
  const autoSubmitted = get('auto-submitted')
  if (autoSubmitted !== null && autoSubmitted !== 'no') return true
  if (get('x-autoreply') !== null || get('x-autorespond') !== null) return true
  if (get('precedence') === 'auto_reply') return true
  return /^\s*(automatic reply|auto.?reply|out of (the )?office)/i.test(subject)
}

/**
 * The reply's own words: everything above the first sign of the quoted
 * original ("On ... wrote:", "> " lines, an Original Message rule, an Outlook
 * From: block after a blank line, or a long underscore rule).
 */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const wrapped = `${line} ${lines[i + 1]?.trim() ?? ''}`
    if (
      /^on .{5,200}wrote:\s*$/i.test(line) ||
      (/^on /i.test(line) && /wrote:\s*$/i.test(wrapped) && !/wrote:\s*$/i.test(line)) ||
      line.startsWith('>') ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(line) ||
      /^_{5,}$/.test(line) ||
      (/^from:\s.+/i.test(line) && i > 0 && lines[i - 1].trim() === '')
    ) {
      return lines.slice(0, i).join('\n').trim()
    }
  }
  return body.trim()
}

const NEGATIVE =
  /\b(not hiring|no (open )?(roles?|positions?|openings?)|(position|role) (has been|is|was) filled|filled the (role|position)|not a (good )?fit|no,? thanks|not interested|please (remove|stop|do not contact)|unsubscribe me|we(?:'re| are) not (currently )?(looking|hiring|recruiting)|(can(?:'|no)?t|unable to) help|hiring freeze|not (currently )?(accepting|taking))\b/i

const POSITIVE =
  /\b(happy to|glad to|love to|would love to|more than happy to) (chat|talk|connect|meet|help|jump on|set up|schedule)|are you (free|available)|let'?s (chat|talk|connect|schedule|set up|find a time)|(send|share|attach) (me )?(over )?(your )?(resume|cv)|(i'?ll|i will|let me|i can) (forward|introduce|connect you|loop)|looping in|cc'?ing|schedule a (call|chat|time)|calendly\.com|how about (monday|tuesday|wednesday|thursday|friday|next week|tomorrow)|free (on|this|next|tomorrow)|works for me/i

/** The fallback reading: negative wins over positive, nothing matching is neutral. */
export function classifyReplyPatterns(subject: string, text: string): ReplyKind {
  const body = `${subject}\n${text}`
  if (NEGATIVE.test(body)) return 'negative'
  if (POSITIVE.test(body)) return 'positive'
  return 'neutral'
}

function normalize(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The model's reading of one reply (already stripped of its quoted original).
 * Its quote has to be in the reply; without one, the patterns decide. A failure
 * of the model call or an unreadable answer also falls to the patterns.
 */
export async function classifyReplyWith(run: LlmRunner, subject: string, text: string): Promise<ReplyKind> {
  try {
    const res = await run({
      system: composeSystemPrompt({ mode: loadModeDoc('reply_classify'), includeVoice: false }),
      promptRef: promptRef('reply_classify'),
      prompt: frameJobText(`Subject: ${subject}\n\n${text}`, { label: 'REPLY', maxChars: 2500 }),
      json: true,
      maxTokens: 200,
      temperature: 0,
    })
    const match = res.content.match(/\{[\s\S]*\}/)
    const parsed = match ? (JSON.parse(match[0]) as { classification?: unknown; evidence?: unknown }) : null
    const c = parsed?.classification
    const quote = typeof parsed?.evidence === 'string' ? normalize(parsed.evidence) : ''
    if ((c === 'positive' || c === 'negative') && quote.length >= 6 && normalize(`${subject}\n${text}`).includes(quote)) return c
    if (c === 'neutral') return 'neutral'
  } catch {
    // Fall through to the patterns.
  }
  return classifyReplyPatterns(subject, text)
}
