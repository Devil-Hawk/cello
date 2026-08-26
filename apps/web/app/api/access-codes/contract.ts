// The owner-facing shape of the access-code surface, and the pure functions
// that build it.
//
// WHY THIS SITS BESIDE THE ROUTES RATHER THAN IN lib/access/
//   lib/access/codes.ts is the credential itself — generation, hashing, expiry
//   — and is shared with the redemption path. Everything here is presentation:
//   what the owner's card renders. Keeping it next to the routes that emit it
//   lets the client components `import type` the exact wire shape, so a field
//   renamed in a route is a typecheck failure rather than an `undefined` in the
//   UI.
//
//   NOTE FOR CLIENT COMPONENTS: this module transitively imports node:crypto
//   (via lib/access/codes.ts). Import from it with `import type` ONLY — a value
//   import would drag crypto into the browser bundle and break the build.
//
// WHY THE HUMANISING HAPPENS SERVER-SIDE
//   The trail exists to answer "what did they do with my code", asked by a
//   person. Turning 'jobs.score_batch' into "Scored 40 jobs" IS the answer, so
//   the vocabulary lives in one tested place instead of being re-derived by
//   every view that shows a trail.

import { accessCodeUsability, describeTimeRemaining } from '@/lib/access/codes'

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * The columns the owner's routes read from access_codes.
 *
 * `code_hash` is deliberately absent and must stay that way. It is a plain
 * SHA-256 of a 12-character code over a 30-symbol alphabet; handing it to a
 * browser turns a bearer credential into an offline brute-force target for
 * anything that can read the response. Nothing in the owner's UI needs it —
 * `code_prefix` is what tells two codes apart in a list.
 */
export const ACCESS_CODE_COLUMNS =
  'id, label, code_prefix, created_at, expires_at, revoked_at, first_redeemed_at, last_used_at, redemption_count'

/** One access_codes row, as selected by ACCESS_CODE_COLUMNS. */
export interface AccessCodeRow {
  id: string
  label: string | null
  code_prefix: string | null
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  first_redeemed_at: string | null
  last_used_at: string | null
  redemption_count: number | null
}

/**
 * 'invalid' should be unreachable — expires_at is NOT NULL in the schema — but
 * accessCodeUsability fails closed on an unreadable timestamp and this type
 * carries that refusal through to the UI rather than quietly calling it 'live'.
 */
export type AccessCodeStatus = 'live' | 'expired' | 'revoked' | 'invalid'

export interface AccessCodeSummary {
  id: string
  label: string | null
  /** First few characters of the code — enough to tell codes apart, not to use one. */
  prefix: string
  status: AccessCodeStatus
  statusLabel: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  /** "2d 6h left" — null unless the code is still live. */
  timeRemaining: string | null
  redemptionCount: number
  firstRedeemedAt: string | null
  lastUsedAt: string | null
}

const STATUS_LABELS: Record<AccessCodeStatus, string> = {
  live: 'Live',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Not usable',
}

export function summarizeAccessCode(row: AccessCodeRow, now: Date = new Date()): AccessCodeSummary {
  const usability = accessCodeUsability(
    { expires_at: row.expires_at, revoked_at: row.revoked_at },
    now
  )

  const status: AccessCodeStatus = usability.usable
    ? 'live'
    : usability.reason === 'revoked'
      ? 'revoked'
      : usability.reason === 'expired'
        ? 'expired'
        : 'invalid'

  return {
    id: row.id,
    label: row.label && row.label.trim() ? row.label.trim() : null,
    prefix: (row.code_prefix ?? '').toUpperCase(),
    status,
    statusLabel: STATUS_LABELS[status],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    // Only meaningful while the code still works. A revoked code that has not
    // yet reached its expiry would otherwise read "1d 4h left", which is a lie.
    timeRemaining: status === 'live' && row.expires_at ? describeTimeRemaining(row.expires_at, now) : null,
    redemptionCount: typeof row.redemption_count === 'number' ? row.redemption_count : 0,
    firstRedeemedAt: row.first_redeemed_at,
    lastUsedAt: row.last_used_at,
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ACCESS_CODE_EVENT_COLUMNS = 'id, occurred_at, kind, action, target, detail, client_hint'

/** One access_code_events row, as selected by ACCESS_CODE_EVENT_COLUMNS. */
export interface AccessCodeEventRow {
  id: string
  occurred_at: string
  kind: string | null
  action: string | null
  target: string | null
  detail: unknown
  client_hint: string | null
}

export type AccessCodeEventKind = 'redeemed' | 'page_view' | 'action' | 'denied' | 'other'

export interface AccessCodeTimelineEntry {
  id: string
  occurredAt: string
  kind: AccessCodeEventKind
  /** One sentence a person can read: "Scored 40 jobs", "Opened Pipeline". */
  title: string
  /** Optional supporting line — the thing acted on, plus safe detail fields. */
  note: string | null
  /** Coarse client attribution, so two people sharing a code are visible. */
  clientHint: string | null
}

/**
 * Pages the demo user can open, keyed by the first path segment.
 *
 * Mirrors the routes under app/(app)/. An unknown slug is title-cased rather
 * than dropped: a page added later should read as "Interview prep", not vanish
 * from the trail because this map was not updated.
 */
const PAGE_NAMES: Record<string, string> = {
  dashboard: 'Dashboard',
  jobs: 'Jobs',
  pipeline: 'Pipeline',
  resume: 'Resume',
  contacts: 'Contacts',
  companies: 'Companies',
  insights: 'Insights',
  copilot: 'Copilot',
  prep: 'Interview prep',
  queue: 'Needs you',
  agent: 'Agent',
  settings: 'Settings',
  notifications: 'Notifications',
  onboarding: 'Onboarding',
}

/**
 * The app's own action vocabulary, in the past tense a person would use.
 *
 * Deliberately not exhaustive and never authoritative: the redemption path
 * decides what it journals, and an action missing from here still renders
 * legibly through fallbackPhrase(). Adding a line here upgrades a row from
 * "Score batch · Jobs" to "Scored 40 jobs"; forgetting one loses nothing.
 */
const ACTION_PHRASES: Record<string, string> = {
  'jobs.refresh': 'Refreshed the job list',
  'jobs.search': 'Searched for jobs',
  'jobs.score': 'Scored a job',
  'jobs.save': 'Saved a job',
  'resume.tailor': 'Tailored a resume',
  'resume.upload': 'Uploaded a resume',
  'resume.optimize': 'Optimised a resume',
  'resume.export': 'Exported a resume',
  'outreach.draft': 'Drafted an outreach message',
  'outreach.send': 'Sent an outreach message',
  'copilot.run': 'Ran the copilot',
  'agent.run': 'Ran an agent',
  'application.create': 'Tracked a new application',
  'application.stage': 'Moved an application along the pipeline',
  'contacts.source': 'Looked up contacts',
  'company.dossier': 'Built a company dossier',
  'interview.prep': 'Generated interview prep',
  'settings.update': 'Changed a setting',
  // lib/access/audit.ts writes 'unknown' rather than dropping an event whose
  // action sanitised down to nothing. "Unknown" alone reads like a UI bug.
  unknown: 'An unnamed action',
}

/** Actions whose whole point is the number attached to them. */
const COUNTED_ACTION_PHRASES: Record<string, (n: number) => string> = {
  'jobs.score_batch': (n) => `Scored ${n} ${plural(n, 'job')}`,
  'jobs.import': (n) => `Imported ${n} ${plural(n, 'job')}`,
  'jobs.refresh': (n) => `Refreshed the job list — ${n} new ${plural(n, 'job')}`,
  'contacts.source': (n) => `Found ${n} ${plural(n, 'contact')}`,
  'outreach.draft': (n) => `Drafted ${n} outreach ${plural(n, 'message')}`,
}

/**
 * Refusals. A denial is the one row an owner scans for, so it says what was
 * refused and why in the same breath rather than "Blocked: expired".
 */
const DENIAL_PHRASES: Record<string, string> = {
  'code.expired': 'Turned away — the code had expired',
  'code.revoked': 'Turned away — the code had been revoked',
  'code.unknown': 'Turned away — the code was not recognised',
  'demo.spend_cap': 'Stopped by the demo spend cap',
  'demo.blocked': 'Blocked — not allowed in a demo workspace',
}

/**
 * The redemption path journals one action, 'code.denied', and puts the WHY in
 * `detail.reason` — the refusal codes accessCodeUsability returns. Reading it
 * here is what turns an unhelpful "Blocked — denied" into the sentence the
 * owner actually wants.
 */
const DENIAL_REASON_PHRASES: Record<string, string> = {
  expired: 'Turned away — the code had expired',
  revoked: 'Turned away — the code had been revoked',
  'unreadable-expiry': 'Turned away — the code was not valid',
}

/** Detail keys never worth a line of their own on the timeline. */
const NOTE_SKIP_KEYS = new Set(['count', 'code_id', 'codeId', 'user_id', 'userId'])
const NOTE_MAX_FIELDS = 3
const NOTE_MAX_VALUE_CHARS = 60
const NOTE_MAX_TARGET_CHARS = 80

export function describeAccessCodeEvent(row: AccessCodeEventRow): AccessCodeTimelineEntry {
  const kind = normalizeKind(row.kind)
  const action = (row.action ?? '').trim().toLowerCase()
  const detail = plainObject(row.detail)
  const count =
    typeof detail.count === 'number' && Number.isFinite(detail.count) ? detail.count : null

  // Fields already spoken by the title must not be repeated in the note.
  const spoken = new Set<string>(NOTE_SKIP_KEYS)

  let title: string
  let area: string | null = null

  if (kind === 'redeemed') {
    // The redemption path journals `first_redemption`, and "the first time" is
    // the single most useful thing an owner can be told about a sign-in: it is
    // the moment the workspace was created and the demo actually began.
    spoken.add('first_redemption')
    spoken.add('firstRedemption')
    title =
      detail.first_redemption === true || detail.firstRedemption === true
        ? 'Signed in with this code for the first time'
        : 'Signed in with this code'
  } else if (kind === 'page_view') {
    title = `Opened ${pageName(row.target, action)}`
  } else if (kind === 'denied') {
    const reason = typeof detail.reason === 'string' ? detail.reason.trim().toLowerCase() : ''
    const byReason = DENIAL_REASON_PHRASES[reason]
    if (byReason) spoken.add('reason')
    title =
      byReason ??
      DENIAL_PHRASES[action] ??
      `Blocked — ${lowerFirst(phraseFor(action, count, spoken).title)}`
  } else {
    const phrase = phraseFor(action, count, spoken)
    title = phrase.title
    area = phrase.area
  }

  const noteParts: string[] = []
  // page_view already names the page in its title, and a redemption always
  // lands on the same route — in both cases the raw path is noise, not context.
  if (kind !== 'page_view' && kind !== 'redeemed' && row.target) {
    noteParts.push(truncate(row.target.trim(), NOTE_MAX_TARGET_CHARS))
  }
  if (area) noteParts.push(area)
  const detailNote = describeDetail(detail, spoken)
  if (detailNote) noteParts.push(detailNote)

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    kind,
    title,
    note: noteParts.length ? noteParts.join(' · ') : null,
    clientHint: row.client_hint ? truncate(row.client_hint.trim(), NOTE_MAX_VALUE_CHARS) : null,
  }
}

function normalizeKind(kind: string | null): AccessCodeEventKind {
  switch ((kind ?? '').trim().toLowerCase()) {
    case 'redeemed':
      return 'redeemed'
    case 'page_view':
      return 'page_view'
    case 'action':
      return 'action'
    case 'denied':
      return 'denied'
    default:
      // An unrecognised kind still renders — an audit trail that silently drops
      // rows it does not understand is worse than one that says "something
      // happened here".
      return 'other'
  }
}

function phraseFor(
  action: string,
  count: number | null,
  spoken: Set<string>
): { title: string; area: string | null } {
  if (!action) return { title: 'Activity', area: null }

  const counted = COUNTED_ACTION_PHRASES[action]
  if (counted && count !== null) {
    spoken.add('count')
    return { title: counted(count), area: null }
  }

  const known = ACTION_PHRASES[action]
  if (known) return { title: known, area: null }

  return fallbackPhrase(action)
}

/**
 * An action nobody wrote a phrase for. 'kb.sync_source' becomes
 * "Sync source" with "Kb" as its area, which is still a line a human can read.
 */
function fallbackPhrase(action: string): { title: string; area: string | null } {
  const segments = action.split('.').filter(Boolean)
  const last = segments[segments.length - 1] ?? action
  const area = segments.length > 1 ? sentenceCase(segments[0].replace(/[-_]+/g, ' ')) : null
  return { title: sentenceCase(last.replace(/[-_]+/g, ' ')), area }
}

/**
 * The action on a page view is the generic verb ('page.view'), not the page —
 * the route lives in `target`. Falling back to the action when there is no
 * target would render "Opened Page", which tells the owner nothing.
 */
const GENERIC_PAGE_ACTIONS = new Set(['page.view', 'page_view', 'page.open'])

function pageName(target: string | null, action: string): string {
  const fallback = GENERIC_PAGE_ACTIONS.has(action) ? '' : action
  const raw = (target || fallback || '').trim()
  // 'settings.access' and '/settings/access?tab=x' should reach the same slug.
  const slug = raw
    .replace(/^\/+/, '')
    .split(/[/?#.]/)[0]
    .toLowerCase()
  if (!slug) return 'a page'
  return PAGE_NAMES[slug] ?? sentenceCase(slug.replace(/[-_]+/g, ' '))
}

/**
 * Safe extras from `detail`.
 *
 * Primitives only, capped and truncated. A nested object on a timeline row is
 * either a mistake or something too big to belong there; either way rendering
 * it turns the readable line this feature exists for back into a log dump.
 * (The schema already says detail must never carry anything sensitive — this is
 * the second lock on that door, not the first.)
 */
function describeDetail(detail: Record<string, unknown>, spoken: Set<string>): string | null {
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (parts.length >= NOTE_MAX_FIELDS) break
    if (spoken.has(key)) continue
    if (value === null || value === undefined || typeof value === 'object') continue
    const text = String(value).trim()
    if (!text) continue
    parts.push(`${sentenceCase(key.replace(/[-_]+/g, ' ')).toLowerCase()}: ${truncate(text, NOTE_MAX_VALUE_CHARS)}`)
  }
  return parts.length ? parts.join(' · ') : null
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function sentenceCase(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function lowerFirst(text: string): string {
  if (!text) return ''
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
