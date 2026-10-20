import { GraphRecursionError } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { CommandRefusal } from '../commands/define'
import { MissingKeyError } from '../harness/providers'
import { BudgetCapError } from '../harness/spend'
import { FreeCapError, NO_MODEL_LINE, reasonOf, STEP_LIMIT_LINE } from './caps'

describe('reasonOf', () => {
  it('gives the plain sentence of a failure code knows, through any wrapping', () => {
    const cap = new FreeCapError('drafts')
    expect(reasonOf(cap)).toBe('Free models allow 5 drafts a day. Add credit in Settings, under Models, or choose another model.')
    expect(reasonOf(new Error('tool failed', { cause: new Error('wrapped', { cause: cap }) }))).toBe(cap.message)
    expect(reasonOf(new BudgetCapError(5, 5))).toContain('Monthly AI spend cap reached')
    expect(reasonOf(new CommandRefusal(429, 'Three starts a turn.'))).toBe('Three starts a turn.')
  })

  it('gives the chat an action to press: the cap and the missing key link to Settings, under Models', () => {
    expect(reasonOf(new FreeCapError('drafts'), 'chat')).toBe('Free models allow 5 drafts a day. [Add credit in Settings](/settings#models) or choose another model under the compose box.')
    expect(reasonOf(new MissingKeyError(), 'chat')).toContain('](/settings#models)')
    expect(reasonOf(new CommandRefusal(429, 'Three starts a turn.'), 'chat')).toBe('Three starts a turn.')
  })

  it('says the step limit in plain words, for the plain and the chat answer alike, through any wrapping', () => {
    const limit = new GraphRecursionError('Recursion limit of 25 reached.', { lc_error_code: 'GRAPH_RECURSION_LIMIT' })
    const line = 'Cello took on more than it could in one message and stopped. Nothing was changed. Ask again with one thing at a time.'
    expect(reasonOf(limit)).toBe(line)
    expect(reasonOf(limit, 'chat')).toBe(line)
    expect(reasonOf(new Error('graph failed', { cause: limit }))).toBe(line)
    expect(STEP_LIMIT_LINE).toBe(line)
  })

  it('says where to add a model for a missing key, and nothing for anything else', () => {
    expect(reasonOf(new MissingKeyError())).toBe(NO_MODEL_LINE)
    expect(reasonOf(new Error('provider down'))).toBeNull()
    expect(reasonOf(null)).toBeNull()
  })
})
