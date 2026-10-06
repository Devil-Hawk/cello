import { describe, expect, it, vi } from 'vitest'

// Material is embedded by the server's own 384 dimension embedder; no provider is called.
const embed384 = vi.fn()
vi.mock('../memory/embedder', () => ({ embed384: (...a: unknown[]) => embed384(...a) }))
const callEmbedding = vi.fn()
vi.mock('../harness/llm', () => ({ callEmbedding: (...a: unknown[]) => callEmbedding(...a) }))

const { embedMaterial } = await import('./embed')

describe('embedMaterial', () => {
  it('returns one vector per text from the server embedder and calls no provider', async () => {
    embed384.mockResolvedValue([[1], [2]])
    expect(await embedMaterial({}, ['a', 'b'], 'embed-chunks')).toEqual([[1], [2]])
    expect(callEmbedding).not.toHaveBeenCalled()
  })

  it('returns null for every text when there is no embedder', async () => {
    embed384.mockResolvedValue(null)
    expect(await embedMaterial({}, ['a', 'b'], 'embed-chunks')).toEqual([null, null])
  })
})
