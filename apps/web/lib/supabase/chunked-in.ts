// Batches an .in(column, ids) lookup into fixed-size chunks and merges the
// results — for the rare case a query needs an explicit, already-scoped id
// subset too large to safely fit one request's querystring (PostgREST/the
// gateway both cap URL length; a few hundred ids is enough to cross it).
//
// Prefer scoping via an FK join (see lib/harness/agents/matcher.ts's
// ownedJobsQuery) wherever the ids ARE an ownership fence (e.g. "this user's
// company ids") — that replaces the array with a constant-size filter
// instead of merely chunking it. Reach for this helper only when the ids are
// a genuine explicit subset with no such join available.

/** ponytail: fixed batch size, not tuned — 100 is comfortably under every
 *  known URL limit for a uuid-sized id column; revisit if a caller's ids are
 *  much wider than a uuid. */
const DEFAULT_CHUNK_SIZE = 100

export async function chunkedIn<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<T[]>,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<T[]> {
  if (ids.length === 0) return []
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize))
  const results = await Promise.all(chunks.map(fetchChunk))
  return results.flat()
}
