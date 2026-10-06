import { describe, expect, it } from 'vitest'
import { MissingKeyError } from '@/lib/harness/providers'
import { DEFAULT_FREE_MODELS, celloChatModel, freeFallbackModels, isFreeModel } from './model'

describe('freeFallbackModels', () => {
  it('uses the default list when nothing is configured', () => {
    expect(freeFallbackModels('')).toEqual([...DEFAULT_FREE_MODELS])
  })

  it('reads a comma list and refuses any id that is not free', () => {
    expect(freeFallbackModels('a/b:free, anthropic/claude-sonnet-5 ,c/d:free')).toEqual(['a/b:free', 'c/d:free'])
  })

  it('an environment of only paid ids yields the free default rather than a paid one', () => {
    expect(freeFallbackModels('anthropic/claude-opus-4.8')).toEqual([...DEFAULT_FREE_MODELS])
  })

  it('every default is free', () => {
    expect(DEFAULT_FREE_MODELS.every(isFreeModel)).toBe(true)
  })
})

describe('celloChatModel', () => {
  it('needs an OpenRouter key', () => {
    expect(() => celloChatModel({ apiKeys: {}, purpose: 'orchestrator' })).toThrow(MissingKeyError)
  })

  it('uses the model the user chose, with the purpose output budget', () => {
    const m = celloChatModel({ apiKeys: { openrouter: 'k', model: 'anthropic/claude-haiku-4.5' }, purpose: 'researcher' })
    expect(m.model).toBe('anthropic/claude-haiku-4.5')
    expect(m.maxTokens).toBe(2048)
  })

  it('falls back to the default model for an id that is not allowed', () => {
    const m = celloChatModel({ apiKeys: { openrouter: 'k', model: 'some/unlisted' }, purpose: 'orchestrator' })
    expect(m.model).toBe('anthropic/claude-sonnet-5')
  })

  it('only ever lists free models for OpenRouter-side fallback', () => {
    const m = celloChatModel({ apiKeys: { openrouter: 'k' }, purpose: 'orchestrator', serverFallback: true })
    expect(m.models?.length).toBeGreaterThan(0)
    expect(m.models?.every(isFreeModel)).toBe(true)
  })
})
