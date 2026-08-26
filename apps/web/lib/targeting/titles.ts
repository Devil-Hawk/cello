// The job titles the user is actually looking for — "multiple and any number".
//
// WHERE THIS LIVES AND WHY IT IS NOT IN lib/targeting.ts
//   lib/targeting.ts owns the machine-FILTERABLE facets: functions, seniority,
//   countries, languages, remoteOnly, minScore, exclusions. Every one of those
//   becomes a SQL predicate that removes rows.
//
//   Target titles are a different kind of preference: they RANK, they do not
//   filter. "I want a Data Scientist role" must not delete the Data Engineer
//   posting from the list — it must put it lower. So this deliberately does not
//   extend the Targeting interface, whose whole contract is "empty means no
//   constraint on this dimension" (i.e. every populated field narrows the
//   corpus). A titles field in there would be read by the ingest relevance
//   gate and the digest as another gate, which is not what the user asked for.
//
//   It reads out of the SAME jsonb blob (profiles.preferences.targeting.titles)
//   so it travels with the rest of the user's targeting and is one migration
//   away from being surfaced in Settings — see the note on resolveTargetTitles.
//
// Pure and framework-free: no React, no Supabase, no network.

/**
 * Cap on stored/active target titles.
 *
 * Not an arbitrary round number: every title is parsed and scored against
 * every job on the loaded page on each render, and — more importantly — a
 * user who lists thirty titles has expressed no preference at all, because
 * almost everything will match something. Twelve is enough to describe a real
 * search (a few role families x a couple of levels) and few enough that the
 * ranking still means something. Matches MAX_STANDING_PREFERENCES in
 * lib/insights/store.ts, which caps the injected-preferences block for the
 * same reason.
 */
export const MAX_TARGET_TITLES = 12

/** Longest single title kept. Past this it is a job description, not a title. */
export const MAX_TITLE_LENGTH = 80

/**
 * Separator for the `?titles=` URL form.
 *
 * NOT a comma. Real job titles are full of commas — "Data Scientist, Trust &
 * Safety" — and splitting on one would silently shred a title the user typed
 * into two meaningless halves. A pipe effectively never appears in a typed
 * title, and normalizeTargetTitle strips any that do so a round-trip through
 * the URL can never invent an extra entry.
 */
export const TITLES_PARAM_SEPARATOR = '|'

/**
 * Clean one title for storage/display. Casing is PRESERVED — this string is
 * shown back to the user as the reason a job ranked where it did, and
 * "senior data scientist" reads like a bug next to their own "Senior Data
 * Scientist". Matching is case-insensitive downstream, so nothing depends on
 * the casing being normalized here.
 */
export function normalizeTargetTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(new RegExp(`\\${TITLES_PARAM_SEPARATOR}`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim()
}

/** Clean, drop empties, de-dupe case-insensitively, and cap. Never throws. */
export function normalizeTargetTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const title = normalizeTargetTitle(item)
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(title)
    if (out.length >= MAX_TARGET_TITLES) break
  }
  return out
}

/**
 * Read target titles out of a raw `profiles.preferences` jsonb blob.
 *
 * Tolerates null/undefined preferences, a missing `targeting` key, and wrong
 * types anywhere — same defensive contract as resolveTargeting(). Returns []
 * ("no preference"), never throws.
 *
 * NOTE FOR WHOEVER ADDS THE SETTINGS CONTROL: nothing writes this key yet.
 * app/api/settings/targeting/route.ts round-trips its PUT body through
 * resolveTargeting(), which only copies the fields it knows about, so a
 * `titles` array posted today is dropped on the floor. Until that route and
 * components/settings/targeting-tab.tsx learn the field, the jobs page's
 * `?titles=` URL parameter is the only writer — this reader is already wired
 * for the stored form so no consumer changes when it lands.
 *
 * @param preferences the whole `profiles.preferences` object (NOT `.targeting`)
 */
export function resolveTargetTitles(preferences: unknown): string[] {
  const prefs = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const raw = (prefs.targeting && typeof prefs.targeting === 'object' ? prefs.targeting : {}) as Record<string, unknown>
  return normalizeTargetTitles(raw.titles)
}

/**
 * Parse the `?titles=` URL form. An EMPTY string is meaningful and distinct
 * from an absent parameter: it means "I explicitly cleared my titles here",
 * which the caller uses to stop falling back to the stored preference — the
 * same always-write override convention the jobs page already uses for its
 * fn/sr/country/lang facets.
 */
export function parseTargetTitlesParam(param: string | null | undefined): string[] {
  if (typeof param !== 'string' || param.trim() === '') return []
  return normalizeTargetTitles(param.split(TITLES_PARAM_SEPARATOR))
}

/** Serialize for the `?titles=` URL form. Round-trips through parse exactly. */
export function serializeTargetTitlesParam(titles: readonly string[]): string {
  return normalizeTargetTitles([...titles]).join(TITLES_PARAM_SEPARATOR)
}
