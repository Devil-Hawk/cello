import { describe, expect, it } from 'vitest'
import { FREE_DAILY_CALLS_DEFAULT, freeCallsLeftToday, freeCallsToday, freeDailyCalls, typingCalls } from './free-budget'

/** A ledger query that records its filters and answers with a count. */
function ledger(count: number | null, error = false) {
  const seen: [string, ...unknown[]][] = []
  const b: any = {
    select: (...a: unknown[]) => (seen.push(['select', ...a]), b),
    eq: (...a: unknown[]) => (seen.push(['eq', ...a]), b),
    is: (...a: unknown[]) => (seen.push(['is', ...a]), b),
    gte: async (...a: unknown[]) => (seen.push(['gte', ...a]), { count, error: error ? { message: 'db text' } : null }),
  }
  return { db: { from: (t: string) => (seen.push(['from', t]), b) } as never, seen }
}

describe('the day\'s free calls', () => {
  const noon = () => Date.parse('2026-10-22T12:34:56Z')

  it('counts free-rung ledger rows without a failure status since the start of the UTC day, over all steps', async () => {
    const { db, seen } = ledger(300)
    expect(await freeCallsToday(db, noon)).toBe(300)
    expect(seen).toContainEqual(['from', 'llm_spend'])
    expect(seen).toContainEqual(['eq', 'rung', 'R3'])
    // a refused attempt (a 429 or a 404 retry) carries failed_status and is not a call
    expect(seen).toContainEqual(['is', 'failed_status', null])
    expect(seen).toContainEqual(['gte', 'created_at', '2026-10-22T00:00:00.000Z'])
    expect(seen.some(([op, col]) => op === 'eq' && col === 'step')).toBe(false)
  })

  it('starts the day at UTC midnight, not 24 hours back', async () => {
    const { db, seen } = ledger(0)
    await freeCallsToday(db, () => Date.parse('2026-10-22T00:00:01Z'))
    expect(seen).toContainEqual(['gte', 'created_at', '2026-10-22T00:00:00.000Z'])
  })

  it('leaves the allowance minus the count, never below zero', async () => {
    expect(await freeCallsLeftToday(ledger(300).db, noon)).toBe(FREE_DAILY_CALLS_DEFAULT - 300)
    expect(await freeCallsLeftToday(ledger(5000).db, noon)).toBe(0)
  })

  it('reads the allowance from FREE_DAILY_CALLS and falls back to 1,000 for anything else', () => {
    expect(freeDailyCalls('250')).toBe(250)
    for (const bad of [undefined, '', 'many', '-3', '2.5', '0']) expect(freeDailyCalls(bad)).toBe(1000)
  })

  it('fails closed when the ledger cannot be read', async () => {
    await expect(freeCallsToday(ledger(null, true).db, noon)).rejects.toThrow('count_free_calls')
  })

  it('gives typing a fifth of what is left, at most 100', () => {
    expect([1000, 500, 100, 4, 0].map(typingCalls)).toEqual([100, 100, 20, 0, 0])
    expect(typingCalls(2000)).toBe(100)
  })
})
