import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const nextConfig = createRequire(import.meta.url)('./next.config.js') as {
  headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>
}

describe('next.config security headers', () => {
  it('sends the anti-framing and hardening headers on every route', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe('/(.*)')
    const byKey = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]))
    expect(byKey).toEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
  })

  it('does not ship a script-src CSP (Next inline scripts need nonces first)', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const csp = rules[0].headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    expect(csp).not.toMatch(/script-src|default-src/)
  })
})
