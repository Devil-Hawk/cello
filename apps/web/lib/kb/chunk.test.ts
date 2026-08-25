import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAP,
  DEFAULT_TARGET_CHARS,
  chunkText,
  splitSentences,
} from './chunk'

/** Every chunk must be non-empty with contiguous 0-based ords. */
function expectWellFormed(chunks: { ord: number; content: string }[]) {
  chunks.forEach((c, i) => {
    expect(c.ord).toBe(i)
    expect(c.content.length).toBeGreaterThan(0)
    expect(c.content).toBe(c.content.trim())
  })
}

describe('chunkText — short input', () => {
  it('returns [] for empty, whitespace-only and newline-only input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
    expect(chunkText('\n\n\t \r\n')).toEqual([])
  })

  it('returns a single chunk when the content fits the target', () => {
    const out = chunkText('Senior platform engineer. Ten years shipping Kubernetes.')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      ord: 0,
      content: 'Senior platform engineer. Ten years shipping Kubernetes.',
    })
  })

  it('trims and normalizes CRLF without splitting', () => {
    const out = chunkText('  Line one.\r\nLine two.\r\n\r\n\r\n\r\nLine three.  ')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('Line one.\nLine two.\n\nLine three.')
  })

  it('keeps content exactly at the target in one chunk', () => {
    const text = 'a'.repeat(500)
    const out = chunkText(text, { targetChars: 500 })
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe(text)
  })
})

describe('chunkText — long input', () => {
  // 40 distinct paragraphs, ~120 chars each => ~4.8k chars total.
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i} describes project ${i} where the team delivered a measurable outcome and reduced latency by ${i} percent.`
  )
  const doc = paragraphs.join('\n\n')

  it('splits into multiple well-formed chunks', () => {
    const out = chunkText(doc)
    expect(out.length).toBeGreaterThan(1)
    expectWellFormed(out)
  })

  it('never exceeds the target when the text is breakable', () => {
    const out = chunkText(doc, { targetChars: 600, overlap: 80 })
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(600)
  })

  it('preserves every paragraph somewhere in the output', () => {
    const out = chunkText(doc, { targetChars: 600, overlap: 80 })
    const joined = out.map((c) => c.content).join('\n')
    for (const p of paragraphs) expect(joined).toContain(p)
  })

  it('splits a single giant paragraph on sentence boundaries', () => {
    const sentences = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} carries a distinct and verifiable fact.`
    )
    const out = chunkText(sentences.join(' '), { targetChars: 400, overlap: 0 })
    expect(out.length).toBeGreaterThan(1)
    expectWellFormed(out)
    // Each chunk should end at a sentence terminator, not mid-sentence.
    for (const c of out) expect(c.content.endsWith('.')).toBe(true)
  })

  it('splits newline-separated bullets without merging them mid-line', () => {
    const bullets = Array.from(
      { length: 30 },
      (_, i) => `- Shipped feature ${i} that grew activation by ${i} points.`
    )
    const out = chunkText(bullets.join('\n'), { targetChars: 300, overlap: 0 })
    expectWellFormed(out)
    const joined = out.map((c) => c.content).join('\n')
    for (const b of bullets) expect(joined).toContain(b)
  })
})

describe('chunkText — never splits mid-word', () => {
  const words = Array.from({ length: 400 }, (_, i) => `token${i}`)
  const doc = words.join(' ')

  it('keeps every word intact across chunk boundaries', () => {
    const out = chunkText(doc, { targetChars: 250, overlap: 40 })
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      for (const w of c.content.split(/\s+/)) {
        // Every emitted token must be one of the originals, never a fragment.
        expect(words).toContain(w)
      }
    }
  })

  it('hard-cuts only a single unbreakable token longer than the target', () => {
    const blob = 'x'.repeat(1000)
    const out = chunkText(blob, { targetChars: 300, overlap: 0 })
    expect(out.length).toBe(4)
    expect(out.map((c) => c.content).join('')).toBe(blob)
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(300)
  })
})

describe('chunkText — overlap behavior', () => {
  const sentences = Array.from(
    { length: 80 },
    (_, i) => `Fact ${i} is unique and independently checkable.`
  )
  const doc = sentences.join(' ')

  it('repeats the previous tail at the start of the next chunk', () => {
    const out = chunkText(doc, { targetChars: 500, overlap: 120 })
    expect(out.length).toBeGreaterThan(2)
    // At least one seam must actually carry overlap text.
    const overlaps = out.slice(1).filter((c, i) => {
      const prevTail = out[i].content.slice(-120)
      const head = c.content.slice(0, 60)
      return prevTail.includes(head.split(' ').slice(0, 3).join(' '))
    })
    expect(overlaps.length).toBeGreaterThan(0)
  })

  it('produces no overlap when overlap is 0', () => {
    const out = chunkText(doc, { targetChars: 500, overlap: 0 })
    const total = out.reduce((n, c) => n + c.content.length, 0)
    // Without overlap the chunks are a partition, so total ~= source length
    // (differing only by dropped separators).
    expect(total).toBeLessThanOrEqual(doc.length)
  })

  it('clamps overlap to half the target and never loops forever', () => {
    const out = chunkText(doc, { targetChars: 400, overlap: 100_000 })
    expectWellFormed(out)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) expect(c.content.length).toBeLessThanOrEqual(400)
  })

  it('emits no chunk that is wholly contained in its predecessor', () => {
    const out = chunkText(doc, { targetChars: 400, overlap: 199 })
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].content.includes(out[i].content)).toBe(false)
    }
  })
})

describe('chunkText — option clamping', () => {
  it('falls back to defaults for nonsense options', () => {
    const doc = 'Sentence one is here. '.repeat(200)
    const nan = chunkText(doc, { targetChars: NaN, overlap: NaN })
    expectWellFormed(nan)
    expect(nan.length).toBeGreaterThan(1)

    // targetChars is clamped to a 200 floor, so a tiny value still chunks.
    const tiny = chunkText(doc, { targetChars: 5, overlap: -50 })
    expectWellFormed(tiny)
    for (const c of tiny) expect(c.content.length).toBeLessThanOrEqual(200)
  })

  it('exposes the documented defaults', () => {
    expect(DEFAULT_TARGET_CHARS).toBe(1200)
    expect(DEFAULT_OVERLAP).toBe(150)
  })
})

describe('splitSentences', () => {
  it('splits on terminators followed by whitespace', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })

  it('does not split inside decimals, versions or abbreviations', () => {
    expect(splitSentences('Grew revenue 3.5x in node.js services.')).toEqual([
      'Grew revenue 3.5x in node.js services.',
    ])
  })

  it('treats a bare newline as a sentence end', () => {
    expect(splitSentences('- one\n- two\n- three')).toEqual(['- one', '- two', '- three'])
  })

  it('keeps trailing closing punctuation with its sentence', () => {
    expect(splitSentences('He said "ship it!" Then we shipped.')).toEqual([
      'He said "ship it!"',
      'Then we shipped.',
    ])
  })

  it('returns the whole string when there is no boundary', () => {
    expect(splitSentences('no terminator here')).toEqual(['no terminator here'])
  })
})
