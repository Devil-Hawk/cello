// Pure, deterministic ranking of job titles against the SET of titles the user
// said they want. No LLM, no network, no DB — same inputs always produce the
// same order.
//
// WHY THIS EXISTS, AND WHY IT IS NOT lib/jobs/relevance.ts
//   relevance.ts answers "does this job match ONE free-text query" for the
//   copilot's score_jobs tool. That is a different question from the one the
//   jobs list asks, in two ways that matter:
//
//   1. ARBITRARY TARGET COUNT. The user configures N desired titles ("multiple
//      and any number"). A job is as good as its BEST target, not its average
//      one — "Data Engineer" should not be punished for failing to also look
//      like "Product Manager". relevance.ts has no notion of a target set.
//
//   2. SENIORITY IS NOISE HERE, NOT SIGNAL. Under relevance.ts every non-
//      stopword term carries full weight, so a target of "Senior Data
//      Scientist" scores a real "Data Scientist" posting at ~55 — a 45-point
//      penalty for a word the user does not actually want to filter on. In a
//      ranked list that is the difference between the right job being first
//      and being tenth.
//
//   Both modules deliberately share the same discipline: match on whole
//   normalized WORDS, never raw substrings. This codebase has a documented
//   history of substring bugs for short tech terms ('%ai%' matches "detail",
//   "email", "chair"), and tokenizing first makes that bug class impossible.

/** Minimal job shape this module needs — callers map their own row shape in. */
export interface TitleRankJob {
  title: string | null | undefined
}

export interface TitleMatch {
  /**
   * 0 = this title matched none of the user's targets and must NOT be treated
   * as ranked at all. Otherwise 1-100.
   */
  score: number
  /**
   * The configured target title (as the user wrote it) that produced `score`,
   * or null when nothing matched. This is what the UI shows to explain WHY a
   * job sits where it does — a rank with no visible reason is just a shuffle.
   */
  target: string | null
  /** Words from the target that appear in the job title, for display. */
  matchedWords: string[]
}

/** No match at all. Frozen: returned from several paths, never mutated. */
const NO_MATCH: TitleMatch = Object.freeze({ score: 0, target: null, matchedWords: [] })

// ---------------------------------------------------------------------------
// Normalization
//
// Same spirit as lib/jobs/classify.ts's fold/normalizeText and relevance.ts's
// copy of it — duplicated rather than imported for the same reason those two
// duplicate each other: they are two-line string helpers and neither module
// wants a dependency on the other's much larger surface.
//
// Collapsing every non-alphanumeric run to a space is what makes this
// "tolerant of separators" for free: "Sr. Software Engineer (Backend)",
// "Software Engineer - Backend", "Software Engineer / Backend" and
// "Software Engineer, Backend" all tokenize identically.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .replace(/\u00df/g, 'ss') // eszett
    .toLowerCase()
}

function normalizeText(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Phrase canonicalization — applied to BOTH the target and the job title, so
// it can never favour one side. Only spelled-out forms whose abbreviation is a
// genuinely atomic industry term are listed: an "ML Engineer" posting and a
// "Machine Learning Engineer" posting are the same job to a job seeker, and a
// user who typed one should not miss the other.
//
// Deliberately tiny and high-confidence. Note what is NOT here: "software
// engineer" -> "swe". Collapsing that would destroy the "software" token, so a
// target of "Software Engineer" would stop matching "Software Developer"
// entirely — a regression, not a synonym.
// ---------------------------------------------------------------------------

const PHRASE_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/\bartificial intelligence\b/g, 'ai'],
  [/\bmachine learning\b/g, 'ml'],
  [/\bdeep learning\b/g, 'ml'],
  [/\bnatural language processing\b/g, 'nlp'],
  [/\blarge language models?\b/g, 'llm'],
  [/\bsite reliability\b/g, 'sre'],
]

/** Single-word abbreviations, expanded to the same canonical form on both
 *  sides. "Sr." and "Senior" must not read as two different words. */
const WORD_ALIASES: Readonly<Record<string, string>> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  jnr: 'junior',
  mgr: 'manager',
  eng: 'engineer',
  dev: 'developer',
  ops: 'operations',
}

// ---------------------------------------------------------------------------
// Seniority / level words.
//
// These are the words the user is NOT really choosing a job by. Someone who
// targets "Data Scientist" wants the senior one, the staff one and the plain
// one; someone who targets "Senior Data Scientist" has not stopped wanting a
// "Data Scientist" posting. So these carry a token weight of 1 against a core
// word's 10 — present enough to break a tie in favour of the exact level,
// far too small to outrank an actual role-word difference.
//
// WHAT IS DELIBERATELY ABSENT: director, head, chief, vp, president, lead-of.
// Those read as seniority but ARE the role in an exec title. Down-weighting
// "head" would score a "Data Analyst" posting ~87 against a target of "Head of
// Data", which is a different job, not a different level. Keeping them as core
// words is what stops that.
// ---------------------------------------------------------------------------

const SENIORITY_WORDS = new Set([
  'senior', 'junior', 'staff', 'principal', 'lead', 'entry', 'mid', 'midlevel',
  'intermediate', 'associate', 'apprentice', 'trainee', 'intern', 'internship',
  'graduate', 'grad', 'experienced', 'level',
  // Roman numerals and digits as level suffixes: "Engineer II", "Engineer 2".
  'i', 'ii', 'iii', 'iv', 'v', '1', '2', '3', '4', '5',
])

/** Grammatical filler, dropped entirely (weight 0) rather than down-weighted —
 *  "Head of Data" and "Head Data" must score identically. */
const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'at', 'on', 'with'])

const CORE_WEIGHT = 10
const SENIORITY_WEIGHT = 1

// ---------------------------------------------------------------------------
// Stemming — a deliberately small, symmetric suffix stripper so that
// "Engineering" matches "Engineer", "Development" matches "Developer", and
// "Designer" matches "Design". Applied to both sides, so it can only ever make
// the comparison more forgiving, never asymmetrically wrong.
//
// It is NOT a real stemmer (Porter et al.) on purpose: a full stemmer is a
// dependency and a large behaviour surface for a job-title matcher whose whole
// vocabulary is a few hundred role nouns. The MIN_STEM guard is what keeps it
// safe — "ios" never becomes "io", "ai"/"ml"/"ops" are never touched.
// ---------------------------------------------------------------------------

const MIN_STEM = 4
const SUFFIXES = ['ings', 'ing', 'ers', 'er', 'ments', 'ment', 'ions', 'ion', 's'] as const

function stem(word: string): string {
  let out = word
  // Iterate to a fixpoint (bounded) so "engineering" -> "engineer" -> "engine"
  // lands on the same stem as "engineer" -> "engine". A single pass would
  // leave them different, which is the whole point of stemming here.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const suffix of SUFFIXES) {
      if (out.length - suffix.length >= MIN_STEM && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length)
        changed = true
        break
      }
    }
    if (!changed) break
  }
  // Drop a trailing silent 'e' so "manage" (from "management") and "manag"
  // (from "manager") converge. Same MIN_STEM floor.
  if (out.length - 1 >= MIN_STEM && out.endsWith('e')) out = out.slice(0, -1)
  return out
}

interface TitleWord {
  /** The word as it reads after alias expansion, for display. */
  display: string
  stem: string
  weight: number
}

export interface ParsedTitle {
  /** The original string, kept for display — this is what the UI shows. */
  raw: string
  /** Deduped by stem, in first-seen order. */
  words: TitleWord[]
  /** Count of distinct CORE (non-seniority) stems. Drives the focus term. */
  coreCount: number
}

/** Parse a title (target or job) into weighted, deduped, stemmed words. */
export function parseTitle(raw: string | null | undefined): ParsedTitle {
  const text = typeof raw === 'string' ? raw : ''
  let normalized = normalizeText(text)
  for (const [pattern, canonical] of PHRASE_ALIASES) {
    // Reset lastIndex: these are module-level /g regexes reused across calls,
    // and a stale lastIndex would make matching depend on call order.
    pattern.lastIndex = 0
    normalized = normalized.replace(pattern, canonical)
  }

  const words: TitleWord[] = []
  const seen = new Set<string>()
  let coreCount = 0

  for (const rawWord of normalized ? normalized.split(' ') : []) {
    const word = WORD_ALIASES[rawWord] ?? rawWord
    if (!word || TITLE_STOPWORDS.has(word)) continue
    const isSeniority = SENIORITY_WORDS.has(word)
    const key = stem(word)
    if (seen.has(key)) continue
    seen.add(key)
    words.push({ display: word, stem: key, weight: isSeniority ? SENIORITY_WEIGHT : CORE_WEIGHT })
    if (!isSeniority) coreCount++
  }

  return { raw: text, words, coreCount }
}

/**
 * How much of the score comes from COVERAGE (did this job contain what I asked
 * for) vs FOCUS (is the job title mostly about that, or is my target one of
 * six things it mentions).
 *
 * Coverage dominates on purpose. Focus exists only to break ties sensibly:
 * with a target of "Data Scientist", a posting literally titled "Data
 * Scientist" should edge out "Data Scientist, Trust & Safety Platform
 * Operations" — but both are clearly the job, so the gap stays small.
 */
const COVERAGE_SHARE = 0.85
const FOCUS_SHARE = 0.15

/**
 * Score one job title against ONE target title. 0-100.
 *
 * Returns 0 unless at least one CORE word matches. This rule is load-bearing:
 * without it, a target of "Senior Data Scientist" would give "Senior Marketing
 * Manager" a non-zero score purely for the word "senior", and a level word on
 * its own is not a reason to surface an unrelated job.
 */
export function scoreTitleAgainstTarget(
  jobTitle: string | null | undefined,
  target: string | ParsedTitle
): TitleMatch {
  const parsedTarget = typeof target === 'string' ? parseTitle(target) : target
  if (parsedTarget.coreCount === 0) return NO_MATCH

  const job = parseTitle(jobTitle)
  if (job.coreCount === 0) return NO_MATCH

  const jobStems = new Set(job.words.map((w) => w.stem))

  let targetWeight = 0
  let matchedWeight = 0
  let matchedCore = 0
  const matchedWords: string[] = []

  for (const word of parsedTarget.words) {
    targetWeight += word.weight
    if (!jobStems.has(word.stem)) continue
    matchedWeight += word.weight
    matchedWords.push(word.display)
    if (word.weight === CORE_WEIGHT) matchedCore++
  }

  if (matchedCore === 0) return NO_MATCH

  const coverage = matchedWeight / targetWeight
  const focus = matchedCore / job.coreCount
  const score = Math.round((COVERAGE_SHARE * coverage + FOCUS_SHARE * focus) * 100)

  // A real core match can never round to 0 — that value means "unmatched" to
  // every caller, and silently collapsing a hit into it would be a lie.
  return { score: Math.max(1, Math.min(100, score)), target: parsedTarget.raw, matchedWords }
}

/**
 * Score one job title against the WHOLE target set, taking its best target.
 *
 * A job is as good as the target it fits best — averaging across targets would
 * punish "Data Engineer" for not also resembling "Product Manager", which is
 * the opposite of what a multi-target list means. Ties resolve to the
 * earliest-configured target so the reported reason is stable.
 *
 * An empty (or all-junk) target list returns score 0 for everything, which is
 * how the caller falls back to its existing ordering.
 */
export function scoreTitleAgainstTargets(
  jobTitle: string | null | undefined,
  targets: readonly (string | ParsedTitle)[]
): TitleMatch {
  let best: TitleMatch = NO_MATCH
  for (const target of targets) {
    const match = scoreTitleAgainstTarget(jobTitle, target)
    if (match.score > best.score) best = match
  }
  return best
}

export interface TitleRankedJob<T> {
  job: T
  titleMatch: TitleMatch
}

/**
 * Re-rank jobs by best target-title match, highest first.
 *
 * STABLE FOR TIES AND FOR NO-MATCH. Equal scores keep their incoming relative
 * order, and an empty target set scores everything 0 so the input order comes
 * back untouched. That is what lets this compose with whatever sort the caller
 * already applied instead of replacing it: a user with no titles configured
 * sees exactly the list they saw before, and within a group of equally
 * on-target jobs the caller's sort still decides.
 *
 * Jobs scoring 0 are kept (at the end), never dropped — this ranks, it does
 * not filter. Hiding rows because they missed a title the user typed once
 * would silently shrink a list they did not ask to shrink.
 */
export function rankJobsByTargetTitles<T extends TitleRankJob>(
  jobs: readonly T[],
  targets: readonly string[]
): TitleRankedJob<T>[] {
  // Parse each target ONCE, not once per job: this runs on every render of a
  // list that can hold hundreds of rows.
  const parsed = targets.map(parseTitle).filter((t) => t.coreCount > 0)

  return jobs
    .map((job, index) => ({ job, titleMatch: scoreTitleAgainstTargets(job.title, parsed), index }))
    .sort((a, b) => b.titleMatch.score - a.titleMatch.score || a.index - b.index)
    .map(({ job, titleMatch }) => ({ job, titleMatch }))
}
