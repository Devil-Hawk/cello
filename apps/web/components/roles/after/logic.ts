// The record after acting (blueprint 4.6): the code behind the Application and Documents groups. What the one
// button is, which stage an email suggests, how the person's note sits beside the Gmail sync's JSON in
// applications.notes, and which lines of a resume version changed. Pure, so the tests read it directly.

import { diffLines, diffStats, type DiffLine } from '@/lib/resume/diff'

export interface AppFacts {
  id: string
  stage: string
  state: string | null
  needs_reason: string | null
  closed_reason: string | null
  jobUrl: string | null
  company: string
}

export type Button =
  | { kind: 'link'; label: string; href: string; external?: boolean }
  | { kind: 'post'; label: string; action: string; body?: Record<string, unknown> }

/**
 * The one button of an application's status (blueprint 7). A second choice, when the state asks for one, comes after it.
 * Nothing here sends anything: marking sent is the person's own word, and Open leaves for the employer's page.
 */
export function buttonsFor(a: AppFacts): Button[] {
  if (a.closed_reason) return []
  const open: Button[] = a.jobUrl ? [{ kind: 'link', label: `Open on ${a.company}'s site`, href: a.jobUrl, external: true }] : []
  switch (a.state) {
    case 'ready':
      return [...open, { kind: 'post', label: 'Mark as sent', action: 'mark-sent' }]
    case 'needs_you':
      switch (a.needs_reason) {
        case 'approve_resume':
          return [{ kind: 'link', label: 'Review resume', href: '#after-docs' }]
        case 'answer':
          return [{ kind: 'link', label: 'Answer', href: '/profile' }]
        case 'duplicate':
          return [{ kind: 'post', label: 'Yes, I applied', action: 'mark-sent' }, { kind: 'post', label: 'No, apply anyway', action: 'apply-anyway' }]
        case 'your_turn':
          return open
        case 'check_sent':
          return [{ kind: 'post', label: 'Yes, sent', action: 'mark-sent' }, { kind: 'post', label: 'Not yet', action: 'not-applied' }]
        case 'reconnect':
          return [{ kind: 'link', label: 'Reconnect Gmail', href: '/settings?tab=connections' }]
        case 'budget':
          return [{ kind: 'link', label: 'Raise the cap', href: '/settings#spend' }]
        default:
          return []
      }
    case 'paused':
      return [{ kind: 'post', label: 'Resume', action: 'resume' }]
    case 'skipped':
      return [{ kind: 'post', label: 'Undo', action: 'run-again' }]
    default:
      return []
  }
}

const STAGE_ORDER = ['discovered', 'applied', 'screen', 'interview', 'offer', 'accepted']
const STAGE_LABEL: Record<string, string> = { screen: 'Screen', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' }
const STAGE_OF_MAIL: Record<string, string> = { interview: 'interview', offer: 'offer', rejection: 'rejected' }
const MAIL_WORDS: Record<string, string> = { interview: 'an invitation to talk', offer: 'an offer', rejection: 'a no' }

export interface Suggestion {
  stage: string
  /** The newest mail it rests on, so a dismissal is remembered for that mail only. */
  messageId: string
  sentence: string
}

/**
 * A stage the newest mail points to, offered for the person's Confirm. Code reads the kind the mail was sorted as; the
 * stage stays the person's: nothing moves until they confirm. None when the stage is already there or further along.
 */
export function stageSuggestion(stage: string, mail: { id: string; kind: string; sent_at: string; from: string | null } | null): Suggestion | null {
  if (!mail) return null
  const next = STAGE_OF_MAIL[mail.kind]
  if (!next || next === stage) return null
  if (stage === 'rejected' || stage === 'withdrawn' || stage === 'accepted') return null
  if (next !== 'rejected' && STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(next)) return null
  return { stage: next, messageId: mail.id, sentence: `${mail.from ?? 'The employer'} sent ${MAIL_WORDS[mail.kind]}. Move this to ${STAGE_LABEL[next]}?` }
}

/**
 * applications.notes is the Gmail sync's JSON (the thread link and subject) on a row found in mail, and plain text on
 * one the person made. The person's note lives beside the sync's keys and never replaces them.
 */
export function readNote(notes: string | null): string {
  if (!notes) return ''
  try {
    const p = JSON.parse(notes)
    if (p && typeof p === 'object' && !Array.isArray(p)) return typeof p.note === 'string' ? p.note : ''
  } catch {
    // plain text
  }
  return notes
}

export function writeNote(notes: string | null, text: string): string | null {
  const t = text.trim()
  if (notes) {
    try {
      const p = JSON.parse(notes)
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const { note: _old, ...rest } = p as Record<string, unknown>
        const next = t ? { ...rest, note: t } : rest
        return Object.keys(next).length ? JSON.stringify(next) : null
      }
    } catch {
      // plain text: replaced as a whole
    }
  }
  return t || null
}

/** A timestamp as the value of a datetime-local input, in the browser's own zone. */
export function localInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface Changed {
  lines: DiffLine[]
  added: number
  removed: number
}

/** What changed from the base resume to a version: only the lines that differ, with their counts. */
export function changedLines(base: string, version: string): Changed {
  const all = diffLines(base, version)
  const { added, removed } = diffStats(all)
  return { lines: all.filter((l) => l.type !== 'same' && l.text.trim() !== ''), added, removed }
}
