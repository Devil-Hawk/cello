// Deterministic checks for a written draft: what code can verify without a
// model. Length, dashes, banned phrases, one ask, greeting, sign-off, invented
// history, and the company being named. The outreach card runs the same
// function on every keystroke, so an edit that breaks a rule shows up at once.
//
// Client-safe: no node imports.

import { findBannedPhrases } from './banned'

export type DraftKind = 'outreach' | 'follow_up' | 'cover_letter'
export type LetterTier = 'full' | 'focused' | 'brief'

export interface DraftCheckInput {
  kind: DraftKind
  subject?: string | null
  body: string
  senderName?: string | null
  contactName?: string | null
  companyName?: string | null
  jobTitle?: string | null
  /** True when the sender has really been in touch with this contact or company. */
  hasHistory?: boolean
  /** The email being followed up; a follow-up must be shorter than it. */
  previousBody?: string | null
  /** Cover letters only: how much resume evidence the letter has. */
  tier?: LetterTier | null
}

export interface DraftCheck {
  id: CheckId
  ok: boolean
  /** One plain sentence the card shows. */
  message: string
}

export type CheckId =
  | 'word_count'
  | 'no_em_dash'
  | 'banned_phrases'
  | 'one_ask'
  | 'signed_by_sender'
  | 'greeting'
  | 'no_invented_history'
  | 'names_company'

export interface DraftCheckResult {
  ok: boolean
  checks: DraftCheck[]
}

export const OUTREACH_MAX_WORDS = 120
export const FOLLOW_UP_MAX_WORDS = 80
/** Words allowed in a cover letter body per evidence tier. */
export const TIER_WORDS: Record<LetterTier, { min: number; max: number }> = {
  full: { min: 250, max: 350 },
  focused: { min: 150, max: 250 },
  brief: { min: 90, max: 160 },
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

const ASK_PATTERN =
  /\b(would you be open|would you have|could you|can you|are you open|who (is|would be) the right person|let me know if|happy to (chat|send|share)|open to a)\b/i

const HISTORY_PATTERN = /as we discussed|great (meeting|chatting|speaking)|following up on (our|your)|per our conversation|it was (great|nice) to/i

/**
 * Sentences, split after . ! or ?. No lookbehind: this file runs in the browser,
 * and `(?<=...)` is a parse-time SyntaxError on Safari before 16.4, which would
 * take the whole card down with it.
 */
function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Sentences that ask for something, each counted once. */
export function countAsks(body: string): number {
  return sentences(body).filter((s) => s.endsWith('?') || ASK_PATTERN.test(s)).length
}

function lastLine(body: string): string {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function firstLine(body: string): string {
  return body.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}

export function checkDraft(input: DraftCheckInput): DraftCheckResult {
  const { kind, body } = input
  const subject = input.subject ?? ''
  const checks: DraftCheck[] = []
  const emailLike = kind === 'outreach' || kind === 'follow_up'

  // Length.
  const words = countWords(body)
  if (kind === 'outreach' || kind === 'follow_up') {
    const limit = kind === 'outreach' ? OUTREACH_MAX_WORDS : FOLLOW_UP_MAX_WORDS
    const previous = input.previousBody ? countWords(input.previousBody) : null
    const underLimit = words <= limit
    const shorter = kind === 'follow_up' && previous !== null ? words < previous : true
    checks.push({
      id: 'word_count',
      ok: underLimit && shorter,
      message: !underLimit
        ? `${words} words. Keep it under ${limit}.`
        : !shorter
          ? `${words} words, as long as the first email (${previous}). A follow-up should be shorter.`
          : `${words} words, limit ${limit}`,
    })
  } else if (input.tier) {
    const { min, max } = TIER_WORDS[input.tier]
    const ok = words >= min && words <= max
    checks.push({
      id: 'word_count',
      ok,
      message: ok
        ? `${words} words, right for a ${input.tier} letter (${min} to ${max})`
        : `${words} words. A ${input.tier} letter runs ${min} to ${max}.`,
    })
  }

  // Dashes.
  const dash = /[\u2013\u2014]/.test(`${subject}\n${body}`)
  checks.push({
    id: 'no_em_dash',
    ok: !dash,
    message: dash ? 'Has a long dash. Use a comma, a colon or a new sentence.' : 'No long dashes',
  })

  // Banned phrases.
  const banned = findBannedPhrases(`${subject}\n${body}`)
  checks.push({
    id: 'banned_phrases',
    ok: banned.length === 0,
    message: banned.length ? `Uses ${banned.map((b) => `"${b}"`).join(', ')}. Say the plain thing instead.` : 'No filler phrases',
  })

  if (emailLike) {
    const asks = countAsks(body)
    checks.push({
      id: 'one_ask',
      ok: asks === 1,
      message:
        asks === 1
          ? 'One ask'
          : asks === 0
            ? 'No ask. End with one clear question.'
            : `${asks} asks. Keep one so the reply is easy.`,
    })

    if (input.senderName?.trim()) {
      const signed = lastLine(body)
      const ok = signed.toLowerCase() === input.senderName.trim().toLowerCase()
      checks.push({
        id: 'signed_by_sender',
        ok,
        message: ok ? `Signed ${input.senderName.trim()}` : `Signed "${signed}", not your name "${input.senderName.trim()}".`,
      })
    }

    const greet = firstLine(body).match(/^(Hi|Hello) (\p{Lu}[\p{L}'’.-]*|there),$/u)
    let greetingOk = !!greet
    let greetingMessage = 'Greets by first name'
    if (!greet) {
      greetingMessage = 'Start with "Hi <first name>," or "Hi there,".'
    } else if (greet[2] !== 'there' && input.contactName?.trim() && greet[2] !== firstName(input.contactName)) {
      greetingOk = false
      greetingMessage = `Greets "${greet[2]}", but the contact is ${firstName(input.contactName)}.`
    } else if (greet[2] !== 'there' && !input.contactName?.trim()) {
      greetingOk = false
      greetingMessage = 'Greets a name nobody gave. Use "Hi there,".'
    }
    checks.push({ id: 'greeting', ok: greetingOk, message: greetingMessage })

    if (input.hasHistory === false || (input.hasHistory === undefined && kind === 'outreach')) {
      const invented = HISTORY_PATTERN.test(body)
      checks.push({
        id: 'no_invented_history',
        ok: !invented,
        message: invented ? 'Refers to a past conversation that is not on record.' : 'No made-up history',
      })
    }
  }

  const company = input.companyName?.trim()
  if (company) {
    const named = `${subject}\n${body}`.toLowerCase().includes(company.toLowerCase())
    checks.push({
      id: 'names_company',
      ok: named,
      message: named ? `Names ${company}` : `Never names ${company}.`,
    })
  }

  return { ok: checks.every((c) => c.ok), checks }
}
