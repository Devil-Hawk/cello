// Bounded-concurrency map, order-preserving.
//
// Lifted out of ./index.ts (which still re-exports it under the same name, so
// every existing caller — scripts/ats-refresh.ts, lib/graph/autopilot.ts,
// lib/harness/copilot-tools.ts — is untouched) purely to break an import
// cycle: ./workday.ts and ./smartrecruiters.ts need it to fan out their
// per-posting description fetches, and ./index.ts already imports them.

/** Run fn over items with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
