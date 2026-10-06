import { describe, expect, it } from 'vitest'
import { memorySlotStore } from '@/lib/commands/slots'
import { allowSearchRequest } from './rate-limit'

describe('allowSearchRequest', () => {
  it('allows requests under the per-window cap and blocks the next one', async () => {
    const store = memorySlotStore(() => 1_000_000)
    for (let i = 0; i < 12; i++) {
      expect(await allowSearchRequest('user-1', store)).toBe(true)
    }
    expect(await allowSearchRequest('user-1', store)).toBe(false)
  })

  it('tracks separate users independently', async () => {
    const store = memorySlotStore(() => 2_000_000)
    for (let i = 0; i < 12; i++) await allowSearchRequest('user-a', store)
    expect(await allowSearchRequest('user-a', store)).toBe(false)
    expect(await allowSearchRequest('user-b', store)).toBe(true)
  })

  it('allows again once the window has passed', async () => {
    let now = 3_000_000
    const store = memorySlotStore(() => now)
    for (let i = 0; i < 12; i++) await allowSearchRequest('user-2', store)
    expect(await allowSearchRequest('user-2', store)).toBe(false)
    now += 60_000
    expect(await allowSearchRequest('user-2', store)).toBe(true)
  })
})
