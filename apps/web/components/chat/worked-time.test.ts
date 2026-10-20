import { describe, expect, it } from 'vitest'
import { workedSeconds } from './worked-time'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

describe('workedSeconds', () => {
  it('starts the count when the plan was answered, not when the plan was offered', () => {
    const rows = [
      { command: 'chat.turn', status: 'done', created_at: at(0), started_at: at(0), finished_at: at(66) },
      { command: 'chat.plan', status: 'done', created_at: at(0), started_at: at(0), finished_at: at(60) },
      { command: 'companies.research', status: 'done', created_at: at(60), started_at: at(60), finished_at: at(66) },
    ]
    expect(workedSeconds(rows, T0 + 66_000)).toBe(6)
  })

  it('keeps the old count for a turn with no plan row', () => {
    const rows = [
      { command: 'chat.turn', status: 'done', created_at: at(0), started_at: at(0), finished_at: at(66) },
      { command: 'companies.research', status: 'done', created_at: at(60), started_at: at(60), finished_at: at(66) },
    ]
    expect(workedSeconds(rows, T0 + 66_000)).toBe(66)
  })
})
