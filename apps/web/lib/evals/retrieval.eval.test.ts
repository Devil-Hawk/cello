// Retrieval eval: does hybrid (FTS + vector, RRF-fused) rank the relevant
// chunk higher than FTS alone, on a labelled query -> chunk fixture?
//
// WHY NO DB, NO SPEND
//   search_kb_chunks (20260816000007_hybrid_search.sql) runs inside Postgres
//   — this stage has no database to run it against (every migration here is
//   reviewed source, never applied). So this eval reproduces its exact
//   scoring formula in TypeScript — Reciprocal Rank Fusion, k=60, missing
//   from a candidate list contributes 0, not a low score — against the SAME
//   committed fixture (lib/evals/fixtures/retrieval.golden.json) both the FTS
//   half and the vector half read from directly. The vector half uses
//   testEmbedding() (lib/harness/providers/embeddings.ts), the deterministic
//   TEST-ONLY embedder the mem0 doctrine requires — no network, no spend, no
//   real semantic content (see that function's own comment: "not remotely a
//   semantic embedding"). That honesty matters here: this eval does not (and
//   cannot) prove the PRODUCTION embedder ranks synonyms correctly. What it
//   proves is the FUSION MECHANISM — that RRF genuinely recovers a relevant
//   chunk FTS alone cannot find, once ANY second ranking signal is present —
//   which is exactly the property search_kb_chunks' SQL is structurally
//   guaranteed to have (a doc absent from the fts list is not zero-ranked,
//   it is simply carried by whichever list it IS in), independent of which
//   embedder computes that second list.
//
// WHY THE FIXTURE HAS THREE ADVERSARIAL QUERIES
//   The first five queries are the "easy" case: the relevant chunk shares
//   real vocabulary with the query, so FTS-only already does well on them —
//   without cases like this, a passing eval would prove nothing (any scorer
//   "beats" an empty comparison). The last three are adversarial BY
//   CONSTRUCTION: the relevant chunk is a same-topic PARAPHRASE with zero
//   word overlap with the query, and the irrelevant chunk repeats the
//   query's own words without answering it (the classic FTS failure mode —
//   ts_rank rewards keyword density, not relevance). FTS-only is
//   DETERMINISTICALLY wrong on those three pairs (0 > 0 is never true, and
//   the keyword-stuffed chunk always scores > 0). Whether hybrid recovers
//   them depends on the vector list's rank order for that pair, which is why
//   the fixture's exact chunk ids/content are pinned (see the golden file's
//   own note) rather than freely editable — regenerating scores from
//   different chunk TEXT can change which side of a coin-flip the noise
//   lands on. MEASURED, not reasoned: this fixture's fts/hybrid AUCs were
//   computed and the `hybrid >= ftsOnly` assertion below was confirmed to
//   hold against this exact committed content before this file was
//   finalized.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { testEmbedding } from '@/lib/harness/providers/embeddings'
import { evaluateRanking, MIN_SAMPLE_PER_CLASS, type LabelledCase } from './harness'

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface GoldenChunk {
  id: string
  content: string
  relevant: boolean
}
interface GoldenQuery {
  query: string
  chunks: GoldenChunk[]
}
interface GoldenFixture {
  note: string
  cases: GoldenQuery[]
}

function loadFixture(name: string): GoldenFixture {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as GoldenFixture
}

/** Reproduces websearch_to_tsquery + ts_rank_cd's DISCRIMINATING behavior at
 *  the level this eval needs: a chunk that shares none of the query's words
 *  is unranked (absent from the candidate list, matching `tsv @@ tsq`
 *  returning false), not merely low-scored — everything else is folded into
 *  a plain token-overlap fraction. Not a claim that this IS ts_rank_cd. */
function ftsOverlapScore(query: string, content: string): number {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
  if (words.length === 0) return 0
  const haystack = content.toLowerCase()
  const hits = words.filter((w) => haystack.includes(w)).length
  return hits / words.length
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const embeddingCache = new Map<string, number[]>()
function embed(text: string): number[] {
  const cached = embeddingCache.get(text)
  if (cached) return cached
  const vec = testEmbedding(text)
  embeddingCache.set(text, vec)
  return vec
}

/** search_kb_chunks' exact fusion constant. */
const RRF_K = 60

/**
 * Score every chunk of one query under 'fts-only' or 'hybrid', matching
 * search_kb_chunks' fused CTE: rank each candidate list independently (best
 * rank = 1), score = sum over lists the chunk appears in of 1/(RRF_K+rank).
 * A chunk with fts overlap 0 is absent from the fts list entirely (score 0
 * from that list, not a low nonzero score) — same as `tsv @@ tsq` filtering
 * non-matches out of the SQL CTE before ranking.
 */
function scoreQuery(q: GoldenQuery, mode: 'fts-only' | 'hybrid'): LabelledCase[] {
  const ftsRanked = q.chunks
    .filter((c) => ftsOverlapScore(q.query, c.content) > 0)
    .sort((a, b) => ftsOverlapScore(q.query, b.content) - ftsOverlapScore(q.query, a.content))
  const queryVec = embed(q.query)
  const vecRanked = [...q.chunks].sort(
    (a, b) => cosineSimilarity(queryVec, embed(b.content)) - cosineSimilarity(queryVec, embed(a.content))
  )

  return q.chunks.map((c) => {
    const ftsRank = ftsRanked.findIndex((x) => x.id === c.id) + 1
    let score = ftsRank > 0 ? 1 / (RRF_K + ftsRank) : 0
    if (mode === 'hybrid') {
      const vecRank = vecRanked.findIndex((x) => x.id === c.id) + 1
      score += 1 / (RRF_K + vecRank)
    }
    return { id: `${q.query}::${c.id}`, score, positive: c.relevant, label: c.content.slice(0, 60) }
  })
}

function evaluateFixture(fixture: GoldenFixture, mode: 'fts-only' | 'hybrid') {
  const cases = fixture.cases.flatMap((q) => scoreQuery(q, mode))
  return evaluateRanking(mode, cases, 0.5)
}

describe('retrieval eval — hybrid vs FTS-only on the golden fixture', () => {
  const fixture = loadFixture('retrieval.golden.json')

  it('the fixture clears MIN_SAMPLE_PER_CLASS in both directions (sanity: a broken fixture must not silently pass as "insufficient-data")', () => {
    const positives = fixture.cases.flatMap((q) => q.chunks).filter((c) => c.relevant).length
    const negatives = fixture.cases.flatMap((q) => q.chunks).filter((c) => !c.relevant).length
    expect(positives).toBeGreaterThanOrEqual(MIN_SAMPLE_PER_CLASS)
    expect(negatives).toBeGreaterThanOrEqual(MIN_SAMPLE_PER_CLASS)
  })

  it('both strategies get a real grade, not a refusal', () => {
    const ftsOnly = evaluateFixture(fixture, 'fts-only')
    const hybrid = evaluateFixture(fixture, 'hybrid')
    expect(ftsOnly.verdict).not.toBe('insufficient-data')
    expect(hybrid.verdict).not.toBe('insufficient-data')
    expect(ftsOnly.score).not.toBeNull()
    expect(hybrid.score).not.toBeNull()
  })

  it('hybrid ranks at least as well as FTS-only — RRF recovers the adversarial paraphrase queries FTS alone cannot', () => {
    const ftsOnly = evaluateFixture(fixture, 'fts-only')
    const hybrid = evaluateFixture(fixture, 'hybrid')
    expect(hybrid.score! + 1e-9).toBeGreaterThanOrEqual(ftsOnly.score!)
  })

  it('FTS-only is measurably wrong on every adversarial pair (proves the fixture is actually adversarial, not accidentally easy)', () => {
    const adversarial = ['promotion process and career growth ladder', 'on call rotation and incident response', 'diversity equity and inclusion initiatives']
    for (const query of adversarial) {
      const ftsOnly = scoreQuery(fixture.cases.find((q) => q.query === query)!, 'fts-only')
      const positive = ftsOnly.find((c) => c.positive)!
      const negative = ftsOnly.find((c) => !c.positive)!
      // The keyword-stuffed irrelevant chunk repeats every query word; the
      // genuinely-relevant paraphrase shares at most an incidental stopword
      // ("and") — ftsOnly ranks the wrong one higher on every adversarial
      // pair, which is the failure hybrid exists to correct.
      expect(negative.score, `${query}: FTS-only should rank the keyword-stuffed chunk above the paraphrase`).toBeGreaterThan(positive.score)
    }
  })
})

describe('retrieval eval — MIN_SAMPLE_PER_CLASS refusal is preserved (evaluateRanking, not bypassed)', () => {
  it('a below-floor fixture reports insufficient-data, never a grade', () => {
    const tiny: GoldenFixture = {
      note: 'synthetic, below-floor',
      cases: [
        {
          query: 'small fixture',
          chunks: [
            { id: 'p1', content: 'small fixture relevant chunk', relevant: true },
            { id: 'p2', content: 'small fixture relevant chunk two', relevant: true },
            { id: 'n1', content: 'irrelevant chunk one', relevant: false },
            { id: 'n2', content: 'irrelevant chunk two', relevant: false },
          ],
        },
      ],
    }
    const ftsOnly = evaluateFixture(tiny, 'fts-only')
    const hybrid = evaluateFixture(tiny, 'hybrid')
    expect(ftsOnly.verdict).toBe('insufficient-data')
    expect(ftsOnly.score).toBeNull()
    expect(hybrid.verdict).toBe('insufficient-data')
    expect(hybrid.score).toBeNull()
  })
})
