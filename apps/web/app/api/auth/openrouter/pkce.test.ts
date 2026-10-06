import { describe, expect, it } from 'vitest'
import { authUrl, challengeFor, makeVerifier, safeReturn } from './pkce'

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('makes a verifier of 43 to 128 URL-safe characters, never the same twice', () => {
    const a = makeVerifier()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(makeVerifier()).not.toBe(a)
  })

  it('builds OpenRouter\'s sign-in address with the S256 challenge', () => {
    const url = new URL(authUrl('https://cello.example', 'abc'))
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe('https://cello.example/api/auth/openrouter/callback')
    expect(url.searchParams.get('code_challenge')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('returns only to Welcome, Settings or Today', () => {
    expect(safeReturn('/settings')).toBe('/settings')
    expect(safeReturn('/today')).toBe('/today')
    expect(safeReturn('/welcome?screen=connect')).toBe('/welcome')
    for (const bad of ['https://evil.example', '//evil.example', '/roles', '', null, undefined]) {
      expect(safeReturn(bad)).toBe('/welcome')
    }
  })
})
