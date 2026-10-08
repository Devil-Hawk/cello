// T33's fixture table: every case passes in CI, before the owner records it.

import { describe, expect, it } from 'vitest'
import { t33Cases } from './t33'

describe('T33 on fixture events', () => {
  it('passes every case', async () => {
    const cases = await t33Cases()
    expect(cases.length).toBeGreaterThanOrEqual(5)
    expect(cases.filter((c) => !c.pass).map((c) => c.name)).toEqual([])
  })
})
