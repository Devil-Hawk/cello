import { describe, expect, it } from 'vitest'
import { CommandRefusal } from '../commands/define'
import { MissingKeyError } from '../harness/providers'
import { BudgetCapError } from '../harness/spend'
import { FreeCapError, NO_MODEL_LINE, reasonOf } from './caps'

describe('reasonOf', () => {
  it('gives the plain sentence of a failure code knows, through any wrapping', () => {
    const cap = new FreeCapError('drafts')
    expect(reasonOf(cap)).toBe('Free models allow 5 drafts a day. Add credit or choose another way to run.')
    expect(reasonOf(new Error('tool failed', { cause: new Error('wrapped', { cause: cap }) }))).toBe(cap.message)
    expect(reasonOf(new BudgetCapError(5, 5))).toContain('Monthly AI spend cap reached')
    expect(reasonOf(new CommandRefusal(429, 'Three starts a turn.'))).toBe('Three starts a turn.')
  })

  it('says where to add a model for a missing key, and nothing for anything else', () => {
    expect(reasonOf(new MissingKeyError())).toBe(NO_MODEL_LINE)
    expect(reasonOf(new Error('provider down'))).toBeNull()
    expect(reasonOf(null)).toBeNull()
  })
})
