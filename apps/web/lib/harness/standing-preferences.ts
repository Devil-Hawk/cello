// Durable, user-stated preferences — the things you told Cello about what you
// want, kept across conversations.
//
// WHY THIS EXISTS
//   The copilot ships 18 tools. It can source, score, research, tailor, draft
//   outreach and trigger runs — and not one of them can record something the
//   user said about themselves. A preference stated in chat lives only in that
//   conversation's message history and dies with it: open a new conversation
//   and Cello is blind again, so the user re-states "Series A+ only, no big
//   tech" every single time and watches it be re-derived, sometimes wrongly.
//
// WHY NOT JUST USE `targeting`
//   profiles.preferences.targeting already holds the machine-filterable facets
//   — functions, seniority, countries, languages, remoteOnly, excluded
//   companies and keywords. Those are SQL predicates; they belong there and
//   this module does not duplicate them.
//
//   But the preferences people actually state are mostly not SQL. "Series A+
//   startups, not MANGOS." "Nothing that requires relocating before March."
//   "I'd take a pay cut for equity at something early." None of that is a
//   column, and forcing it into one would either lose the meaning or grow the
//   schema forever. These are judgement inputs for the model, so they are
//   stored as sentences and injected into the system prompt — the same way a
//   good recruiter remembers what you said rather than filling in a form.
//
//   The two compose: targeting narrows the corpus mechanically, standing
//   preferences shape the judgement applied to what survives.
//
// Framework-free on purpose: this runs in request handlers and in the harness.

/** A single durable preference, as the user expressed it. */
export interface StandingPreference {
  /** The preference as a short statement, in the user's own terms. */
  text: string
  /** ISO timestamp of when it was recorded. */
  recordedAt: string
}

/**
 * Cap on how many preferences we keep.
 *
 * These are injected into every planning call, so they are a permanent tax on
 * the context window and on the model's attention. Twelve is enough to hold a
 * real set of standing constraints and few enough that the model reads them
 * all rather than skimming. Past the cap the OLDEST is dropped: a preference
 * someone stated ten conversations ago and never repeated is the one least
 * likely to still be true.
 */
export const MAX_STANDING_PREFERENCES = 12

/** Longest single preference we will store. Past this it is a paragraph, not a
 *  preference, and it crowds out the others. */
export const MAX_PREFERENCE_LENGTH = 200

/** Normalise for duplicate detection: case- and punctuation-insensitive, so
 *  "Series A+ only" and "series a+ only." are recognised as the same thing
 *  rather than accumulating as two. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Read the stored list out of a profiles.preferences blob, defensively. */
export function readStandingPreferences(preferences: unknown): StandingPreference[] {
  const prefs = (preferences ?? {}) as Record<string, unknown>
  const raw = prefs.standingPreferences
  if (!Array.isArray(raw)) return []

  const out: StandingPreference[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const text = typeof e.text === 'string' ? e.text.trim() : ''
    if (!text) continue
    const key = dedupeKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      text: text.slice(0, MAX_PREFERENCE_LENGTH),
      recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : new Date(0).toISOString(),
    })
  }
  return out.slice(-MAX_STANDING_PREFERENCES)
}

export class PreferenceError extends Error {}

/**
 * Add one preference to the list, returning the NEW list.
 *
 * Re-stating something already recorded refreshes its timestamp and moves it to
 * the end rather than adding a second copy — a user repeating themselves is
 * emphasis, not a new fact, and duplicates would eat the cap.
 */
export function addStandingPreference(
  existing: StandingPreference[],
  text: string,
  now = new Date()
): StandingPreference[] {
  const trimmed = text.trim()
  if (!trimmed) throw new PreferenceError('A preference needs some text.')
  if (trimmed.length > MAX_PREFERENCE_LENGTH) {
    throw new PreferenceError(
      `Keep a preference under ${MAX_PREFERENCE_LENGTH} characters — this one is ${trimmed.length}. Split it or state it more briefly.`
    )
  }

  const key = dedupeKey(trimmed)
  const kept = existing.filter((p) => dedupeKey(p.text) !== key)
  kept.push({ text: trimmed, recordedAt: now.toISOString() })
  // Drop from the FRONT when over cap — oldest first.
  return kept.slice(-MAX_STANDING_PREFERENCES)
}

/** Remove a preference by its exact text (case/punctuation-insensitive). */
export function removeStandingPreference(
  existing: StandingPreference[],
  text: string
): StandingPreference[] {
  const key = dedupeKey(text)
  return existing.filter((p) => dedupeKey(p.text) !== key)
}

/**
 * Render the list for a system prompt.
 *
 * Returns '' for an empty list so the caller can concatenate unconditionally
 * without emitting a dangling header — an empty "What this user has told you"
 * section reads as "they have told you nothing", which is a claim, not an
 * absence.
 *
 * The framing matters: these are stated preferences, not inferences, and the
 * model must not treat them as permission to skip asking about something
 * genuinely new. It also must not silently violate one — quietly ignoring a
 * stated preference is exactly the behaviour that made the user restate it.
 */
export function formatStandingPreferences(prefs: StandingPreference[]): string {
  if (prefs.length === 0) return ''
  const lines = prefs.map((p) => `- ${p.text}`).join('\n')
  return (
    `WHAT THIS USER HAS TOLD YOU THEY WANT (stated by them, in earlier conversations — ` +
    `honour these without being asked again):\n${lines}\n` +
    `If a request conflicts with one of these, say so and ask which wins — never quietly ignore one.`
  )
}
