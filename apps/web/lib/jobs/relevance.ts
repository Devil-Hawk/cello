// Pure, deterministic job-relevance matching against a free-text query — no
// LLM, no network, no DB. Exists because the copilot's score_jobs tool used to
// have no way to pick WHICH unscored jobs a request like "score the AI
// Engineer roles" was actually about, so it fell back to oldest-unscored-first
// and silently scored whatever that happened to be — see copilot-tools.ts's
// score_jobs for the caller.
//
// Every match here is on a whole, tokenized WORD (or an explicit multi-word
// phrase), never a raw substring. This codebase has a documented history of
// substring bugs for exactly this kind of short tech term: an ILIKE '%ai%'
// query matches "detail", "email", "chair"; '%go%' matches "Google", "Diego",
// "algorithm", "Chicago". Tokenizing first makes that whole bug class
// impossible — "ai" can only match the standalone word "ai", never a
// substring of a longer word.

/** Minimal job shape this module needs — callers map their own row shape in. */
export interface RelevanceJob {
  title: string | null | undefined
  description?: string | null
}

/** One query "concept" after synonym expansion: any of `tokens` matching a
 *  single word, OR any of `phrases` matching a contiguous run of words,
 *  counts as this concept being present. */
interface QueryConcept {
  /** The term as the user/model wrote it, kept for display/debugging. */
  display: string
  tokens: string[]
  phrases: string[]
  /** True for a generic occupation/role noun ("engineer", "manager", ...) —
   *  see GENERIC_ROLE_TERMS. Weighted far below a domain-specific term so a
   *  query like "AI Engineer" doesn't let the word "Engineer" alone drag an
   *  unrelated "Principal Software Engineer" up to the same score as a real
   *  AI/ML posting. */
  generic: boolean
  /** Other AI/ML-family synonym-group forms (see AI_FAMILY_GROUP_KEYS) this
   *  concept can also get reduced-weight credit for — e.g. the "ai" concept
   *  crediting a title that only says "Machine Learning". Empty for concepts
   *  outside that family. */
  familyTokens: string[]
  familyPhrases: string[]
}

export interface RelevanceQuery {
  /** The original text, kept for display/debugging. */
  raw: string
  /** Deduped concepts after stopword removal + synonym expansion. Empty when
   *  the query was empty or every word in it was a stopword. */
  concepts: QueryConcept[]
}

export interface RelevanceMatch {
  /** 0 when nothing in the query matched this job at all. Otherwise 1-100;
   *  a title hit on a concept counts for far more than a description-only
   *  hit, so any title match outranks any description-only match. */
  score: number
  /** Query concepts (display form) that matched in the title. */
  titleHits: string[]
  /** Query concepts (display form) that matched only in the description. */
  descriptionHits: string[]
}

// ---------------------------------------------------------------------------
// Normalization (same spirit as lib/jobs/classify.ts's fold/normalizeText —
// duplicated, not imported: classify.ts is intentionally dependency-free and
// this module has no reason to couple to it for two small string helpers).
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

function tokenize(s: string): string[] {
  const n = normalizeText(s)
  return n ? n.split(' ') : []
}

// ---------------------------------------------------------------------------
// Query-only stopwords — filler words dropped when extracting search TERMS
// from a free-text ask ("the latest AI Engineer roles" -> ["ai","engineer"]).
// This is NOT applied to job title/description text, which is matched as-is.
// ---------------------------------------------------------------------------

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'in', 'at', 'to', 'and', 'or', 'with', 'on',
  'latest', 'new', 'newest', 'recent', 'fresh',
  'open', 'opening', 'openings',
  'role', 'roles', 'position', 'positions', 'job', 'jobs', 'posting', 'postings',
  'listing', 'listings', 'opportunity', 'opportunities',
  'please', 'looking', 'find', 'search', 'me', 'my', 'show', 'list', 'get',
  'want', 'all', 'any', 'some', 'that', 'those', 'these', 'this',
])

// ---------------------------------------------------------------------------
// Synonym groups — a query term written as an abbreviation matches the spelled
// -out form in a posting and vice versa ("AI Engineer" should match a posting
// that only ever says "Artificial Intelligence"). Deliberately small and
// high-confidence: every group is a standard, unambiguous tech-industry
// abbreviation, not a guess.
// ---------------------------------------------------------------------------

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['ai', 'artificial intelligence'],
  ['ml', 'machine learning'],
  ['genai', 'generative ai', 'gen ai'],
  ['llm', 'llms', 'large language model', 'large language models'],
  ['nlp', 'natural language processing'],
  ['mlops', 'ml ops'],
  ['sre', 'site reliability engineer', 'site reliability'],
  ['swe', 'software engineer', 'software engineering'],
  ['devops', 'dev ops'],
]

interface SynonymIndex {
  /** single-word form -> group index */
  tokenGroups: Map<string, number>
  /** normalized multi-word phrase -> group index */
  phraseGroups: Map<string, number>
}

function buildSynonymIndex(): SynonymIndex {
  const tokenGroups = new Map<string, number>()
  const phraseGroups = new Map<string, number>()
  SYNONYM_GROUPS.forEach((group, i) => {
    for (const form of group) {
      const norm = normalizeText(form)
      if (!norm) continue
      if (norm.includes(' ')) phraseGroups.set(norm, i)
      else tokenGroups.set(norm, i)
    }
  })
  return { tokenGroups, phraseGroups }
}

const SYNONYM_INDEX = buildSynonymIndex()

// ---------------------------------------------------------------------------
// Generic role-noun downweighting — the "AI Engineer" vs "Principal Software
// Engineer" defect. Two independent OR-matched concepts ("ai", "engineer")
// with EQUAL weight meant any job with the word "Engineer" in its title
// satisfied half the query on its own, tying a genuinely AI-relevant post
// against an unrelated generic-Engineer one (both landed on 50). "engineer"
// alone is not a discriminating signal for an AI/ML search — DB counts on
// real unscored rows: ~7,285 titles contain standalone "engineer" vs ~1,121
// "ai" (6.5x). These common occupation nouns are weighted far below a
// domain-specific term so matching ONLY the generic word never competes with
// a real domain-term match.
// ---------------------------------------------------------------------------

const GENERIC_ROLE_TERMS = new Set([
  'engineer', 'engineering', 'developer', 'programmer',
  'manager', 'specialist', 'analyst', 'scientist', 'architect',
  'lead', 'director', 'coordinator', 'associate', 'consultant',
  'administrator', 'technician', 'representative', 'executive',
])

// ---------------------------------------------------------------------------
// AI-family cross-linking — the second half of the same defect: "ai" and the
// separate "ml"/"machine learning" synonym group had NO link at all, so an
// "AI Engineer" query gave a "Senior Machine Learning Engineer" posting zero
// credit for the "ai" concept even though, to a job seeker, they are the same
// market. These synonym groups stay separate (their forms are not literal
// synonyms — "ai" != "ml"), but a query concept in this family gets reduced
// -weight FAMILY credit when a job only contains a *different* family member,
// so the score reflects "same discipline" without treating them as identical
// to an exact/same-group hit.
// ---------------------------------------------------------------------------

const AI_FAMILY_GROUP_KEYS = ['ai', 'ml', 'genai', 'llm', 'nlp', 'mlops']

function collectFamilyPool(groupIds: readonly number[]): { tokens: string[]; phrases: string[] } {
  const tokens = new Set<string>()
  const phrases = new Set<string>()
  for (const gid of groupIds) {
    const group = SYNONYM_GROUPS[gid]
    if (!group) continue
    for (const form of group) {
      const norm = normalizeText(form)
      if (!norm) continue
      if (norm.includes(' ')) phrases.add(norm)
      else tokens.add(norm)
    }
  }
  return { tokens: [...tokens], phrases: [...phrases] }
}

const AI_FAMILY_GROUP_IDS: readonly number[] = Array.from(
  new Set(
    AI_FAMILY_GROUP_KEYS.map((k) => SYNONYM_INDEX.tokenGroups.get(k)).filter((g): g is number => g !== undefined)
  )
)
const AI_FAMILY_POOL = collectFamilyPool(AI_FAMILY_GROUP_IDS)

/** All forms (single-word + phrase) belonging to term's synonym group, or just
 *  `[term]` itself when it belongs to no group. Also resolves the AI-family
 *  cross-link pool (see above) when the term's own group is a member. */
function expandTerm(term: string): { tokens: string[]; phrases: string[]; familyTokens: string[]; familyPhrases: string[] } {
  const groupId = SYNONYM_INDEX.tokenGroups.get(term)
  if (groupId === undefined) return { tokens: [term], phrases: [], familyTokens: [], familyPhrases: [] }
  const group = SYNONYM_GROUPS[groupId]
  const tokens: string[] = []
  const phrases: string[] = []
  for (const form of group) {
    const norm = normalizeText(form)
    if (!norm) continue
    if (norm.includes(' ')) phrases.push(norm)
    else tokens.push(norm)
  }
  const inFamily = AI_FAMILY_GROUP_IDS.includes(groupId)
  return {
    tokens,
    phrases,
    familyTokens: inFamily ? AI_FAMILY_POOL.tokens : [],
    familyPhrases: inFamily ? AI_FAMILY_POOL.phrases : [],
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a free-text query into matchable concepts. Pure and deterministic —
 * same input always produces the same concepts, in the same order, deduped by
 * synonym group so "AI and ML roles" doesn't double-count if they happened to
 * share a group (they don't here, but multi-word queries commonly repeat a
 * concept, e.g. "AI Engineer / Artificial Intelligence Engineer").
 */
export function parseRelevanceQuery(raw: string): RelevanceQuery {
  const text = typeof raw === 'string' ? raw : ''
  const tokens = tokenize(text).filter((t) => !QUERY_STOPWORDS.has(t))
  const seenGroups = new Set<number>()
  const concepts: QueryConcept[] = []
  for (const token of tokens) {
    const groupId = SYNONYM_INDEX.tokenGroups.get(token)
    if (groupId !== undefined) {
      if (seenGroups.has(groupId)) continue
      seenGroups.add(groupId)
    }
    const { tokens: expTokens, phrases, familyTokens, familyPhrases } = expandTerm(token)
    concepts.push({ display: token, tokens: expTokens, phrases, generic: GENERIC_ROLE_TERMS.has(token), familyTokens, familyPhrases })
  }
  return { raw: text, concepts }
}

/** True when this query carries at least one real (non-stopword) term. An
 *  empty/stopword-only query matches nothing and every caller should treat it
 *  as "no filter", never as "filter to zero results". */
export function hasRelevanceTerms(query: RelevanceQuery | string): boolean {
  const q = typeof query === 'string' ? parseRelevanceQuery(query) : query
  return q.concepts.length > 0
}

/** Weight of a title hit vs a description-only hit — title matches dominate
 *  because a job's TITLE is what the user actually asked about ("AI Engineer
 *  roles"); a stray mention buried in a long description is weaker evidence. */
const TITLE_WEIGHT = 10
const DESCRIPTION_WEIGHT = 3
/** Weight for a GENERIC_ROLE_TERMS concept (e.g. "engineer") — deliberately
 *  far below TITLE_WEIGHT/DESCRIPTION_WEIGHT so matching only the generic
 *  word in a multi-concept query can never approach the score a real
 *  domain-term match earns. See the GENERIC_ROLE_TERMS comment above. */
const GENERIC_TITLE_WEIGHT = 2
const GENERIC_DESCRIPTION_WEIGHT = 1
/** Weight for an AI-family cross-link hit (concept "ai" matched via a
 *  different family member like "ml"/"machine learning" in the job text) —
 *  below an exact/same-group hit but well above nothing, so "AI Engineer"
 *  ranks a "Machine Learning Engineer" posting clearly above an unrelated
 *  generic-Engineer one. See the AI-family cross-linking comment above. */
const FAMILY_TITLE_WEIGHT = 6
const FAMILY_DESCRIPTION_WEIGHT = 2

function phraseHit(paddedText: string, phrase: string): boolean {
  return paddedText.includes(` ${phrase} `)
}

/**
 * Score one job against a parsed query. 0 = no match at all (never scored,
 * should not be considered "relevant"). Otherwise 1-100, title hits weighted
 * far above description-only hits.
 */
export function scoreJobRelevance(job: RelevanceJob, query: RelevanceQuery | string): RelevanceMatch {
  const q = typeof query === 'string' ? parseRelevanceQuery(query) : query
  if (q.concepts.length === 0) return { score: 0, titleHits: [], descriptionHits: [] }

  const titleTokens = new Set(tokenize(job.title ?? ''))
  const descTokens = new Set(tokenize(job.description ?? ''))
  const paddedTitle = ` ${normalizeText(job.title ?? '')} `
  const paddedDesc = ` ${normalizeText(job.description ?? '')} `

  let raw = 0
  let maxPossible = 0
  const titleHits: string[] = []
  const descriptionHits: string[] = []

  for (const concept of q.concepts) {
    const titleW = concept.generic ? GENERIC_TITLE_WEIGHT : TITLE_WEIGHT
    const descW = concept.generic ? GENERIC_DESCRIPTION_WEIGHT : DESCRIPTION_WEIGHT
    // Every concept counts toward the denominator at its OWN weight
    // (title-hit scale), whether or not it ends up matching — this is what
    // keeps the 0-100 normalization honest when concepts carry different
    // weights (generic vs domain-specific).
    maxPossible += titleW

    const titleTokenHit = concept.tokens.some((t) => titleTokens.has(t))
    const titlePhraseHit = !titleTokenHit && concept.phrases.some((p) => phraseHit(paddedTitle, p))
    if (titleTokenHit || titlePhraseHit) {
      raw += titleW
      titleHits.push(concept.display)
      continue
    }

    // AI-family cross-link: a different family member (e.g. "ml"/"machine
    // learning" for the "ai" concept) in the title — reduced credit, but
    // still a title-level signal.
    const titleFamilyHit =
      concept.familyTokens.some((t) => titleTokens.has(t)) ||
      concept.familyPhrases.some((p) => phraseHit(paddedTitle, p))
    if (titleFamilyHit) {
      raw += Math.min(titleW, FAMILY_TITLE_WEIGHT)
      titleHits.push(concept.display)
      continue
    }

    const descTokenHit = concept.tokens.some((t) => descTokens.has(t))
    const descPhraseHit = !descTokenHit && concept.phrases.some((p) => phraseHit(paddedDesc, p))
    if (descTokenHit || descPhraseHit) {
      raw += descW
      descriptionHits.push(concept.display)
      continue
    }

    const descFamilyHit =
      concept.familyTokens.some((t) => descTokens.has(t)) ||
      concept.familyPhrases.some((p) => phraseHit(paddedDesc, p))
    if (descFamilyHit) {
      raw += Math.min(descW, FAMILY_DESCRIPTION_WEIGHT)
      descriptionHits.push(concept.display)
    }
  }

  if (titleHits.length === 0 && descriptionHits.length === 0) {
    return { score: 0, titleHits, descriptionHits }
  }

  // Normalize against "every concept matched in the title" = 100, so a query
  // that's fully satisfied by the title alone always tops out, regardless of
  // how many concepts were in the query (or their individual weights).
  const score = Math.max(1, Math.min(100, Math.round((raw / maxPossible) * 100)))
  return { score, titleHits, descriptionHits }
}

/** True when `job` matches `query` at all (score > 0). A query with no real
 *  terms matches everything — "no filter" per hasRelevanceTerms above. */
export function isRelevantJob(job: RelevanceJob, query: RelevanceQuery | string): boolean {
  const q = typeof query === 'string' ? parseRelevanceQuery(query) : query
  if (q.concepts.length === 0) return true
  return scoreJobRelevance(job, q).score > 0
}

export interface RankedJob<T extends RelevanceJob> {
  job: T
  relevance: RelevanceMatch
}

/**
 * Rank jobs by relevance to `query`, highest first, STABLE for ties (original
 * relative order preserved — usually caller-supplied newest-first, so ties
 * stay newest-first rather than shuffling). Jobs that scored 0 are still
 * included (at the end) rather than dropped, so a caller can decide for
 * itself whether "nothing matched" should fall back to something else — see
 * copilot-tools.ts's score_jobs, which broadens to the newest-unscored pool
 * when the relevant-matches list comes back empty, and says so.
 */
export function rankJobsByRelevance<T extends RelevanceJob>(jobs: T[], query: RelevanceQuery | string): RankedJob<T>[] {
  const q = typeof query === 'string' ? parseRelevanceQuery(query) : query
  return jobs
    .map((job, index) => ({ job, relevance: scoreJobRelevance(job, q), index }))
    .sort((a, b) => b.relevance.score - a.relevance.score || a.index - b.index)
    .map(({ job, relevance }) => ({ job, relevance }))
}
