import { describe, expect, it } from 'vitest'
import { tokenBuckets } from './index'

describe('tokenBuckets', () => {
  it('reads cached and reasoning counts from an OpenAI-style usage object', () => {
    expect(tokenBuckets({ prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 7 } })).toEqual({ cachedTokens: 40, reasoningTokens: 7 })
  })
  it('says nothing when the provider reports none, or zero', () => {
    expect(tokenBuckets(undefined)).toEqual({})
    expect(tokenBuckets({ prompt_tokens: 5 })).toEqual({})
    expect(tokenBuckets({ prompt_tokens_details: { cached_tokens: 0 } })).toEqual({})
  })
})
