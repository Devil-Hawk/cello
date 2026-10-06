// The watchlist is what the person follows: companies.watching. A company the sourcer or an old
// Gmail sync wrote as a lead (metadata.suggested = true) is not followed, and must never show in a
// company list or count. The database keeps the column in step with that flag while the old writers
// exist (migration 20261008050000); once companies.follow is the only writer (K13) it is the only
// source. Every reader goes through here.

/**
 * PostgREST `or` filter for "followed". The column is not null (it defaults to true), so one
 * condition is enough; it stays an `or` so the callers' builders do not change.
 */
export const TRACKED_FILTER = 'watching.eq.true'

/** Anything with PostgREST's `.or()`, so it works on every query builder. */
interface OrFilterable<T> {
  or(filters: string): T
}

/** Restrict a companies query to followed rows. */
export function trackedOnly<T extends OrFilterable<T>>(query: T): T {
  return query.or(TRACKED_FILTER)
}

/**
 * Row-level twin of trackedOnly, for lists already in memory. A row read before the column existed
 * (or from a fixture) falls back to the lead flag it mirrors.
 */
export function isTrackedCompany(row: { watching?: boolean | null; metadata?: unknown }): boolean {
  if (typeof row.watching === 'boolean') return row.watching
  const m = row.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m)) return true
  return (m as Record<string, unknown>).suggested !== true
}
