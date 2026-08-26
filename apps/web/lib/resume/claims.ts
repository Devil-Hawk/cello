// The resume evidence graph: public.resume_claims + public.claim_evidence
// (20260816000008_resume_claims.sql), and the two functions everything else
// touches them through.
//
// EXPORTED CONTRACT (read this before calling either function from a new
// site — stage 3's verify nodes are the first consumer):
//   claimsFor(admin, userId) is a plain read of one user's claims plus their
//   evidence, nothing more — it does not filter, rank or judge anything, and
//   it must NEVER be cached at module scope (see its own comment for why:
//   the same warm-instance leak lib/harness/agents/analyst.ts's header
//   documents for CompanyInsightsCache). matchClaim(claims, text,
//   textEmbedding?) is a pure, synchronous lookup over an already-fetched
//   claim set — no network, no DB, no spend — that can only ADD citable
//   evidence to a claim already believed true; its return type has no `ok`
//   field anywhere in it, so there is structurally no way for a caller to
//   use its output to flip lib/security/job-text.ts#findUnsupportedClaims's
//   verdict from unsupported to supported. That deterministic containment
//   check is the only gate (binding ruling 2 of the langgraph port design
//   doc) and stays the only gate — embedding similarity here is citation,
//   not corroboration.

import type { AdminClient } from '../harness/types'

export type ClaimKind = 'skill' | 'employment' | 'education' | 'metric' | 'credential'

export const CLAIM_KINDS: readonly ClaimKind[] = ['skill', 'employment', 'education', 'metric', 'credential']

export type EvidenceStrength = 'stated' | 'demonstrated' | 'inferred'

export interface ClaimEvidence {
  id: string
  kbDocumentId: string | null
  kbChunkId: string | null
  quote: string
  strength: EvidenceStrength
}

export interface ResumeClaim {
  id: string
  userId: string
  resumeDocumentId: string | null
  claimText: string
  claimKind: ClaimKind
  normalizedKey: string
  embedding: number[] | null
  evidence: ClaimEvidence[]
}

/**
 * Whole-word normalization for EXACT claim-identity matching — lowercase,
 * punctuation collapsed to single spaces, padded so a caller can safely
 * compare with `===`. Deliberately NOT despace() (lib/security/job-text.ts):
 * despace's job is containment scanning, where the substring bug that
 * function's own comment documents is a real bypass; this is identity
 * matching between two short claim strings, where whole-word normalization
 * is simpler and sufficient — there is no "is X hiding inside Y" question
 * here, only "are these the same claim".
 */
export function normalizeClaimKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// --- DB row shapes -----------------------------------------------------------
// Untyped admin client, same convention as lib/resume/store.ts: neither table
// is in @cello/shared's generated Database type.

interface ClaimEvidenceRow {
  id: string
  kb_document_id: string | null
  kb_chunk_id: string | null
  quote: string
  strength: EvidenceStrength
}

interface ResumeClaimRow {
  id: string
  user_id: string
  resume_document_id: string | null
  claim_text: string
  claim_kind: ClaimKind
  normalized_key: string | null
  embedding: unknown
  claim_evidence: ClaimEvidenceRow[] | null
}

/**
 * PostgREST serializes an `extensions.vector` column via its text output
 * function ("[0.01,-0.02,...]"), which arrives here as a JSON string — not a
 * native array, since pgvector defines no JSON cast. Tolerates a
 * driver/version that hands back a real array too, so this stays correct
 * either way rather than betting on one wire shape.
 */
function parseEmbedding(raw: unknown): number[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw.map(Number)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(Number) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * All of one user's resume claims, each with its citable evidence — one
 * query (`resume_claims` select with a nested `claim_evidence` embed), no
 * N+1.
 *
 * CACHE THIS AT THE CALL SITE, NEVER IN THIS MODULE. See the file header's
 * contract paragraph: a module-scope cache keyed by userId is exactly the
 * warm-instance leak lib/harness/agents/analyst.ts's header warns against
 * for CompanyInsightsCache. A caller that wants to avoid re-querying per
 * claim within one graph run should hold the returned array in a local
 * variable for that run's lifetime and nothing longer.
 */
export async function claimsFor(admin: AdminClient, userId: string): Promise<ResumeClaim[]> {
  const { data, error } = await admin
    .from('resume_claims')
    .select(
      'id, user_id, resume_document_id, claim_text, claim_kind, normalized_key, embedding, claim_evidence(id, kb_document_id, kb_chunk_id, quote, strength)'
    )
    .eq('user_id', userId)
  if (error) throw new Error(`claimsFor failed: ${error.message}`)

  return ((data ?? []) as ResumeClaimRow[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    resumeDocumentId: row.resume_document_id,
    claimText: row.claim_text,
    claimKind: row.claim_kind,
    normalizedKey: row.normalized_key ?? normalizeClaimKey(row.claim_text),
    embedding: parseEmbedding(row.embedding),
    evidence: (row.claim_evidence ?? []).map((e) => ({
      id: e.id,
      kbDocumentId: e.kb_document_id,
      kbChunkId: e.kb_chunk_id,
      quote: e.quote,
      strength: e.strength,
    })),
  }))
}

/**
 * ponytail: fixed cosine-similarity cutoff, not tuned against a labeled eval
 * set — chosen high enough that a genuine paraphrase of a stored claim
 * clears it while two claims that merely share a topic ("led the payments
 * migration" vs. "owns payments billing") do not. Tighten/loosen here, in
 * one place, if a near-miss neighbor starts surfacing as a false match once
 * stage 3 has real traffic to look at.
 */
const EMBEDDING_MATCH_THRESHOLD = 0.93

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * One stored claim that corroborates a piece of text, and the evidence to
 * cite for it. `similarity` is null for a normalized_key match (exact —
 * nothing to score). THERE IS NO `ok` FIELD ANYWHERE IN THIS TYPE OR ITS
 * ARRAY WRAPPER — see the file header's contract. A caller cannot construct
 * a passing containment verdict from this return value even by accident,
 * because the field that verdict lives in does not exist here.
 */
export interface ClaimEvidenceMatch {
  claimId: string
  claimText: string
  matchedBy: 'normalized_key' | 'embedding'
  similarity: number | null
  evidence: ClaimEvidence[]
}

/**
 * Find stored claims that corroborate `text`: an exact normalized_key match
 * first: falls through to the nearest claim by cosine similarity — ONLY
 * when a caller supplies `textEmbedding` and only above
 * EMBEDDING_MATCH_THRESHOLD — otherwise.
 *
 * Pure and synchronous: no network call, no DB read, no spend. Embedding
 * `text` is a metered callEmbedding call and belongs at the CALLER, once,
 * outside this function — matchClaim only ever compares vectors it is
 * handed. This is deliberate, not an oversight: keeping this function free
 * of I/O is what makes "matchClaim cannot flip a verdict" checkable by
 * reading its signature, not by trusting every future caller to use it
 * correctly.
 */
export function matchClaim(claims: ResumeClaim[], text: string, textEmbedding?: number[] | null): ClaimEvidenceMatch[] {
  const key = normalizeClaimKey(text)
  if (key.length > 0) {
    const exact = claims.filter((c) => c.normalizedKey === key)
    if (exact.length > 0) {
      return exact.map((c) => ({
        claimId: c.id,
        claimText: c.claimText,
        matchedBy: 'normalized_key' as const,
        similarity: null,
        evidence: c.evidence,
      }))
    }
  }

  if (!textEmbedding || textEmbedding.length === 0) return []

  let best: { claim: ResumeClaim; score: number } | null = null
  for (const claim of claims) {
    if (!claim.embedding) continue
    const score = cosineSimilarity(textEmbedding, claim.embedding)
    if (score >= EMBEDDING_MATCH_THRESHOLD && (!best || score > best.score)) best = { claim, score }
  }
  if (!best) return []

  return [
    {
      claimId: best.claim.id,
      claimText: best.claim.claimText,
      matchedBy: 'embedding' as const,
      similarity: best.score,
      evidence: best.claim.evidence,
    },
  ]
}
