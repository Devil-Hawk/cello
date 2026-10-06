import { describe, expect, it, vi } from 'vitest'

// Until K15's 384 embedder is on main, material is not embedded and no provider is
// called: the person's embedding money buys vectors search cannot use.
const callEmbedding = vi.fn()
vi.mock('../harness/llm', () => ({ callEmbedding: (...a: unknown[]) => callEmbedding(...a) }))

const { embedMaterial, EMBEDDER_READY } = await import('./embed')

describe('embedMaterial (stub until K15)', () => {
  it('returns null for every text and calls no provider', async () => {
    expect(EMBEDDER_READY).toBe(false)
    expect(await embedMaterial({}, ['a', 'b'], 'embed-chunks')).toEqual([null, null])
    expect(callEmbedding).not.toHaveBeenCalled()
  })
})
