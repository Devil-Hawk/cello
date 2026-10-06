// What to say about a tracked company's roles. "0 open roles" and "Never
// checked" are claims Cello cannot back when it has not looked yet or cannot
// read the site, so the line says what is true: checking now, when the next
// check is, or that the careers site cannot be read and why.
//
// Pure and framework-free: lib/ingest/run.ts imports dueAt from here, so the
// reader and the line on screen agree on when a company is due. When the next
// check is, the clock says (lib/clock/status.ts); this file never guesses it.

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
  budget: 'its site is large, and one check reads only part of it, so the next check reads more',
  role_pages: 'it lists roles, but their pages cannot be read without a browser',
  render_failed: "Cello's browser could not read it just now, and the next check tries again",
  model_unavailable: 'no free reading slot was available, and the next check tries again',
  model_limit: "today's free reading limit was reached, and the next check tries again",
}

/** The check recorded while only a browser could read the site: the scheduled pass is next. */
export const READING_REASON = 'reading'
/** The page was reached and only the free reading step could not run: a wait for a slot, not a verdict on the site. */
export const WAITING_REASONS = ['model_unavailable', 'model_limit']

// The reader uses these: dream companies hourly, others daily.
const DREAM_INTERVAL_MINUTES = 60
const DEFAULT_INTERVAL_MINUTES = 1440
const DUE_SLACK_MINUTES = 5
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

export type RolesStatus =
  | { kind: 'roles'; count: number }
  | { kind: 'checking' }
  | { kind: 'reading'; nextCheckAt: number | null; waiting?: boolean; large?: boolean }
  | { kind: 'not_checked'; nextCheckAt: number | null; now: number }
  | { kind: 'empty'; nextCheckAt: number | null; now: number }
  | { kind: 'unreadable'; reason: string; careersUrl: string | null }

export function rolesStatus(
  company: StatusCompany,
  openRoles: number,
  /** `nextCheckAt` is the person's next check from the clock (epoch ms); without it a line leaves the time out. */
  opts: { checking?: boolean; now?: number; nextCheckAt?: number | null } = {}
): RolesStatus {
  const now = opts.now ?? Date.now()
  const nextCheckAt = opts.nextCheckAt ?? null
  if (openRoles > 0) return { kind: 'roles', count: openRoles }
  if (opts.checking) return { kind: 'checking' }
  const check = readSourceCheck(company.metadata)
  if (check && !check.readable && check.reason === READING_REASON) {
    return { kind: 'reading', nextCheckAt }
  }
  // The site is bigger than one check reads: not "no roles", and the next scheduled check goes on.
  if (check && !check.readable && check.reason === 'budget') {
    return { kind: 'reading', nextCheckAt, large: true }
  }
  if (check && !check.readable && check.reason && WAITING_REASONS.includes(check.reason)) {
    return { kind: 'reading', nextCheckAt, waiting: true }
  }
  if (check && !check.readable) {
    const reason = (check.reason && REASON_COPY[check.reason]) || 'it could not be read'
    return { kind: 'unreadable', reason, careersUrl: company.career_url?.trim() || null }
  }
  return { kind: lastCheckedMs(company) === null ? 'not_checked' : 'empty', nextCheckAt, now }
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
      const t = s.nextCheckAt === null ? '' : `. Next check around ${new Date(s.nextCheckAt).toISOString().slice(11, 16)} UTC`
      if (s.large) return { text: `This site is large and Cello is still reading it${t}` }
      return { text: `${s.waiting ? 'Waiting for a free reading slot' : 'Cello is reading this site'}${t}` }
    }
    case 'not_checked':
      return { text: s.nextCheckAt === null ? 'Not checked yet' : `Not checked yet, next check ${inAbout(s.nextCheckAt - s.now)}` }
    case 'empty':
      return { text: s.nextCheckAt === null ? 'No open roles right now' : `No open roles right now, next check ${inAbout(s.nextCheckAt - s.now)}` }
    case 'unreadable':
      return { text: `Cello can't read this careers site: ${s.reason}`, href: s.careersUrl ?? undefined }
  }
}
