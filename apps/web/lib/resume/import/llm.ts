// Faithfulness checks for model output: did the model reformat the text, or
// write a different resume?
//
// WHAT THIS IS FOR NOW
//   The model's job is structuring (lib/resume/import/structure.ts), and its
//   output is checked here before it is allowed anywhere near the user's
//   resume. findInventedFacts() is the check that matters, and it is also what
//   the tailoring guards (lib/resume/tailor.ts) use.
//
// THE CHECK IS THE POINT
//   A prompt is a request, not a guarantee. checkReformatFaithfulness() runs
//   two independent tests, because they fail in opposite directions:
//     - CONTAINMENT (findInventedFacts) catches the small, targeted lie. Every
//       proper noun and figure in the output must already exist in the source.
//       An earlier version compared only word-set RATIOS, which divide by the
//       output's vocabulary and therefore score one invented employer in a
//       400-word resume at ~0.5%, invisible at any threshold.
//     - RATIOS still catch the bulk rewrite, which containment alone would
//       miss if a model paraphrased using only words already present.
//   Both are order-insensitive, so a different reading order passes and
//   invented content does not.

export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return (fenced ? fenced[1] : trimmed).trim()
}

/** Words of 2+ alphanumerics, lowercased. Markdown syntax contributes none. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9'+#.]*/g) ?? []) {
    const cleaned = token.replace(/[.']+$/, '')
    if (cleaned.length >= 2) out.add(cleaned)
  }
  return out
}

export interface FaithfulnessReport {
  ok: boolean
  /** Share of the source's distinct words that survived. 1 = all of them. */
  retention: number
  /** Share of the output's distinct words that are not in the source. */
  novelty: number
  /**
   * Hard facts — proper nouns, years, figures — that appear in the output but
   * nowhere in the source. THIS is the check that catches fabrication; the
   * ratios above cannot (see findInventedFacts). Empty when nothing was made up.
   */
  invented: string[]
  /** Human-readable reason when `ok` is false; null when it passed. */
  reason: string | null
}

/**
 * At least this share of the source's distinct words must survive. A faithful
 * reformat scores ~1.0; the slack is for hyphen/ligature repairs and dropped
 * page furniture.
 */
export const MIN_RETENTION = 0.85
/**
 * Share of the source's distinct words found in `output`, or null when the
 * source is too short to judge. The dropped-content check for structured output.
 */
export function wordRetention(source: string, output: string): number | null {
  const sourceWords = tokenize(source)
  if (sourceWords.size < MIN_TOKENS_TO_JUDGE) return null
  const outputWords = tokenize(output)
  let kept = 0
  for (const word of sourceWords) if (outputWords.has(word)) kept++
  return kept / sourceWords.size
}

/**
 * At most this share of the output's distinct words may be new. Rejoining
 * "expe rience" legitimately creates a token, so this cannot be zero — but a
 * model that rewrote the bullets blows straight past it.
 */
const MAX_NOVELTY = 0.2
/** Below this many distinct source words the ratios are noise; skip the check. */
const MIN_TOKENS_TO_JUDGE = 25

/** Case/punctuation-insensitive form used for containment tests. Collapsing to
 *  bare alphanumerics is what lets a legitimate OCR repair pass: a source
 *  reading "Expe rience" contains "experience" once despaced, so rejoining a
 *  split word is not mistaken for invention. */
function despace(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * A capitalised token (employer, school, product, job title), a figure (year,
 * percentage, metric), or a spelled-out quantity. These are the atoms a lie is
 * made of: you cannot invent a job without naming an employer, a date, or a
 * title, and you cannot inflate a team without naming a number.
 *
 * The number WORDS are the third alternative, and they are here because a
 * regex of capitals and digits is blind to the entire spelled-out class: an
 * eval case with a source reading "a team of three engineers" and an output
 * claiming "a team of twelve" produced no finding at all. "twelve" is neither
 * capitalised nor a digit run, so nothing matched and the inflation passed.
 * The list is bounded on purpose — these compose ("twenty five") and the scan
 * checks each token independently, so covering the atoms covers the compounds.
 */
const HARD_FACT_RE = /[A-Z][A-Za-z0-9&.'’-]{2,}|\d[\d,.]*%?/g

/**
 * Spelled-out quantities, scanned SEPARATELY and case-insensitively.
 *
 * Two regexes rather than one alternation, because JavaScript has no
 * per-alternative flag: adding `i` to the combined pattern to catch a
 * lowercase "twelve" also made `[A-Z][A-Za-z0-9&.'’-]{2,}` case-insensitive,
 * so every lowercase word of three or more characters became a "hard fact".
 * The eval caught it immediately — a legitimately reworded bullet ("across the
 * whole payments path, end to end") flagged "whole" and "end" as inventions.
 * Precision on real facts is the property this guard cannot trade away, so the
 * capitalisation rule stays exact and number words get their own pass.
 *
 * Bounded on purpose: these compose ("twenty five") and each token is checked
 * independently, so covering the atoms covers the compounds.
 */
const NUMBER_WORD_RE =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)\b/gi

/**
 * Section names RESUME_MARKDOWN_PROMPT explicitly invites the model to add, so
 * their appearance in a heading is structure rather than invention.
 *
 * Narrow by design. The prompt tells the model to "use the section names the
 * resume already uses", so a heading word outside this set which is also absent
 * from the source means the model departed from that instruction — worth
 * flagging even in the benign case.
 */
const INVITED_HEADING_WORDS = new Set(
  [
    'summary',
    'experience',
    'education',
    'skills',
    'projects',
    'certifications',
    'work',
    'professional',
    'technical',
    'employment',
    'contact',
    'profile',
  ].map((w) => w)
)

/**
 * Strip the Markdown we ASKED the model to add — list markers, emphasis runs,
 * link syntax, and heading MARKERS.
 *
 * The markers, not the heading LINES. This previously dropped every heading
 * line wholesale, on the reasoning that headings are structure we requested.
 * That reasoning holds for `## Experience` and fails completely for
 * `### Initech LLC — Principal Architect — 2013-2016`: an eval case placing a
 * wholly fabricated job on a heading line returned no findings, because the
 * line was discarded before the scan ever saw it. Structure was being used as
 * a hiding place. Heading TEXT is now scanned like any other prose;
 * INVITED_HEADING_WORDS above keeps the genuinely structural vocabulary from
 * reading as invention.
 */
function bodyProse(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
    )
    .join('\n')
}

/**
 * Hard facts asserted by the output that appear nowhere in the source.
 *
 * WHY THIS EXISTS, and why the ratio checks below are not enough: novelty is
 * measured against the OUTPUT's vocabulary, so a single invented employer in a
 * 400-word resume scores ~0.005 — indistinguishable from noise. Measured
 * against real attacks, the ratios passed a wholly fabricated third job
 * (retention 1.000, novelty 0.055), a Master's degree swapped in for a
 * Bachelor's (0.992/0.017), an employer renamed to Google (0.992/0.008), a
 * title inflated to Director (0.992/0.017) and a metric moved from 62% to 92%
 * (0.992/0.008). Every one of those is a firing-offence lie on a resume, and
 * every one of them is a rounding error to a ratio. Containment is not: each
 * of those lies must introduce a proper noun or a figure that the source never
 * contained, and that is exactly what this returns.
 *
 * Deliberately biased toward false POSITIVES. A wrongly-flagged reformat costs
 * the user the deterministic layout instead of the model's; a missed
 * fabrication costs them the job.
 */
export function findInventedFacts(source: string, output: string): string[] {
  const haystack = despace(source)
  const seen = new Set<string>()
  const invented: string[] = []

  const prose = bodyProse(output)
  // Both scans feed one dedupe/containment pass below — see NUMBER_WORD_RE for
  // why they cannot be a single regex.
  const matches = [...prose.matchAll(HARD_FACT_RE), ...prose.matchAll(NUMBER_WORD_RE)]

  for (const match of matches) {
    const raw = match[0]
    const norm = despace(raw)
    // Single characters and bare digits are noise (list numbers, initials).
    if (norm.length < 2) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    // Section vocabulary the prompt invited. Skipped so restructuring a resume
    // into the requested headings does not read as invention — see
    // INVITED_HEADING_WORDS for why the set is deliberately small.
    if (INVITED_HEADING_WORDS.has(norm)) continue
    if (!haystack.includes(norm)) invented.push(raw)
  }
  return invented
}

/**
 * Did the model reformat the resume, or write a different one?
 *
 * Two independent tests, because they fail in opposite directions:
 *   1. Containment (findInventedFacts) — catches SMALL, TARGETED lies: an
 *      invented employer, a moved date, an inflated title. This is the one
 *      that matters.
 *   2. Word-set ratios — catch BULK rewrites and wholesale replacement, which
 *      containment alone would let through if the model paraphrased using only
 *      words already present.
 *
 * Reordering still passes both, so a vision model reading a two-column layout
 * out of order is not punished for it.
 */
export function checkReformatFaithfulness(source: string, output: string): FaithfulnessReport {
  const sourceWords = tokenize(source)
  const outputWords = tokenize(output)

  if (outputWords.size === 0) {
    return { ok: false, retention: 0, novelty: 0, invented: [], reason: 'the model returned no text' }
  }

  // Containment runs FIRST and regardless of length. A short resume is exactly
  // where the ratios are weakest, so skipping the fabrication check on it would
  // leave the most exposed case unguarded.
  const invented = findInventedFacts(source, output)
  if (invented.length > 0) {
    const shown = invented.slice(0, 3).join(', ')
    return {
      ok: false,
      retention: 0,
      novelty: 0,
      invented,
      reason: `it introduced details that are not in your document (${shown}${
        invented.length > 3 ? `, +${invented.length - 3} more` : ''
      })`,
    }
  }

  if (sourceWords.size < MIN_TOKENS_TO_JUDGE) {
    // Too little text for the ratios to mean anything — but containment above
    // already ran, so this is not an unguarded pass.
    return { ok: true, retention: 1, novelty: 0, invented: [], reason: null }
  }

  let kept = 0
  for (const word of sourceWords) if (outputWords.has(word)) kept++
  let added = 0
  for (const word of outputWords) if (!sourceWords.has(word)) added++

  const retention = kept / sourceWords.size
  const novelty = added / outputWords.size

  if (retention < MIN_RETENTION) {
    return {
      ok: false,
      retention,
      novelty,
      invented: [],
      reason: `only ${Math.round(retention * 100)}% of the original wording survived (needs ${Math.round(
        MIN_RETENTION * 100
      )}%)`,
    }
  }
  if (novelty > MAX_NOVELTY) {
    return {
      ok: false,
      retention,
      novelty,
      invented: [],
      reason: `${Math.round(novelty * 100)}% of the words were not in the original (allows ${Math.round(
        MAX_NOVELTY * 100
      )}%)`,
    }
  }
  return { ok: true, retention, novelty, invented: [], reason: null }
}
