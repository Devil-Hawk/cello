import { describe, expect, it } from 'vitest'
import { BATCH, checkAll, checkAllLine } from './check-all'
import type { CheckResult } from './record/fit-call'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)
const ok = { ok: true, fit: {} } as unknown as CheckResult
const tick = () => new Promise((done) => setTimeout(done, 1))

describe('Check chances for all', () => {
  it('checks every role, never more than 12 at once', async () => {
    let live = 0
    let peak = 0
    const r = await checkAll(
      ids(61),
      async () => {
        peak = Math.max(peak, ++live)
        await tick()
        live--
        return ok
      },
      { stopped: () => false },
    )
    expect(peak).toBe(BATCH)
    expect(r).toEqual({ checked: 61, total: 61, refusal: null })
    expect(checkAllLine(r)).toBe('Checked 61 of 61.')
  })

  it('stops starting new checks once Stop is pressed, and lets the ones out finish', async () => {
    const seen: string[] = []
    let stop = false
    const r = await checkAll(
      ids(61),
      async (id) => {
        seen.push(id)
        if (seen.length === 12) stop = true
        await tick()
        return ok
      },
      { stopped: () => stop },
    )
    expect(seen).toHaveLength(12)
    expect(r.checked).toBe(12)
    expect(checkAllLine(r)).toBe('Checked 12 of 61.')
  })

  it('ends on a refusal that holds for every role and says it in the route words, but goes on past one role that failed', async () => {
    const budget = "This month's AI budget is used up, so nothing new was picked."
    let n = 0
    const r = await checkAll(ids(30), async () => (++n === 5 ? { ok: false, message: 'nope' } : n === 20 ? { ok: false, message: budget, stop: true } : ok), { stopped: () => false })
    expect(r.refusal).toBe(budget)
    expect(r.checked).toBeGreaterThan(10)
    expect(r.checked).toBeLessThan(30)
    expect(checkAllLine(r)).toBe(`Checked ${r.checked} of 30. ${budget}`)
  })

  it('does nothing for no roles', async () => {
    expect(await checkAll([], async () => ok, { stopped: () => false })).toEqual({ checked: 0, total: 0, refusal: null })
  })
})
