// Pure text-matching helpers used to avoid mis-attaching an application to
// the wrong company or the wrong job (the "arbitrary job attachment" bug).

const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'in', 'at', 'on', 'with',
  'remote', 'hybrid', 'onsite', 'sr', 'senior', 'jr', 'junior', 'ii', 'iii',
  'iv', 'i', 'lead', 'staff', 'principal', 'new', 'role', 'position',
])

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'ag', 'sa', 'plc', 'llp', 'lp', 'pllc', 'group',
  'holdings', 'technologies', 'labs',
])

/** Lowercase, strip diacritics/punctuation, collapse whitespace. */
function normalizeAscii(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenize(s: string, stopwords: Set<string>): Set<string> {
  return new Set(
    normalizeAscii(s)
      .split(/\s+/)
      .filter((t) => t.length > 0 && !stopwords.has(t))
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** For matching a tracked company by name once domain matching has failed. */
export function normalizeCompanyName(name: string): string {
  const tokens = normalizeAscii(name)
    .split(/\s+/)
    .filter((t) => t.length > 0 && !COMPANY_SUFFIXES.has(t))
  return tokens.join(' ')
}

export const JOB_TITLE_MATCH_THRESHOLD = 0.34

export interface JobMatchCandidate {
  id: string
  title: string
}

export interface JobMatch extends JobMatchCandidate {
  score: number
}

/**
 * Find the best-matching job at a company for a parsed email's job title
 * using token-overlap (Jaccard) similarity. Returns null when nothing clears
 * the confidence threshold — callers must NOT fall back to "just pick one".
 */
export function findBestJobMatch(
  emailJobTitle: string | null,
  candidates: JobMatchCandidate[]
): JobMatch | null {
  if (!emailJobTitle || candidates.length === 0) return null

  const targetTokens = tokenize(emailJobTitle, TITLE_STOPWORDS)
  if (targetTokens.size === 0) return null

  let best: JobMatch | null = null
  for (const candidate of candidates) {
    const score = jaccardSimilarity(targetTokens, tokenize(candidate.title, TITLE_STOPWORDS))
    if (!best || score > best.score) {
      best = { id: candidate.id, title: candidate.title, score }
    }
  }

  if (best && best.score >= JOB_TITLE_MATCH_THRESHOLD) return best
  return null
}
