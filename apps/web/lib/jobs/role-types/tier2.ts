// Tier 2 of role typing (K15b, blueprint 6.1): the server embedder compares a title with each role type's
// centroid. Free, no key, no model. It accepts an answer only when the best type is close enough AND clearly
// ahead of the runner-up; anything else goes on to tier 3 (a model step) or stays pending.
//
// The two thresholds are set once, on S2's labelled set, before the `role_types_tier2` flag is turned on.
// They live in one exported constant so the scorecard and the routine read the same numbers.

import { embed384 } from '@/lib/memory/embedder'

export const TIER2 = {
  /** Cosine similarity the best type must reach. */
  accept: 0.8,
  /** How far ahead of the runner-up it must be. */
  margin: 0.05,
} as const

export interface Centroid {
  /** The taxonomy id of the role type. */
  id: string
  vector: number[]
}

export type Tier2Result =
  | { typed: true; type: string; similarity: number; margin: number; runnerUp: string | null }
  | { typed: false; reason: 'no_centroids' | 'below_accept' | 'below_margin'; best: string | null; similarity: number }

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/** Decides one title's type from its vector. Pure: no embedding here, so the thresholds are testable. */
export function tier2(vector: readonly number[], centroids: readonly Centroid[], t: { accept: number; margin: number } = TIER2): Tier2Result {
  if (centroids.length === 0) return { typed: false, reason: 'no_centroids', best: null, similarity: 0 }
  const ranked = centroids.map((c) => ({ id: c.id, s: cosine(vector, c.vector) })).sort((a, b) => b.s - a.s)
  const best = ranked[0]
  const second = ranked[1]
  const margin = second ? best.s - second.s : best.s
  if (best.s < t.accept) return { typed: false, reason: 'below_accept', best: best.id, similarity: best.s }
  if (margin < t.margin) return { typed: false, reason: 'below_margin', best: best.id, similarity: best.s }
  return { typed: true, type: best.id, similarity: best.s, margin, runnerUp: second?.id ?? null }
}

/** Embeds titles on the server. Null when there is no embedder: the routine then skips this tier and says so. */
export async function embedTitles(titles: readonly string[]): Promise<number[][] | null> {
  return embed384([...titles])
}
