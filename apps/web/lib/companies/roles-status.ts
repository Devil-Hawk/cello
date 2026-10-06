// What to say about a tracked company's roles. "0 open roles" and "Never
// checked" are claims Cello cannot back when it has not looked yet or cannot
// read the site, so the line says what is true: checking now, when the next
// check is, or that the careers site cannot be read and why.
//
// Pure and framework-free: scripts/ingest.ts imports dueAt from here, so
// the line on screen and the scheduler agree on when a company is next checked.

/** The result of the last attempt to read a company's roles (companies.metadata.source_check). */
export interface SourceCheck {
  checked_at: string
  readable: boolean
  /** Why it could not be read. One of REASON_COPY's keys; unknown codes get a generic line. */
  reason?: string
}

export interface StatusCompany {
  metadata?: unknown
  last_scraped_at?: string | null
  is_dream_company?: boolean | null
  scrape_frequency?: number | null
  career_url?: string | null
}

export const REASON_COPY: Record<string, string> = {
  no_careers_url: 'no careers page was added',
  no_supported_board: 'its careers page is not on a job board Cello can read yet',
  board_unreachable: 'its job board did not answer',
  // Written by the reader (lib/ingest/reader).
  bot_check: 'its site asks visitors to pass a bot check, which Cello does not do',
  login_required: 'its careers site needs a login',
  robots: 'its robots.txt asks automated readers to stay away from its careers pages',
  no_roles: 'no open roles were found on it',
  unreachable: 'it did not answer',
  read_failed: 'reading it failed with an error, and the next check tries again',
  role_pages: 'it lists roles, but their pages cannot be read without a browser',
  render_failed: "Cello's browser could not read it just now, and the next check tries again",
  model_unavailable: 'no free reading slot was available, and the next check tries again',
  model_limit: "today's free reading limit was reached, and the next check tries again",
}

/** The check recorded while only a browser could read the site: the scheduled pass is next. */
export const READING_REASON = 'reading'
/** The page was reached and only the free reading step could not run: a wait for a slot, not a verdict on the site. */
export const WAITING_REASONS = ['model_unavailable', 'model_limit']

// The scheduled pass (scripts/ingest.ts, every six hours) uses these: dream companies are due after an hour and the rest after a day, so a pass picks them up at its next tick.
const DREAM_INTERVAL_MINUTES = 60
const DEFAULT_INTERVAL_MINUTES = 1440
const DUE_SLACK_MINUTES = 5
// .github/workflows/scrape.yml: '41 */6 * * *' (a test keeps the two in step).
const TICK_MINUTE = 41
const TICK_EVERY_HOURS = 6
const MIN_MS = 60_000
const HOUR_MS = 3_600_000

export function readSourceCheck(metadata: unknown): SourceCheck | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const raw = (metadata as Record<string, unknown>).source_check
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.checked_at !== 'string' || Number.isNaN(Date.parse(r.checked_at)) || typeof r.readable !== 'boolean') {
    return null
  }
  return { checked_at: r.checked_at, readable: r.readable, reason: typeof r.reason === 'string' ? r.reason : undefined }
}

/** The later of the last scrape and the last recorded check, in ms; null when never checked. */
export function lastCheckedMs(company: StatusCompany): number | null {
  const times = [company.last_scraped_at, readSourceCheck(company.metadata)?.checked_at]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((t) => !Number.isNaN(t))
  return times.length ? Math.max(...times) : null
}

/** Earliest moment the scheduler treats the company as due again (0 when never checked). */
export function dueAt(company: StatusCompany): number {
  const last = lastCheckedMs(company)
  if (last === null) return 0
  const base = company.is_dream_company ? DREAM_INTERVAL_MINUTES : DEFAULT_INTERVAL_MINUTES
  const freq =
    typeof company.scrape_frequency === 'number' && Number.isFinite(company.scrape_frequency)
      ? company.scrape_frequency
      : 0
  return last + (Math.max(base, freq) - DUE_SLACK_MINUTES) * MIN_MS
}

/** The first scheduler tick (minute 41 of 00/06/12/18 UTC) at or after `ms`. */
export function firstTickAtOrAfter(ms: number): number {
  const d = new Date(ms)
  const hourStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
  for (let h = 0; h <= TICK_EVERY_HOURS + 1; h++) {
    const t = new Date(hourStart + h * HOUR_MS)
    if (t.getUTCHours() % TICK_EVERY_HOURS !== 0) continue
    const tick = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), TICK_MINUTE)
    if (tick >= ms) return tick
  }
  return ms
}

/** When the next scheduled check will run. */
export function nextCheckAt(company: StatusCompany, now: number = Date.now()): number {
  return firstTickAtOrAfter(Math.max(now, dueAt(company)))
}

export type RolesStatus =
  | { kind: 'roles'; count: number }
  | { kind: 'checking' }
  | { kind: 'reading'; nextCheckAt: number; waiting?: boolean }
  | { kind: 'not_checked'; nextCheckAt: number; now: number }
  | { kind: 'empty'; nextCheckAt: number; now: number }
  | { kind: 'unreadable'; reason: string; careersUrl: string | null }

export function rolesStatus(
  company: StatusCompany,
  openRoles: number,
  opts: { checking?: boolean; now?: number } = {}
): RolesStatus {
  const now = opts.now ?? Date.now()
  if (openRoles > 0) return { kind: 'roles', count: openRoles }
  if (opts.checking) return { kind: 'checking' }
  const check = readSourceCheck(company.metadata)
  if (check && !check.readable && check.reason === READING_REASON) {
    return { kind: 'reading', nextCheckAt: firstTickAtOrAfter(now) }
  }
  if (check && !check.readable && check.reason && WAITING_REASONS.includes(check.reason)) {
    return { kind: 'reading', nextCheckAt: firstTickAtOrAfter(now), waiting: true }
  }
  if (check && !check.readable) {
    const reason = (check.reason && REASON_COPY[check.reason]) || 'it could not be read'
    return { kind: 'unreadable', reason, careersUrl: company.career_url?.trim() || null }
  }
  const next = nextCheckAt(company, now)
  return { kind: lastCheckedMs(company) === null ? 'not_checked' : 'empty', nextCheckAt: next, now }
}

/**
 * Said beside a company's roles when Cello has read only part of its site: a
 * partial read must not look like the whole. Null when the read was the whole
 * list, or when nothing is known about its size. Reads metadata.reader
 * (written by lib/ingest/run.ts).
 */
export function partialReadNote(metadata: unknown, openRoles: number): string | null {
  if (openRoles <= 0 || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const r = (metadata as Record<string, unknown>).reader
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { listed, read, untitled, window } = r as { listed?: unknown; read?: unknown; untitled?: unknown; window?: unknown }
  const n = (v: number) => v.toLocaleString('en-US')
  if (typeof listed === 'number' && listed > 0) {
    const done = typeof read === 'number' && read >= 0 ? Math.min(read, listed) : 0
    if (done >= listed) return null
    const more = untitled === true ? 'Its list names no titles, so Cello reads the roles in turn, more each check.' : 'More each check.'
    return `Read ${n(done)} of about ${n(listed)} roles so far. ${more}`
  }
  if (window === true) return 'Showing the newest roles Cello matched on this site, not every role it lists.'
  return null
}

function inAbout(ms: number): string {
  if (ms < HOUR_MS) return 'in under an hour'
  const h = Math.round(ms / HOUR_MS)
  return h >= 48 ? `in about ${Math.round(h / 24)} days` : `in about ${h} h`
}

/** One line for a row or a header. `href` is set when the line links to the careers page. */
export function rolesStatusLine(s: RolesStatus): { text: string; href?: string } {
  switch (s.kind) {
    case 'roles':
      return { text: `${s.count} open ${s.count === 1 ? 'role' : 'roles'}` }
    case 'checking':
      return { text: 'Checking now' }
    case 'reading': {
      const t = new Date(s.nextCheckAt).toISOString().slice(11, 16)
      return { text: s.waiting ? `Waiting for a free reading slot. Next check around ${t} UTC` : `Cello is reading this site. Next check around ${t} UTC` }
    }
    case 'not_checked':
      return { text: `Not checked yet, next check ${inAbout(s.nextCheckAt - s.now)}` }
    case 'empty':
      return { text: `No open roles right now, next check ${inAbout(s.nextCheckAt - s.now)}` }
    case 'unreadable':
      return { text: `Cello can't read this careers site: ${s.reason}`, href: s.careersUrl ?? undefined }
  }
}
