// The watchlist is what the person follows: companies.watching. A company the sourcer or an old
// Gmail sync wrote as a lead (metadata.suggested = true) is not followed, and must never show in a
// company list or count. One function writes the column (companies_follow, migration 20261013000003),
// so a lead stays unfollowed until the person follows it. Every reader goes through here, and
// followCompanies below is the one TypeScript way to write.

/**
 * PostgREST `or` filter for "followed". The column is not null (it defaults to false), so one
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

export type FollowResult = { ok: true; changed: number } | { ok: false; sentence: string }

/**
 * Follow or unfollow companies, and pin or unpin them, through the one writer. `userId` is whose
 * companies they are: a session client acts on its own rows only, the server passes the person.
 * At most 5 pins, on followed companies only; the answer says which rule refused.
 */
export async function followCompanies(
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  userId: string,
  ids: string[],
  change: { follow?: boolean; pin?: boolean },
): Promise<FollowResult> {
  const { data, error } = await db.rpc('companies_follow', {
    p_ids: ids,
    p_on: change.follow ?? null,
    p_user: userId,
    p_pin: change.pin ?? null,
  })
  if (error) return { ok: false, sentence: 'Could not save that. Try again.' }
  const r = data as { ok?: boolean; changed?: number; sentence?: string } | null
  if (r?.ok) return { ok: true, changed: r.changed ?? 0 }
  return { ok: false, sentence: r?.sentence ?? 'Could not save that. Try again.' }
}
