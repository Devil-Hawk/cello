// Shared targeting-preferences contract.
//
// Stored at profiles.preferences.targeting (jsonb). This is the ONE place that
// defines what "the jobs I care about" means; the jobs list, the matcher, the
// ingest relevance gate and the digest all read it through resolveTargeting().
//
// PRODUCT DECISION — there are NO opinionated defaults.
// An empty/unset field means "no constraint on this dimension", NOT "use our
// guess". resolveTargeting({}) returns a fully-empty object that filters
// nothing. We previously shipped hardcoded keyword/geo assumptions inside the
// ingest layer and it silently decided the product's whole worldview (German
// job boards, substring keyword matching). The user configures targeting; when
// they have not, we show everything and say so.

export interface Targeting {
  /** Job function slugs from lib/jobs/classify.ts JOB_FUNCTIONS. Empty = any. */
  functions: string[]
  /** Seniority slugs from lib/jobs/classify.ts SENIORITY_LEVELS. Empty = any. */
  seniority: string[]
  /** ISO 3166-1 alpha-2 country codes, uppercased. Empty = any country. */
  countries: string[]
  /** When true, only jobs classified is_remote. False = no constraint. */
  remoteOnly: boolean
  /** ISO 639-1 language codes, lowercased. Empty = any language. */
  languages: string[]
  /** Minimum match_score (0-100) to surface. null = no minimum. */
  minScore: number | null
  /** Company names to never surface, lowercased. Empty = exclude nothing. */
  excludedCompanies: string[]
  /** Title/description keywords to never surface, lowercased. Empty = none. */
  excludedKeywords: string[]
}

/** A Targeting object that constrains nothing. Never mutate — always spread. */
export const EMPTY_TARGETING: Targeting = {
  functions: [],
  seniority: [],
  countries: [],
  remoteOnly: false,
  languages: [],
  minScore: null,
  excludedCompanies: [],
  excludedKeywords: [],
}

/** Coerce an unknown value into a de-duped array of non-empty trimmed strings. */
function toStringArray(value: unknown, transform: (s: string) => string): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = transform(item.trim())
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

const lower = (s: string) => s.toLowerCase()
const upper = (s: string) => s.toUpperCase()

/**
 * Read targeting out of a raw `profiles.preferences` jsonb blob.
 *
 * Tolerates: null/undefined preferences, a missing `targeting` key, wrong types
 * for any field, and stray non-string array members. Never throws.
 *
 * @param preferences the whole `profiles.preferences` object (NOT `.targeting`)
 */
export function resolveTargeting(preferences: unknown): Targeting {
  const prefs = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const raw = (prefs.targeting && typeof prefs.targeting === 'object' ? prefs.targeting : {}) as Record<string, unknown>

  let minScore: number | null = null
  if (typeof raw.minScore === 'number' && Number.isFinite(raw.minScore)) {
    minScore = Math.max(0, Math.min(100, Math.round(raw.minScore)))
  }

  return {
    functions: toStringArray(raw.functions, lower),
    seniority: toStringArray(raw.seniority, lower),
    countries: toStringArray(raw.countries, upper),
    remoteOnly: raw.remoteOnly === true,
    languages: toStringArray(raw.languages, lower),
    minScore,
    excludedCompanies: toStringArray(raw.excludedCompanies, lower),
    excludedKeywords: toStringArray(raw.excludedKeywords, lower),
  }
}

/**
 * True when the user has expressed at least one targeting constraint.
 *
 * Drives the "targeting not configured yet" empty state — when this is false
 * the UI must show everything rather than pretending an empty result set means
 * "no jobs match you".
 */
export function isTargetingConfigured(t: Targeting): boolean {
  return (
    t.functions.length > 0 ||
    t.seniority.length > 0 ||
    t.countries.length > 0 ||
    t.remoteOnly ||
    t.languages.length > 0 ||
    t.minScore !== null ||
    t.excludedCompanies.length > 0 ||
    t.excludedKeywords.length > 0
  )
}

/** Serialize back into the shape stored at profiles.preferences.targeting. */
export function serializeTargeting(t: Targeting): Targeting {
  return { ...t }
}
