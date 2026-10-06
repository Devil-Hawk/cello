// A posting older than this is not an open role, whatever the board still lists
// (evergreen requisitions, forgotten reqs). One rule, used where roles are
// stored (every provider) and where they are listed; lib/ingest/reader/legit.ts applies it to every role the reader reads.
//
// Pure: no I/O, so lib/ats, the scripts and the new ingestion path can all call it.

export const ROLE_MAX_AGE_DAYS = 180
const DAY_MS = 86_400_000

/** The oldest posted_at that still counts as open, as an ISO string. */
export function staleCutoffIso(now: number = Date.now()): string {
  return new Date(now - ROLE_MAX_AGE_DAYS * DAY_MS).toISOString()
}

/**
 * True when the provider's own date parses and is older than the cutoff.
 * An undated posting is not stale: some sources never carry a date, and
 * dropping them would hide real roles.
 */
export function isStalePosting(postedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!postedAt) return false
  const t = Date.parse(postedAt)
  return !Number.isNaN(t) && now - t > ROLE_MAX_AGE_DAYS * DAY_MS
}

/** The two PostgREST calls every role list needs, on any query builder. */
interface RoleQuery<T> {
  or(filters: string, options?: { referencedTable?: string }): T
  not(column: string, operator: string, value: unknown): T
}

/**
 * Restrict a jobs query to open roles: posted inside the window (or undated)
 * and not closed. With referencedTable the query is on another table that
 * embeds jobs (companies -> jobs(...)), so only the embedded rows are filtered.
 */
export function openRolesOnly<T extends RoleQuery<T>>(
  query: T,
  opts: { referencedTable?: string; now?: number } = {}
): T {
  const { referencedTable, now } = opts
  const prefix = referencedTable ? `${referencedTable}.` : ''
  const aged = query.or(`posted_at.gte.${staleCutoffIso(now)},posted_at.is.null`, referencedTable ? { referencedTable } : undefined)
  return aged.not(`${prefix}still_open`, 'is', false)
}
