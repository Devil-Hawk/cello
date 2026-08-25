// Deterministic role-intent taxonomy — no LLM, no network, no DB, no imports.
//
// PROBLEM THIS SOLVES: a naive keyword query for "SWE - AI/ML" also matches
// "AI Product Manager" (contains "AI") and "Executive Assistant" (contains
// nothing AI-related but slips through when a source has no keyword signal at
// all). lib/jobs/classify.ts's JobFunction taxonomy is deliberately coarse
// (12 broad buckets — "engineering", "data" — shared by every consumer that
// needs a cheap DB column). This module is a finer-grained, ADDITIVE layer on
// top of it: a specific role INTENT ("AI Engineer" vs "Data Scientist" vs
// generic "Software Engineer") with three keyword sets —
//   - titleKeywords   titles that ARE this role
//   - adjacentKeywords titles worth including only when broadening a search
//     that came up short (see lib/harness/agents/sourcer.ts's broaden-on-empty)
//   - excludeKeywords  titles that must NEVER count as this role even though
//     a title/adjacent keyword also matches (checked FIRST, highest
//     precedence) — this is what keeps "AI/ML SWE" from returning
//     "AI Product Manager" or "Executive Assistant"
//
// Kept dependency-free (same rule as classify.ts) so it can be imported by
// the sourcer agent, the copilot tool layer, and unit tests without dragging
// in Supabase/Next types.
//
// Same input => same output, forever — pure functions over static data.

// ---------------------------------------------------------------------------
// Keyword compiler
// ---------------------------------------------------------------------------
//
// Deliberately duplicated from lib/sources/util.ts's compileKeyword rather
// than imported: this module stays a standalone pure leaf (like classify.ts)
// so `lib/jobs/*` never depends on `lib/sources/*` (the reverse already holds
// — lib/sources/util.ts imports lib/jobs/classify.ts — and inverting that
// would create a layering cycle at the package level). Same rule, ported from
// career-ops scan.mjs:80-105: a short (2-3 char) ALL-ALPHA keyword ("ai",
// "ml", "sre") is an acronym and must match on WORD BOUNDARIES ONLY so "AI"
// cannot match inside "chair" and "ML" cannot match inside "HTML5"; anything
// longer, or containing non-letters, keeps permissive substring matching.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function titleContainsKeyword(lowerTitle: string, keyword: string): boolean {
  const kw = keyword.toLowerCase().trim()
  if (!kw) return false
  if (/^[a-z]{2,3}$/.test(kw)) {
    return new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(lowerTitle)
  }
  return lowerTitle.includes(kw)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoleIntentId =
  | 'swe-ai-ml'
  | 'ai-engineer'
  | 'ml-engineer'
  | 'data-scientist'
  | 'data-engineer'
  | 'data-analyst'
  | 'swe-backend'
  | 'swe-frontend'
  | 'swe-fullstack'
  | 'mobile-engineer'
  | 'devops-sre'
  | 'security-engineer'
  | 'qa-engineer'
  | 'product-manager'

export interface RoleIntentDef {
  id: RoleIntentId
  label: string
  /**
   * Token groups used by resolveRoleIntent() to recognize this intent in a
   * free-text query. A group matches when EVERY token in it appears anywhere
   * among the query's whitespace/punctuation-split tokens (order-independent,
   * so "AI/ML SWE" and "SWE - AI/ML" both resolve the same way). Any group
   * matching is enough; when multiple intents match, the group with the MOST
   * tokens wins (more specific beats more generic), see resolveRoleIntent().
   */
  queryTokenGroups: readonly (readonly string[])[]
  /** Title keywords that count as actually being this role. */
  titleKeywords: readonly string[]
  /** Title keywords worth pulling in only when broadening (round 1+). */
  adjacentKeywords: readonly string[]
  /** Title keywords that disqualify a lead from this intent no matter what
   *  else matched — checked before titleKeywords/adjacentKeywords. */
  excludeKeywords: readonly string[]
}

export type TitleMatch = 'in-role' | 'adjacent' | 'excluded' | 'unmatched'

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Exclusion keywords repeated across nearly every engineering/data intent:
// the non-IC roles that a naive substring match on "AI"/"ML"/"engineer"
// would otherwise pull in (an "AI Product Manager" posting mentions "AI" in
// the title; an "Executive Assistant, AI Team" posting mentions nothing
// engineering-shaped but a keywordless source would let it through).
const IC_EXCLUDES = [
  'product manager', 'product owner', 'program manager', 'project manager',
  'project coordinator', 'executive assistant', 'administrative assistant',
  'office manager', 'recruiter', 'technical recruiter', 'sourcer',
  'talent acquisition', 'account executive', 'account manager',
  'sales engineer', 'sales development', 'customer success',
  'customer support', 'technical writer', 'marketing manager',
  'business analyst', 'solutions consultant', 'chief of staff',
] as const

export const ROLE_TAXONOMY: readonly RoleIntentDef[] = [
  {
    id: 'swe-ai-ml',
    label: 'SWE - AI/ML',
    queryTokenGroups: [
      ['ai', 'ml', 'engineer'],
      ['ai', 'ml', 'swe'],
      ['ai', 'ml'],
    ],
    titleKeywords: [
      'ai/ml', 'ai ml', 'ml/ai', 'ai and ml', 'ml and ai',
      'software engineer, ai/ml', 'software engineer, ml/ai',
      'machine learning engineer', 'ml engineer', 'ai engineer',
      'applied scientist', 'applied ml', 'applied ai', 'mlops',
      'ml infrastructure', 'ml platform', 'genai engineer', 'llm engineer',
      'nlp engineer', 'computer vision engineer', 'ai/ml engineer',
    ],
    adjacentKeywords: [
      'data scientist', 'data engineer', 'research scientist', 'ai researcher',
      'research engineer', 'backend engineer', 'platform engineer',
    ],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'ai-engineer',
    label: 'AI Engineer',
    queryTokenGroups: [
      ['ai', 'engineer'],
      ['ai', 'engineering'],
      ['generative', 'ai'],
      ['genai'],
    ],
    titleKeywords: [
      'ai engineer', 'genai engineer', 'llm engineer', 'applied ai engineer',
      'generative ai engineer', 'ai platform engineer', 'ai infrastructure engineer',
      'ai integration engineer', 'conversational ai engineer',
    ],
    adjacentKeywords: [
      'machine learning engineer', 'ml engineer', 'applied scientist',
      'ai researcher', 'mlops engineer', 'nlp engineer',
    ],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'ml-engineer',
    label: 'Machine Learning Engineer',
    queryTokenGroups: [
      ['ml', 'engineer'],
      ['machine', 'learning', 'engineer'],
      ['mle'],
    ],
    titleKeywords: [
      'machine learning engineer', 'ml engineer', 'mlops engineer',
      'ml infrastructure engineer', 'ml platform engineer', 'mle',
    ],
    adjacentKeywords: [
      'ai engineer', 'applied scientist', 'data scientist', 'research engineer',
    ],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'data-scientist',
    label: 'Data Scientist',
    queryTokenGroups: [
      ['data', 'scientist'],
      ['data', 'science'],
    ],
    titleKeywords: [
      'data scientist', 'applied scientist', 'quantitative researcher',
      'research scientist, data', 'decision scientist',
    ],
    adjacentKeywords: [
      'data analyst', 'data engineer', 'machine learning engineer',
      'business intelligence',
    ],
    excludeKeywords: [...IC_EXCLUDES, 'data entry'],
  },
  {
    id: 'data-engineer',
    label: 'Data Engineer',
    queryTokenGroups: [
      ['data', 'engineer'],
      ['data', 'engineering'],
      ['etl'],
    ],
    titleKeywords: [
      'data engineer', 'analytics engineer', 'etl engineer',
      'data platform engineer', 'big data engineer', 'data infrastructure engineer',
    ],
    adjacentKeywords: [
      'data scientist', 'backend engineer', 'data architect',
      'business intelligence engineer',
    ],
    excludeKeywords: [...IC_EXCLUDES, 'data entry'],
  },
  {
    id: 'data-analyst',
    label: 'Data Analyst',
    queryTokenGroups: [
      ['data', 'analyst'],
      ['business', 'intelligence', 'analyst'],
    ],
    titleKeywords: [
      'data analyst', 'business intelligence analyst', 'bi analyst',
      'analytics analyst', 'reporting analyst',
    ],
    adjacentKeywords: ['data scientist', 'data engineer', 'business analyst'],
    excludeKeywords: IC_EXCLUDES.filter((k) => k !== 'business analyst'),
  },
  {
    id: 'swe-backend',
    label: 'SWE - Backend',
    queryTokenGroups: [
      ['backend', 'engineer'],
      ['backend', 'swe'],
      ['server', 'side', 'engineer'],
    ],
    titleKeywords: [
      'backend engineer', 'backend developer', 'backend software engineer',
      'server-side engineer', 'server side engineer', 'api engineer',
    ],
    adjacentKeywords: ['full stack engineer', 'platform engineer', 'infrastructure engineer'],
    excludeKeywords: [...IC_EXCLUDES, 'frontend engineer', 'frontend developer'],
  },
  {
    id: 'swe-frontend',
    label: 'SWE - Frontend',
    queryTokenGroups: [
      ['frontend', 'engineer'],
      ['front', 'end', 'engineer'],
      ['ui', 'engineer'],
    ],
    titleKeywords: [
      'frontend engineer', 'front end engineer', 'front-end engineer',
      'ui engineer', 'react engineer', 'frontend developer',
    ],
    adjacentKeywords: ['full stack engineer', 'ux engineer', 'web developer'],
    excludeKeywords: [...IC_EXCLUDES, 'backend engineer', 'backend developer', 'graphic designer'],
  },
  {
    id: 'swe-fullstack',
    label: 'SWE - Full Stack',
    queryTokenGroups: [
      ['full', 'stack', 'engineer'],
      ['fullstack', 'engineer'],
      ['full', 'stack', 'developer'],
    ],
    titleKeywords: [
      'full stack engineer', 'fullstack engineer', 'full-stack engineer',
      'full stack developer', 'full stack software engineer',
    ],
    adjacentKeywords: ['backend engineer', 'frontend engineer', 'software engineer'],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'mobile-engineer',
    label: 'Mobile Engineer',
    queryTokenGroups: [
      ['mobile', 'engineer'],
      ['ios', 'engineer'],
      ['android', 'engineer'],
      ['mobile', 'developer'],
    ],
    titleKeywords: [
      'ios engineer', 'android engineer', 'mobile engineer', 'mobile developer',
      'react native engineer', 'ios developer', 'android developer',
    ],
    adjacentKeywords: ['frontend engineer', 'full stack engineer'],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'devops-sre',
    label: 'DevOps / SRE',
    queryTokenGroups: [
      ['devops'],
      ['sre'],
      ['site', 'reliability'],
      ['platform', 'engineer'],
    ],
    titleKeywords: [
      'devops engineer', 'site reliability engineer', 'sre', 'platform engineer',
      'infrastructure engineer', 'cloud engineer', 'reliability engineer',
    ],
    adjacentKeywords: ['backend engineer', 'systems engineer', 'security engineer'],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'security-engineer',
    label: 'Security Engineer',
    queryTokenGroups: [
      ['security', 'engineer'],
      ['appsec'],
      ['application', 'security'],
      ['cybersecurity', 'engineer'],
    ],
    titleKeywords: [
      'security engineer', 'application security engineer', 'security researcher',
      'cybersecurity engineer', 'infosec engineer', 'product security engineer',
    ],
    adjacentKeywords: ['devops engineer', 'site reliability engineer', 'network engineer'],
    excludeKeywords: [...IC_EXCLUDES, 'physical security', 'security guard'],
  },
  {
    id: 'qa-engineer',
    label: 'QA Engineer',
    queryTokenGroups: [
      ['qa', 'engineer'],
      ['quality', 'assurance'],
      ['sdet'],
      ['test', 'engineer'],
    ],
    titleKeywords: [
      'qa engineer', 'quality assurance engineer', 'sdet', 'test engineer',
      'automation engineer', 'qa automation engineer',
    ],
    adjacentKeywords: ['backend engineer', 'devops engineer'],
    excludeKeywords: IC_EXCLUDES,
  },
  {
    id: 'product-manager',
    label: 'Product Manager',
    queryTokenGroups: [
      ['product', 'manager'],
      ['product', 'owner'],
    ],
    titleKeywords: [
      'product manager', 'product owner', 'group product manager',
      'senior product manager', 'technical product manager',
    ],
    adjacentKeywords: ['product operations', 'program manager'],
    excludeKeywords: [
      'software engineer', 'backend engineer', 'frontend engineer',
      'full stack engineer', 'executive assistant', 'recruiter',
      'sales representative', 'account executive',
    ],
  },
]

const BY_ID: ReadonlyMap<RoleIntentId, RoleIntentDef> = new Map(
  ROLE_TAXONOMY.map((intent) => [intent.id, intent])
)

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Look up a taxonomy entry by its stable id. */
export function getRoleIntent(id: RoleIntentId): RoleIntentDef | undefined {
  return BY_ID.get(id)
}

/** Split free text into lowercased alphanumeric tokens ("AI/ML SWE" -> [ai, ml, swe]). */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t) out.add(t)
  }
  return out
}

/**
 * Resolve a free-text role query (e.g. "find me 10 AI Engineer roles", "SWE
 * - AI/ML", "Data Scientist") to the ONE taxonomy entry it most specifically
 * names, or null when nothing recognizable matches (callers fall back to
 * generic keyword extraction — this taxonomy is additive precision, not a
 * requirement).
 *
 * Order-independent: matches by token-SET membership, not substring/phrase
 * order, so "AI/ML SWE" and "SWE - AI/ML" resolve identically. When more than
 * one intent's token group matches, the group with the MOST tokens wins
 * (more specific beats more generic) — e.g. a query containing {ai, ml,
 * engineer} matches swe-ai-ml's 3-token group over ai-engineer's or
 * ml-engineer's 2-token groups.
 */
export function resolveRoleIntent(query: string | null | undefined): RoleIntentDef | null {
  if (!query || !query.trim()) return null
  const tokens = tokenize(query)
  if (tokens.size === 0) return null

  let best: { intent: RoleIntentDef; specificity: number } | null = null
  for (const intent of ROLE_TAXONOMY) {
    for (const group of intent.queryTokenGroups) {
      if (group.length === 0) continue
      if (!group.every((t) => tokens.has(t))) continue
      if (!best || group.length > best.specificity) {
        best = { intent, specificity: group.length }
      }
      break // this intent's best group is found; move to the next intent
    }
  }
  return best?.intent ?? null
}

/**
 * Classify a single job title against one taxonomy entry. Exclusion is
 * checked FIRST and wins outright — a title that matches both an exclude
 * keyword and a title keyword (e.g. "AI Engineer (Technical Recruiter
 * Program)" matching both "ai engineer" and "recruiter") is 'excluded', never
 * 'in-role'. This is the precedence that keeps "AI/ML SWE" from absorbing
 * "AI Product Manager" or "Executive Assistant".
 */
export function classifyTitleForIntent(title: string, intent: RoleIntentDef): TitleMatch {
  const lower = ` ${(title || '').toLowerCase()} `
  if (intent.excludeKeywords.some((kw) => titleContainsKeyword(lower, kw))) return 'excluded'
  if (intent.titleKeywords.some((kw) => titleContainsKeyword(lower, kw))) return 'in-role'
  if (intent.adjacentKeywords.some((kw) => titleContainsKeyword(lower, kw))) return 'adjacent'
  return 'unmatched'
}

/**
 * Keyword list to feed the sourcing/relevance layer for a resolved intent.
 * Round 0 (`includeAdjacent: false`) is precise: titleKeywords only. Once a
 * pass comes up short, the sourcer's broaden-on-empty loop calls this again
 * with `includeAdjacent: true` to widen into adjacentKeywords — see
 * lib/harness/agents/sourcer.ts.
 */
export function keywordsForIntent(
  intent: RoleIntentDef,
  opts: { includeAdjacent?: boolean } = {}
): string[] {
  const out = [...intent.titleKeywords]
  if (opts.includeAdjacent) out.push(...intent.adjacentKeywords)
  return out
}
