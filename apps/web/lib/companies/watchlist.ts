// The watchlist is what the person added. Rows the sourcer or an old Gmail sync
// wrote with metadata.suggested = true are leads, not tracked companies, and
// must never show in a company list or count. Every reader goes through here.

/**
 * PostgREST `or` filter for "not suggested". `metadata` is a nullable jsonb and
 * most rows have NULL, so `neq` alone (or `.not('metadata','cs',...)`) would
 * drop them under SQL three-valued logic: the `is.null` branch keeps them.
 */
export const TRACKED_FILTER = 'metadata->>suggested.is.null,metadata->>suggested.neq.true'

/** Anything with PostgREST's `.or()`, so it works on every query builder. */
interface OrFilterable<T> {
  or(filters: string): T
}

/** Restrict a companies query to tracked rows. */
export function trackedOnly<T extends OrFilterable<T>>(query: T): T {
  return query.or(TRACKED_FILTER)
}

/** Row-level twin of trackedOnly, for lists already in memory. */
export function isTrackedCompany(row: { metadata?: unknown }): boolean {
  const m = row.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m)) return true
  return (m as Record<string, unknown>).suggested !== true
}
