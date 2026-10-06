// The person's rule for what Cello starts without being asked: "Strong fits at companies I follow, at
// most 3 a day". After the morning pick this lists which roles the rule starts, in order. Pure code:
// the candidates come from the person's own rows, the filters are plain facts, and the daily cap is
// enforced in SQL (pipeline_transition, p_cap and its ceiling of 10) whatever this returns.

import type { PipelineSettings } from './settings'

export type Chance = 'strong' | 'possible' | 'stretch'

export interface RuleCandidate {
  jobId: string
  chance: Chance | null
  /** The learned want, 0 to 1; null when not learned yet. */
  want: number | null
  /** The role's employer is one the person follows. */
  followed: boolean
  /** Filtered out by a stated target or hidden by the person. */
  filtered: boolean
  /** The person reacted to it (Interested, Not for me). */
  reacted: boolean
  /** An application already exists for it, or its posting is a duplicate. */
  hasApplication: boolean
  /** Its posting was sent before. */
  sent: boolean
}

const RANK: Record<Chance, number> = { strong: 0, possible: 1, stretch: 2 }

/**
 * The roles the rule starts, best first: by want, then by chance, then by the order given. `startedToday`
 * is how many the rule already started in the person's day; the answer is at most what is left of the
 * cap, so the fourth role is never started and the summary can say "1 more matched your rule".
 */
export function candidatesForRule(
  want: PipelineSettings['want'],
  candidates: readonly RuleCandidate[],
  startedToday = 0,
): { start: RuleCandidate[]; heldBack: number } {
  if (want.mode !== 'rule') return { start: [], heldBack: 0 }
  const eligible = candidates
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        c.chance !== null &&
        c.chance !== 'stretch' &&
        want.chance.includes(c.chance) &&
        (!want.watchedOnly || c.followed) &&
        !c.filtered &&
        !c.reacted &&
        !c.hasApplication &&
        !c.sent,
    )
    .sort((a, b) => (b.c.want ?? -1) - (a.c.want ?? -1) || RANK[a.c.chance as Chance] - RANK[b.c.chance as Chance] || a.i - b.i)
    .map(({ c }) => c)
  const room = Math.max(0, want.maxPerDay - startedToday)
  return { start: eligible.slice(0, room), heldBack: Math.max(0, eligible.length - room) }
}
