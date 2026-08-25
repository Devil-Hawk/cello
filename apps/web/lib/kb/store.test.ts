import { describe, expect, it } from 'vitest'
import { buildDocumentPatch, formatKbContext } from './store'
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
