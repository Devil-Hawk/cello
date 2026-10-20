import { describe, expect, it } from 'vitest'
import { parseRunNote, runNote, TIERS } from './tiers'

describe('run notes', () => {
  it('lists the three tiers', () => {
    expect([...TIERS]).toEqual(['local', 'free', 'paid'])
  })

  it('writes the tier, model, core and prompt tokens, then the rest after a semicolon', () => {
    expect(runNote({ tier: 'free', model: 'google/gemma-4-26b-a4b-it:free', core: 'deep', promptTokens: 1834 }, 'injection=0')).toBe(
      'tier=free model=google/gemma-4-26b-a4b-it:free core=deep prompt_tokens=1834; injection=0'
    )
  })

  it('leaves prompt_tokens out when it is null or missing, and the rest out when there is none', () => {
    expect(runNote({ tier: 'local', model: 'qwen3:8b', core: 'plain', promptTokens: null })).toBe('tier=local model=qwen3:8b core=plain')
    expect(runNote({ tier: 'paid', model: 'm', core: 'deep' })).toBe('tier=paid model=m core=deep')
  })

  it('round trips, with the rest as extra text', () => {
    const meta = { tier: 'free', model: 'a/b:free', core: 'plain', promptTokens: 900 } as const
    expect(parseRunNote(runNote(meta, '0 facts on the wrong object'))).toEqual({ tier: 'free', model: 'a/b:free', core: 'plain', promptTokens: 900 })
  })

  it('joins several models with a comma and no spaces', () => {
    const note = runNote({ tier: 'free', model: 'a/b:free,c/d:free', core: 'deep', promptTokens: 10 })
    expect(note).toBe('tier=free model=a/b:free,c/d:free core=deep prompt_tokens=10')
    expect(parseRunNote(note).model).toBe('a/b:free,c/d:free')
  })

  it('reads a note with no prompt tokens as null tokens', () => {
    expect(parseRunNote('tier=free model=m core=deep; injection=1')).toEqual({ tier: 'free', model: 'm', core: 'deep', promptTokens: null })
  })

  it('reads a legacy note, an empty note and no note as no tier', () => {
    const none = { tier: null, model: null, core: null, promptTokens: null }
    expect(parseRunNote('0 facts on the wrong object')).toEqual(none)
    expect(parseRunNote('')).toEqual(none)
    expect(parseRunNote(null)).toEqual(none)
  })

  it('ignores a tier or core it does not know', () => {
    expect(parseRunNote('tier=gold model=m core=huge')).toMatchObject({ tier: null, core: null, model: 'm' })
  })
})
