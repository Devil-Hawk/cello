// OpenRouter's "sign in with one tap": OAuth 2.0 PKCE (RFC 7636), so a person
// gets a free-model key without pasting one. The verifier never leaves the
// server except to OpenRouter's own exchange; the browser holds it only inside
// an httpOnly cookie for ten minutes.

import { createHash, randomBytes } from 'node:crypto'

/** 64 URL-safe characters, inside RFC 7636's 43 to 128. */
export function makeVerifier(): string {
  return randomBytes(48).toString('base64url')
}

/** BASE64URL(SHA256(verifier)), the S256 challenge. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export const PKCE_COOKIE = 'cello_or_pkce'
export const PKCE_COOKIE_PATH = '/api/auth/openrouter'
export const PKCE_MAX_AGE_SECONDS = 600

/** Where the round trip may send the person back to: Welcome, Settings, Today and Roles, nothing else. */
const RETURN_PATHS = ['/welcome', '/settings', '/today', '/roles']

export function safeReturn(value: string | null | undefined): string {
  const path = (value ?? '').split('?')[0]
  return RETURN_PATHS.includes(path) ? path : '/welcome'
}

export function authUrl(origin: string, challenge: string): string {
  const callback = `${origin}/api/auth/openrouter/callback`
  return `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`
}
