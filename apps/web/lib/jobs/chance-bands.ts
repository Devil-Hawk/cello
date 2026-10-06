// The buckets a role falls into for the insights charts: its chance, or one of two
// states that have no chance yet. Replaces the 0-100 score bands.
//
// Pure and framework-free (no next/*, no path aliases) so a client component, a
// route handler and a script can all import it.

export type ChanceBand = 'unassessed' | 'filtered' | 'stretch' | 'possible' | 'strong'

export interface ChanceBandMeta {
  key: ChanceBand
  label: string
}

// Ordered weakest to strongest. "Not assessed yet" sorts first: not knowing is a
// different claim than a weak chance, and should not anchor the low end of a scale
// it is not part of. "Filtered out" is roles a fact the person stated rules out.
export const CHANCE_BANDS: readonly ChanceBandMeta[] = [
  { key: 'unassessed', label: 'Not assessed yet' },
  { key: 'filtered', label: 'Filtered out' },
  { key: 'stretch', label: 'Stretch' },
  { key: 'possible', label: 'Possible' },
  { key: 'strong', label: 'Strong' },
]

/** The band for a role's verdict columns. A role with no usable chance is "not assessed yet" unless a stated fact filtered it. */
export function chanceBandFor(chance: string | null | undefined, blockedReasons?: unknown): ChanceBand {
  if (Array.isArray(blockedReasons) && blockedReasons.length > 0) return 'filtered'
  if (chance === 'strong' || chance === 'possible' || chance === 'stretch') return chance
  return 'unassessed'
}

export function chanceBandLabel(band: ChanceBand): string {
  return CHANCE_BANDS.find((b) => b.key === band)?.label ?? band
}
