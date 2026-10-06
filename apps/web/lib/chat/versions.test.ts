import { describe, expect, it } from 'vitest'
import type { TurnRow } from './types'
import { visibleTurns } from './versions'

const turn = (id: string, kind: TurnRow['kind'], branch_of: string | null = null): TurnRow =>
  ({ id, kind, branch_of, user_id: 'u1', chat_id: 'c1', typed: null, answer: null, origin: 'person', parts: [], links: [], quoted: null, event_id: null, disclosure: null, superseded_at: null, created_at: '' }) as TurnRow
const ids = (v: ReturnType<typeof visibleTurns>) => v.turns.map((t) => t.id)

// p1 a1 p2 a2 were edited at p2 into p2b a2b; then p2b was edited again into p2c.
const forked = [turn('p1', 'person'), turn('a1', 'cello'), turn('p2', 'person'), turn('a2', 'cello'), turn('p2b', 'person', 'p2'), turn('a2b', 'cello'), turn('p2c', 'person', 'p2b'), turn('a2c', 'cello')]

describe('visibleTurns', () => {
  it('shows every turn when nothing was edited, and no switcher', () => {
    const v = visibleTurns(forked.slice(0, 4))
    expect(ids(v)).toEqual(['p1', 'a1', 'p2', 'a2'])
    expect(v.slots).toEqual({})
  })

  it('shows the newest version by default, with "Version 3 of 3" on the turn that was edited', () => {
    const v = visibleTurns(forked)
    expect(ids(v)).toEqual(['p1', 'a1', 'p2c', 'a2c'])
    expect(v.slots.p2c).toMatchObject({ index: 3, count: 3, root: 'p2', versions: ['p2', 'p2b', 'p2c'] })
  })

  it('shows an older version with the turns that followed it, and none of the later ones', () => {
    expect(ids(visibleTurns(forked, { p2: 0 }))).toEqual(['p1', 'a1', 'p2', 'a2'])
    expect(ids(visibleTurns(forked, { p2: 1 }))).toEqual(['p1', 'a1', 'p2b', 'a2b'])
    expect(visibleTurns(forked, { p2: 9 }).slots.p2c.index).toBe(3)
  })

  it('handles an edit made inside a version', () => {
    const nested = [turn('p1', 'person'), turn('a1', 'cello'), turn('p2', 'person'), turn('a2', 'cello'), turn('p2b', 'person', 'p2'), turn('a2b', 'cello'), turn('p3', 'person'), turn('a3', 'cello'), turn('p3b', 'person', 'p3'), turn('a3b', 'cello')]
    const v = visibleTurns(nested)
    expect(ids(v)).toEqual(['p1', 'a1', 'p2b', 'a2b', 'p3b', 'a3b'])
    expect(v.slots.p3b).toMatchObject({ index: 2, count: 2 })
    expect(ids(visibleTurns(nested, { p3: 0 }))).toEqual(['p1', 'a1', 'p2b', 'a2b', 'p3', 'a3'])
  })
})
