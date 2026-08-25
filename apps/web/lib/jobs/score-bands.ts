// Canonical 0-100 match-score -> band mapping.
//
// The SAME thresholds lib/format.ts matchTone() uses for job-card badges,
// lib/strategy/questions/matchScoreAccuracy.ts uses for its outcome buckets, and
// components/insights/compute.ts uses for the "what's working by score band" cut.
// This file exists so the /insights match-score histogram (components/insights/
// score-histogram-card.tsx + app/api/jobs/insights-summary/route.ts) uses the
// identical boundaries instead of a silently-drifting fourth copy — one
// vocabulary for "how good is this match" everywhere in the product.
//
// Pure, framework-free (no next/*, no path aliases) so it can be imported from a
// client component, a route handler, or a script alike, matching the
// lib/jobs/classify.ts convention.

export type ScoreBand = 'strong' | 'good' | 'fair' | 'weak' | 'unscored'

export interface ScoreBandMeta {
  key: ScoreBand
  label: string
  /** Inclusive lower bound; null for the unscored band. */
  min: number | null
  /** Inclusive upper bound; null for the unscored band. */
  max: number | null
}

// Ordered worst -> best. "Unscored" sorts first: "we don't know yet" is a
// different claim than "bad", and shouldn't visually anchor the low end of a
// quality scale it isn't part of.
export const SCORE_BANDS: readonly ScoreBandMeta[] = [
  { key: 'unscored', label: 'Unscored', min: null, max: null },
  { key: 'weak', label: 'Weak (<50)', min: 0, max: 49 },
  { key: 'fair', label: 'Fair (50-69)', min: 50, max: 69 },
  { key: 'good', label: 'Good (70-84)', min: 70, max: 84 },
  { key: 'strong', label: 'Strong (85+)', min: 85, max: 100 },
]

export function scoreBandFor(score: number | null | undefined): ScoreBand {
  if (score == null || Number.isNaN(score)) return 'unscored'
  if (score >= 85) return 'strong'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'weak'
}

export function scoreBandLabel(band: ScoreBand): string {
  return SCORE_BANDS.find((b) => b.key === band)?.label ?? band
}
