// The daily shortlist: which roles to show, in what order, and the sentence that
// explains each one.
//
// Order is by want first (the roles this person is likely to want), then by
// chance (the ones they are most likely to win), with no weights between them.
// A small, deliberate share of the list is exploration: roles the model is least
// sure about, labelled as such, so Cello keeps learning what the person wants
// instead of only confirming what it already believes.

import { entropy } from './math'
import type { Chance, PickKind, ShortlistPick, WantTier } from './types'

export const SHORTLIST_SIZE = 6
export const EXPLORE_COUNT = 1

/** Cut points for how strongly a role is wanted. They name bands; they do not weigh anything. */
export const WANT_HIGH = 0.66
export const WANT_MEDIUM = 0.33

export type { WantTier }

export function wantTier(p: number): WantTier {
  return p >= WANT_HIGH ? 'high' : p >= WANT_MEDIUM ? 'medium' : 'low'
}

const TIER_RANK: Record<WantTier, number> = { high: 3, medium: 2, low: 1 }
const CHANCE_RANK: Record<Chance, number> = { strong: 4, possible: 3, cannot_assess: 2, stretch: 1 }

export interface Rankable {
  jobId: string
  /** Probability the person is interested. */
  p: number
  reason: string
  chance: Chance
  gaps: string[]
}

/** Best first: want tier, then chance, then the probability itself. */
export function compareRankable(a: Rankable, b: Rankable): number {
  return (
    TIER_RANK[wantTier(b.p)] - TIER_RANK[wantTier(a.p)] ||
    CHANCE_RANK[b.chance] - CHANCE_RANK[a.chance] ||
    b.p - a.p ||
    a.jobId.localeCompare(b.jobId)
  )
}

/**
 * The exploration pick: among the roles not already chosen and not hopeless on
 * chance, the one whose want Cello is least sure of (probability nearest a coin
 * flip), because that is the answer that teaches the most.
 */
export function pickExploration(pool: readonly Rankable[], exclude: ReadonlySet<string>, count: number): Rankable[] {
  return pool
    .filter((r) => !exclude.has(r.jobId) && r.chance !== 'stretch')
    .sort((a, b) => entropy(b.p) - entropy(a.p) || a.jobId.localeCompare(b.jobId))
    .slice(0, count)
}

export interface ShortlistOptions {
  size?: number
  exploreCount?: number
}

export interface ChosenPick {
  item: Rankable
  kind: PickKind
}

/** Chooses the picks and their order: the best by want and chance, then the exploration picks last. */
export function chooseShortlist(pool: readonly Rankable[], opts: ShortlistOptions = {}): ChosenPick[] {
  const size = opts.size ?? SHORTLIST_SIZE
  const exploreWanted = Math.min(opts.exploreCount ?? EXPLORE_COUNT, Math.max(0, size - 1))
  const sorted = [...pool].sort(compareRankable)
  const top = sorted.slice(0, size - exploreWanted)
  const topIds = new Set(top.map((r) => r.jobId))
  const explore = pickExploration(sorted, topIds, size - top.length)
  return [...top.map((item) => ({ item, kind: 'top' as const })), ...explore.map((item) => ({ item, kind: 'explore' as const }))]
}

// ---------------------------------------------------------------------------
// The one sentence
// ---------------------------------------------------------------------------

function stripEnd(s: string): string {
  return s.trim().replace(/[.!?\s]+$/, '')
}

/** Lower-cases a common sentence starter so a clause can follow a colon; proper nouns keep their capital. */
function lowerFirst(s: string): string {
  return /^(You|Your|It|This|That|Another|Nothing|The|A|An|Same|Both|No)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/** What the person is told about their chance, as a clause that completes the sentence. */
export function chanceClause(chance: Chance, gaps: readonly string[]): string {
  const gap = gaps.find((g) => !g.startsWith('Nice to have')) ?? gaps[0]
  const gapText = gap ? lowerFirst(stripEnd(gap.replace(/^Only partly shown:\s*/i, ''))) : null
  switch (chance) {
    case 'strong':
      return 'your resume shows everything it asks for'
    case 'possible':
      return gapText ? `it is within reach, though ${gapText} is not clearly on your resume` : 'it is within reach'
    case 'stretch':
      return gapText ? `it is a stretch, since ${gapText} is not on your resume` : 'it is a stretch on what your resume shows'
    case 'cannot_assess':
      return 'the posting is too thin to check your chances yet'
  }
}

/** One human sentence: why the person might want it, then what their chances look like. */
export function explainPick(item: Rankable, kind: PickKind): string {
  const why = stripEnd(item.reason) || 'Nothing you have said or done points to this one either way'
  const chance = chanceClause(item.chance, item.gaps)
  return kind === 'explore'
    ? `Outside your usual picks: ${lowerFirst(why)}, and ${chance}.`
    : `${why}, and ${chance}.`
}

export function toPicks(chosen: readonly ChosenPick[]): ShortlistPick[] {
  return chosen.map((c, i) => ({ jobId: c.item.jobId, position: i + 1, kind: c.kind, explanation: explainPick(c.item, c.kind) }))
}
