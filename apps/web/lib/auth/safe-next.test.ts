import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safe-next'

describe('safeNextPath', () => {
  it('keeps a same-site path with its query', () => {
    expect(safeNextPath('/settings?tab=connections')).toBe('/settings?tab=connections')
  })

  it.each([
    null,
    undefined,
    '',
    'settings',
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'javascript:alert(1)',
  ])('falls back to the dashboard for %j', (next) => {
    expect(safeNextPath(next)).toBe('/dashboard')
  })
})
