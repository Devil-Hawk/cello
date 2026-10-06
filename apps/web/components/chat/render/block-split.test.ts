import { describe, expect, it } from 'vitest'
import { splitMarkdownBlocks } from './block-split'

describe('splitMarkdownBlocks', () => {
  it('returns nothing for empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })

  it('splits paragraphs at blank lines', () => {
    expect(splitMarkdownBlocks('Hello **world**\n\nBye')).toEqual(['Hello **world**', 'Bye'])
  })

  it('keeps a table as one block and separates it from surrounding prose', () => {
    const md = 'Compare:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone'
    expect(splitMarkdownBlocks(md)).toEqual(['Compare:', '| a | b |\n| --- | --- |\n| 1 | 2 |', 'Done'])
  })

  it('does not split inside a fenced code block, even across blank lines', () => {
    const md = 'Before\n\n```js\nfunction f() {\n\n  return 1\n}\n```\n\nAfter'
    const blocks = splitMarkdownBlocks(md)
    expect(blocks).toEqual(['Before', '```js\nfunction f() {\n\n  return 1\n}\n```', 'After'])
  })

  it('rides an unclosed trailing fence to the end as its own block (mid-stream case)', () => {
    const md = 'Here is code:\n\n```ts\nconst x = 1\nconst y = x + '
    const blocks = splitMarkdownBlocks(md)
    expect(blocks).toEqual(['Here is code:', '```ts\nconst x = 1\nconst y = x + '])
  })

  it('keeps a loose ordered list (blank lines between items) as one block so numbering stays correct', () => {
    const md = '1. First\n\n2. Second\n\n3. Third'
    expect(splitMarkdownBlocks(md)).toEqual(['1. First\n\n2. Second\n\n3. Third'])
  })

  it('keeps a tight nested list as one block (no blank lines involved)', () => {
    const md = '- Item 1\n  - Sub A\n  - Sub B\n- Item 2\n\nNext para'
    expect(splitMarkdownBlocks(md)).toEqual(['- Item 1\n  - Sub A\n  - Sub B\n- Item 2', 'Next para'])
  })

  it('does not merge an unrelated paragraph that happens to follow a list', () => {
    const md = '- Item 1\n- Item 2\n\nA plain paragraph, not a list continuation.'
    expect(splitMarkdownBlocks(md)).toEqual(['- Item 1\n- Item 2', 'A plain paragraph, not a list continuation.'])
  })

  it('is append-stable: every block before the growing tail is byte-identical across renders', () => {
    const full = 'Intro paragraph.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nThe tail is still being written'
    const seenPrefixBlocks: string[][] = []
    for (let end = 20; end <= full.length; end += 7) {
      const blocks = splitMarkdownBlocks(full.slice(0, end))
      seenPrefixBlocks.push(blocks)
    }
    // Every stable (non-last) block, once it appears, must never change text
    // on a later render — that's the entire memoization guarantee.
    const stableByIndex = new Map<number, string>()
    for (const blocks of seenPrefixBlocks) {
      for (let i = 0; i < blocks.length - 1; i++) {
        const prior = stableByIndex.get(i)
        if (prior !== undefined) {
          expect(blocks[i]).toBe(prior)
        }
        stableByIndex.set(i, blocks[i])
      }
    }
    expect(stableByIndex.size).toBeGreaterThan(0)
  })
})
