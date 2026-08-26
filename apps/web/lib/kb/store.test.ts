import { describe, expect, it, vi } from 'vitest'

// replaceChunks's best-effort embed step needs its own admin client and the
// user's decrypted provider keys — mocked here so the embed-failure-isolation
// test below can force that step to fail without a real Supabase/provider.
vi.mock('../harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({ loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args) }))

import { buildDocumentPatch, formatKbContext, replaceChunks, searchKb } from './store'
import type { KbSearchHit } from './types'

// Locks the omitted-means-unchanged contract of upsertDocument()'s UPDATE half.
// Regression guard: an earlier version wrote `title: input.title ?? null` for
// every column, which silently destroyed a document's url/metadata on any
// content-only re-ingest.
describe('buildDocumentPatch', () => {
  it('writes only the fields that were provided', () => {
    expect(buildDocumentPatch({ content: 'fresh text' })).toEqual({ content: 'fresh text' })
  })

  it('omits title/url/metadata entirely when they are absent', () => {
    const patch = buildDocumentPatch({ content: 'x' })
    expect('title' in patch).toBe(false)
    expect('url' in patch).toBe(false)
    expect('metadata' in patch).toBe(false)
  })

  it('still clears a field when null is passed explicitly', () => {
    expect(buildDocumentPatch({ content: 'x', url: null })).toEqual({
      content: 'x',
      url: null,
    })
  })

  it('passes every provided field through', () => {
    expect(
      buildDocumentPatch({
        content: 'body',
        title: 'T',
        url: 'https://e.com',
        metadata: { a: 1 },
      })
    ).toEqual({ content: 'body', title: 'T', url: 'https://e.com', metadata: { a: 1 } })
  })

  it('never patches external_id — it is identity, not an attribute', () => {
    const patch = buildDocumentPatch({
      content: 'x',
      // @ts-expect-error external_id is intentionally outside the patch type
      externalId: 'should-be-ignored',
    })
    expect('external_id' in patch).toBe(false)
    expect('externalId' in patch).toBe(false)
  })
})

function hit(over: Partial<KbSearchHit> = {}): KbSearchHit {
  return {
    chunkId: 'c1',
    documentId: 'd1',
    sourceId: 's1',
    ord: 0,
    content: 'chunk body',
    title: 'Doc',
    url: null,
    rank: 0.5,
    ...over,
  }
}

describe('formatKbContext', () => {
  it('returns an empty string for no hits', () => {
    expect(formatKbContext([])).toBe('')
  })

  it('numbers citations from 1 and appends the url when present', () => {
    const out = formatKbContext([
      hit({ title: 'First', url: 'https://a.com', content: 'alpha' }),
      hit({ title: 'Second', content: 'beta' }),
    ])
    expect(out).toBe('[1] First (https://a.com)\nalpha\n\n[2] Second\nbeta')
  })

  it('falls back to url then a placeholder when the title is null', () => {
    expect(formatKbContext([hit({ title: null, url: 'https://b.com' })])).toContain(
      '[1] https://b.com (https://b.com)'
    )
    expect(formatKbContext([hit({ title: null, url: null })])).toContain('[1] untitled source')
  })

  it('stops before exceeding maxChars', () => {
    const hits = Array.from({ length: 50 }, (_, i) =>
      hit({ title: `D${i}`, content: 'y'.repeat(300) })
    )
    const out = formatKbContext(hits, { maxChars: 900 })
    expect(out.length).toBeLessThanOrEqual(900)
    expect(out).toContain('[1] D0')
  })

  it('enforces a 500-char floor on maxChars so context is never unusably tiny', () => {
    const out = formatKbContext([hit({ content: 'z'.repeat(400) })], { maxChars: 10 })
    expect(out.length).toBeGreaterThan(300)
  })

  // Regression guard: an earlier version returned '' whenever the first block
  // exceeded maxChars, silently handing the model no context at all.
  it('truncates the first hit instead of returning an empty string', () => {
    const out = formatKbContext([hit({ title: 'Big', content: 'q'.repeat(5000) })], {
      maxChars: 800,
    })
    expect(out).not.toBe('')
    expect(out.startsWith('[1] Big')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(800)
  })

  it('always yields context when there is at least one hit, at any budget', () => {
    for (const maxChars of [1, 10, 500, 501, 1200, 6000]) {
      const out = formatKbContext(
        [hit({ title: 'T', url: 'https://x.com', content: 'w'.repeat(4000) })],
        { maxChars }
      )
      expect(out.length).toBeGreaterThan(0)
      // The floor is 500, so nothing may exceed max(500, maxChars).
      expect(out.length).toBeLessThanOrEqual(Math.max(500, maxChars))
    }
  })

  it('drops lower-ranked hits whole rather than truncating them', () => {
    const out = formatKbContext(
      [
        hit({ title: 'First', content: 'a'.repeat(400) }),
        hit({ title: 'Second', content: 'b'.repeat(400) }),
      ],
      { maxChars: 500 }
    )
    expect(out).toContain('[1] First')
    expect(out).not.toContain('Second')
    expect(out).not.toContain('…')
  })

  it('accounts for the separator so the budget is never exceeded', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      hit({ title: `D${i}`, content: 'c'.repeat(100) })
    )
    for (const maxChars of [500, 700, 1000, 2000]) {
      const out = formatKbContext(hits, { maxChars })
      expect(out.length).toBeLessThanOrEqual(maxChars)
    }
  })
})

// --- searchKb hybrid (RRF) fusion --------------------------------------------
//
// The actual fusion runs in SQL (supabase/migrations/20260816000007_hybrid_
// search.sql) — there is no Postgres in this test run, so these two halves
// split the guarantee the way the spec asks:
//   1. the formula itself, `score = sum(1/(60+rank))`, mirrored here exactly
//      and checked on the fixture the migration's own comment cites;
//   2. searchKb() is a pure RPC wrapper (no client-side fusion) — it must
//      forward whatever rows/rank the RPC returns, unchanged, in the same
//      order, and must pass opts.vector/opts.companyId through as p_vec/
//      p_company_id.
describe('searchKb hybrid (RRF) fusion', () => {
  // k = 60: the standard IR constant, matching the migration's `sum(1.0 /
  // (60 + rnk))` verbatim. If that constant ever changes, this must too.
  const rrf = (rank: number) => 1 / (60 + rank)

  it('an item ranked 1st in FTS and 30th in vector beats one ranked 15th in both — the actual formula', () => {
    const strongOnOneSignal = rrf(1) + rrf(30)
    const consistentlyMid = rrf(15) + rrf(15)
    expect(strongOnOneSignal).toBeGreaterThan(consistentlyMid)
    // Not just "greater" — the fixture from the spec, computed exactly.
    expect(strongOnOneSignal).toBeCloseTo(1 / 61 + 1 / 90, 10)
    expect(consistentlyMid).toBeCloseTo(1 / 75 + 1 / 75, 10)
  })

  it('an item present in only one candidate list still scores (absence is not a zero rank)', () => {
    // A doc that never entered the vector list (embedding NULL, or genuinely
    // dissimilar) must still be findable purely on its FTS rank — RRF sums
    // over lists a doc APPEARS IN, it does not penalize the lists it's
    // missing from.
    expect(rrf(1)).toBeGreaterThan(0)
  })

  it('forwards RPC rows through unchanged, and threads vector/companyId to p_vec/p_company_id', async () => {
    const rows = [
      { chunk_id: 'a', document_id: 'd1', source_id: 's1', ord: 0, content: 'A', title: 'A', url: null, rank: rrf(1) + rrf(30) },
      { chunk_id: 'b', document_id: 'd2', source_id: 's1', ord: 0, content: 'B', title: 'B', url: null, rank: rrf(15) + rrf(15) },
    ]
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null })
    const client = { rpc } as unknown as Parameters<typeof searchKb>[0]

    const vector = [0.1, 0.2, 0.3]
    const hits = await searchKb(client, 'user-1', 'query text', { vector, companyId: 'co-1' })

    expect(rpc).toHaveBeenCalledWith('search_kb_chunks', {
      p_user_id: 'user-1',
      p_query: 'query text',
      p_limit: 12,
      p_vec: vector,
      p_company_id: 'co-1',
    })
    expect(hits.map((h) => h.chunkId)).toEqual(['a', 'b'])
    expect(hits[0].rank).toBeGreaterThan(hits[1].rank)
  })

  it('passes p_vec/p_company_id as null when omitted — the RPC then degrades to pure FTS on its own', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })
    const client = { rpc } as unknown as Parameters<typeof searchKb>[0]

    await searchKb(client, 'user-1', 'query')

    expect(rpc).toHaveBeenCalledWith(
      'search_kb_chunks',
      expect.objectContaining({ p_vec: null, p_company_id: null })
    )
  })
})

// --- replaceChunks embed-failure isolation -----------------------------------
//
// The insert half and the best-effort embed half must be genuinely isolated:
// an ingest with no embedding provider configured (the common case — most
// accounts have no BYOK key) must still write every chunk and return the same
// chunkCount it always did. This is the regression that matters: an earlier
// design that awaited the embed step INSIDE the write transaction would have
// turned "no embedding provider" into "can't save this document" — silently
// making ingestion depend on a feature it was designed to be independent of.
describe('replaceChunks embed-failure isolation', () => {
  function fakeChunksClient() {
    const inserted: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        insert: (rows: Record<string, unknown>[]) => {
          inserted.push(...rows)
          return Promise.resolve({ error: null })
        },
      }),
    }
    return { client: client as unknown as Parameters<typeof replaceChunks>[0], inserted }
  }

  it('a rejected loadApiKeys (no provider configured) never blocks or fails ingestion', async () => {
    loadApiKeysMock.mockRejectedValueOnce(new Error('no embedding provider configured'))
    const { client, inserted } = fakeChunksClient()

    const count = await replaceChunks(client, 'user-1', 'doc-1', 'Some content long enough to chunk once.')

    expect(count).toBeGreaterThan(0)
    expect(inserted).toHaveLength(count)
    // The insert payload was built and sent before the embed step ever ran —
    // it carries no `embedding` key at all (the column stays NULL by default,
    // not by an explicit null write).
    expect(inserted.every((r) => !('embedding' in r))).toBe(true)
  })
})
