// Bounded-concurrency map, order-preserving.
//
// Lifted out of ./index.ts (which still re-exports it under the same name, so
// every existing caller: scripts/ingest.ts, lib/graph/autopilot.ts,
// lib/harness/copilot-tools.ts — is untouched) purely to break an import
// cycle: ./workday.ts and ./smartrecruiters.ts need it to fan out their
// per-posting description fetches, and ./index.ts already imports them.

import pLimit from 'p-limit'

/** Run fn over items with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const run = pLimit(Math.max(1, Math.floor(limit) || 1))
  return Promise.all(items.map((item) => run(() => fn(item))))
}
