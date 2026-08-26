// Shared "HTML posting body -> the plain text the matcher and classifier read"
// step. Greenhouse pioneered this (see ./greenhouse.ts), and five more boards
// now need exactly the same thing: SmartRecruiters, Workable, Recruitee,
// Personio and Workday all hand back employer-authored HTML in their public
// JSON/XML. One module so there is one answer to "what does a description
// look like once Cello has it", instead of six slightly different ones.
//
// Framework-free (see ./types.ts): `html-to-text` and lib/jobs/mojibake are
// both plain JS with no next/* or Node-only imports.

import { htmlToText } from 'html-to-text'
// Relative import, not `@/...`: lib/ats/* stays framework-free and
// lib/jobs/mojibake.ts is itself pure and dependency-free — the same
// reasoning ./index.ts documents for importing it there.
import { repairMojibake } from '../jobs/mojibake'

/**
 * Cap stored description length, matching ./lever.ts and ./ashby.ts. Long
 * enough that no real posting body is truncated mid-content; short enough that
 * one pathological board cannot blow up a batch insert.
 */
export const MAX_DESCRIPTION_CHARS = 20_000

// `html-to-text` handles script/style removal and block-vs-inline layout
// correctly on its own — the only overrides needed are the ones that change
// what content ends up in the text: link hrefs and image src/alt are dropped
// (a job description shouldn't read as "Apply here [https://...]"), and
// heading case is left as-authored instead of the default all-caps
// ("BENEFITS") to match what a human reading the original posting would see.
// Lifted verbatim out of ./greenhouse.ts, which is why its tests still pass
// unchanged after that file started calling in here.
const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
}

/**
 * Parse an HTML posting body to plain text, repair any upstream mis-decode,
 * trim and cap. Returns undefined for anything that isn't usable text.
 *
 * WHY THE MOJIBAKE REPAIR IS HERE and not only at refreshCompany()'s central
 * choke point (./index.ts repairJobText): these five boards re-serve HTML that
 * employers pasted in from elsewhere, so a UTF-8-as-Latin-1 mis-decode can
 * arrive already baked into the payload — the exact failure a user reported.
 * The central repair still runs and still covers title/location/salary, but it
 * is not the only caller of provider.fetch(): lib/search/job-discovery.ts
 * fetches boards directly and never passes through refreshCompany. Repairing
 * at the point the text is produced means every consumer sees the same text.
 * repairMojibake() is idempotent and returns clean text unchanged by identity,
 * so doing it twice costs one scan and changes nothing.
 */
export function htmlToPlainText(raw: unknown, maxChars: number = MAX_DESCRIPTION_CHARS): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  let text: string
  try {
    text = htmlToText(raw, HTML_TO_TEXT_OPTIONS)
  } catch {
    // A malformed body should degrade to no description rather than throw and
    // lose the whole board.
    return undefined
  }
  const repaired = repairMojibake(text).trim()
  return repaired ? repaired.slice(0, maxChars) : undefined
}

/**
 * Join several HTML fragments into one description. SmartRecruiters splits a
 * posting across `jobAd.sections` (company description / job description /
 * qualifications / additional information) and Recruitee across
 * `description` + `requirements`; concatenating before the HTML parse would
 * risk one unclosed tag in an early section swallowing the later ones, so each
 * fragment is converted independently and the results are joined.
 */
export function htmlSectionsToPlainText(
  fragments: readonly unknown[],
  maxChars: number = MAX_DESCRIPTION_CHARS
): string | undefined {
  const parts: string[] = []
  for (const fragment of fragments) {
    const text = htmlToPlainText(fragment, maxChars)
    if (text) parts.push(text)
  }
  if (parts.length === 0) return undefined
  return parts.join('\n\n').slice(0, maxChars)
}
