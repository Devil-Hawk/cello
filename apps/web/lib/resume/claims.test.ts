// Contract tests for lib/resume/claims.ts.
//
// THE PROPERTY THIS FILE EXISTS TO PIN: embedding similarity can ADD
// evidence, and can NEVER excuse a deterministic
// lib/security/job-text.ts#findUnsupportedClaims flag (spec's "model-
// non-cooperation-independence" property). See "deterministic flag survives"
// below for the adversarial case, and "matchClaim carries no ok field" for
// the structural guarantee that makes laundering impossible even by
// accident.
//
// MUTATION VERIFIED (executed, then reverted — not committed): matchClaim
// was temporarily edited to add `ok: true` to every ClaimEvidenceMatch it
// returns. With that change in place, 'matchClaim carries no ok field'
// below fails exactly as expected (`expect('ok' in matches[0]).toBe(false)`
// sees `true`) — proving the test actually exercises the contract it claims
// to, not just the happy path. Reverted immediately after.

import { describe, expect, it } from 'vitest'
import { checkTailoringContainment } from '../security/job-text'
import { matchClaim, normalizeClaimKey, type ResumeClaim } from './claims'

function claim(over: Partial<ResumeClaim> = {}): ResumeClaim {
  return {
    id: 'claim-1',
    userId: 'user-1',
    resumeDocumentId: 'doc-1',
    claimText: 'Led the payments migration to Kubernetes',
    claimKind: 'employment',
    normalizedKey: normalizeClaimKey('Led the payments migration to Kubernetes'),
    embedding: null,
    evidence: [
      {
        id: 'ev-1',
        kbDocumentId: null,
        kbChunkId: null,
        quote: 'Led the payments migration to Kubernetes',
        strength: 'stated',
      },
    ],
    ...over,
  }
}

/** Unit vector with a 1 at `i`, zeros elsewhere — lets a test place two
 *  vectors at an exact, hand-computed cosine similarity via a 2D mix. */
function basisVector(dims: number, i: number): number[] {
  const v = new Array(dims).fill(0)
  v[i] = 1
  return v
}

/** cos(theta) between the two basis vectors mixed at weights (w0, w1). */
function mix(dims: number, w0: number, w1: number): number[] {
  const v = new Array(dims).fill(0)
  v[0] = w0
  v[1] = w1
  return v
}

describe('normalizeClaimKey', () => {
  it('collapses case and punctuation to whole-word-separated lowercase', () => {
    expect(normalizeClaimKey('Led the Payments-Migration!!')).toBe('led the payments migration')
  })

  it('is stable under repeated whitespace', () => {
    expect(normalizeClaimKey('  Led   the   migration  ')).toBe('led the migration')
  })
})

describe('matchClaim — normalized_key tier', () => {
  it('matches on exact normalized text, case/punctuation-insensitive', () => {
    const claims = [claim()]
    const matches = matchClaim(claims, 'LED THE PAYMENTS MIGRATION TO KUBERNETES!')
    expect(matches).toHaveLength(1)
    expect(matches[0].matchedBy).toBe('normalized_key')
    expect(matches[0].similarity).toBeNull()
    expect(matches[0].evidence).toEqual(claims[0].evidence)
  })

  it('never falls through to embedding matching once an exact match exists', () => {
    // A claim with an embedding that would ALSO clear the threshold below —
    // exact match must win outright, not merge with or get overridden by it.
    const exactVec = basisVector(4, 0)
    const claims = [claim({ embedding: exactVec })]
    const matches = matchClaim(claims, claim().claimText, exactVec)
    expect(matches).toHaveLength(1)
    expect(matches[0].matchedBy).toBe('normalized_key')
  })
})

describe('matchClaim — embedding tier', () => {
  it('matches the nearest claim above the threshold when no exact key matches', () => {
    const stored = claim({
      claimText: 'Owned the Kubernetes payments rollout',
      normalizedKey: normalizeClaimKey('Owned the Kubernetes payments rollout'),
      embedding: basisVector(4, 0),
    })
    // cos(theta) with weights (0.99, sqrt(1-0.99^2)) against basis 0 is 0.99 —
    // comfortably above EMBEDDING_MATCH_THRESHOLD (0.93).
    const queryVec = mix(4, 0.99, Math.sqrt(1 - 0.99 * 0.99))
    const matches = matchClaim([stored], 'a differently worded paraphrase', queryVec)
    expect(matches).toHaveLength(1)
    expect(matches[0].matchedBy).toBe('embedding')
    expect(matches[0].similarity).toBeGreaterThan(0.93)
  })

  it('returns nothing below the threshold — a near-topic, not a match', () => {
    const stored = claim({ embedding: basisVector(4, 0) })
    // cos(theta) = 0.6 between the query and the stored claim — related topic,
    // not the same claim.
    const queryVec = mix(4, 0.6, 0.8)
    expect(matchClaim([stored], 'unrelated text', queryVec)).toEqual([])
  })

  it('a claim lacking any matching evidence returns the empty-match shape, not a throw', () => {
    // "Refusal shape": no exception, no placeholder evidence — an empty
    // array a caller can check with .length === 0.
    expect(matchClaim([], 'never seen before', [1, 0, 0, 0])).toEqual([])
  })

  it('skips claims with no embedding rather than throwing on a length mismatch', () => {
    const stored = claim({ embedding: null })
    expect(matchClaim([stored], 'text with no exact match', [1, 0, 0, 0])).toEqual([])
  })

  it('never falls to embedding matching when no textEmbedding is supplied', () => {
    const stored = claim({
      claimText: 'A completely different claim',
      normalizedKey: normalizeClaimKey('A completely different claim'),
      embedding: basisVector(4, 0),
    })
    expect(matchClaim([stored], 'unmatched text')).toEqual([])
  })
})

describe('matchClaim carries no ok field — the structural non-laundering guarantee', () => {
  it('the array and every element are free of an `ok` property', () => {
    const stored = claim({ embedding: basisVector(4, 0) })
    const matches = matchClaim([stored], claim().claimText)
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) {
      expect('ok' in m).toBe(false)
      expect(Object.keys(m).sort()).toEqual(['claimId', 'claimText', 'evidence', 'matchedBy', 'similarity'])
    }
  })
})

describe('deterministic flag survives a high-similarity embedding neighbor', () => {
  it('a fabricated claim is still flagged by findUnsupportedClaims even when matchClaim finds a near-identical stored claim', () => {
    // The resume never mentions Meta at all.
    const resume = 'Senior engineer with eight years building payments infrastructure at Acme Corp.'
    const tailored = 'Staff engineer at Meta, leading platform reliability.'

    // checkTailoringContainment is the hard gate — this must fail on its own,
    // independent of anything below.
    const report = checkTailoringContainment(resume, tailored)
    expect(report.ok).toBe(false)
    expect(report.unsupported.some((u) => u.text === 'Meta')).toBe(true)

    // Now simulate the adversarial case: an extracted-claims store somehow
    // holds a claim whose text and embedding are near-identical to the
    // fabrication (e.g. a prior tailoring for a DIFFERENT, real "Meta"
    // employer got extracted, or an attacker seeded the store).
    const fabricationVec = basisVector(4, 0)
    const adversarialClaim = claim({
      id: 'adversarial',
      claimText: 'Staff engineer at Meta, leading platform reliability.',
      normalizedKey: normalizeClaimKey('Staff engineer at Meta, leading platform reliability.'),
      embedding: fabricationVec,
    })
    const matches = matchClaim([adversarialClaim], tailored, fabricationVec)

    // matchClaim DOES find a match — that's the point of the adversarial
    // setup — but its return value has nowhere to put "ok", and the report
    // computed above is unaffected by having run this at all.
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((m) => !('ok' in m))).toBe(true)
    expect(report.ok).toBe(false)
  })
})
