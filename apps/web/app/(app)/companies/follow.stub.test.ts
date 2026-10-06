import { describe, expect, it } from 'vitest'
import { PIN_LIMIT, PIN_NEEDS_FOLLOW } from '@/components/companies/logic'
import { followCompanies } from './follow.stub'

type Op = { m: string; a: unknown[] }
type Row = { id: string; watching: boolean; is_dream_company: boolean }

/** A database that answers by what was asked (the rows, the pin count, or an update) and records every update with its patch. */
function fakeDb(rows: Row[], pins: number) {
  const updates: unknown[] = []
  const chain = (): unknown => {
    const ops: Op[] = []
    const p: unknown = new Proxy(function () {}, {
      get: (_t, m: string) => {
        if (m === 'then') {
          const head = ops.some((o) => o.m === 'select' && (o.a[1] as { head?: boolean } | undefined)?.head)
          const wrote = ops.some((o) => o.m === 'update')
          const result = wrote ? { data: rows.map((r) => ({ id: r.id })), error: null } : head ? { data: null, error: null, count: pins } : { data: rows, error: null }
          return (res: (v: unknown) => unknown) => res(result)
        }
        return (...a: unknown[]) => {
          ops.push({ m, a })
          if (m === 'update') updates.push(a[0])
          return p
        }
      },
    })
    return p
  }
  return { updates, db: { from: chain } as never }
}

const row = (over: Partial<Row> = {}): Row => ({ id: 'a', watching: true, is_dream_company: false, ...over })

describe('followCompanies: the pin rules', () => {
  it('pins only a followed row', async () => {
    const { db, updates } = fakeDb([row({ watching: false })], 0)
    expect(await followCompanies(db, 'u1', ['a'], { pin: true })).toEqual({ ok: false, sentence: PIN_NEEDS_FOLLOW })
    expect(updates).toEqual([])
  })

  it('refuses a sixth pin and writes nothing', async () => {
    const { db, updates } = fakeDb([row()], 5)
    expect(await followCompanies(db, 'u1', ['a'], { pin: true })).toEqual({ ok: false, sentence: PIN_LIMIT })
    expect(updates).toEqual([])
  })

  it('pins the fifth, and a row that is already pinned does not count as a new pin', async () => {
    const fifth = fakeDb([row()], 4)
    expect(await followCompanies(fifth.db, 'u1', ['a'], { pin: true })).toEqual({ ok: true, changed: 1 })
    expect(fifth.updates).toEqual([{ is_dream_company: true }])
    const again = fakeDb([row({ is_dream_company: true })], 5)
    expect((await followCompanies(again.db, 'u1', ['a'], { pin: true })).ok).toBe(true)
  })

  it('takes the pin off when it stops following', async () => {
    const { db, updates } = fakeDb([row({ is_dream_company: true })], 1)
    await followCompanies(db, 'u1', ['a'], { follow: false })
    expect(updates).toEqual([{ watching: false, is_dream_company: false }])
  })
})
