import { describe, expect, it } from 'vitest'
import { runSkipNote } from './run-outcome'

describe('runSkipNote', () => {
  it('is null when there is nothing to say', () => {
    expect(runSkipNote(null)).toBeNull()
    expect(runSkipNote('done')).toBeNull()
    expect(runSkipNote({})).toBeNull()
    expect(runSkipNote({ outputs: { match: { matches: [] } } })).toBeNull()
  })

  it('names the known reasons', () => {
    expect(runSkipNote({ outputs: { match: { skippedReason: 'no-llm-key' } } })).toBe('Ranking did not run: no model key.')
    expect(runSkipNote({ outputs: { a: {}, match: { skippedReason: 'no-resume' } } })).toBe('Ranking did not run: no resume.')
    expect(runSkipNote({ outputs: { match: { skippedReason: 'no-companies' } } })).toBe('Ranking did not run: no companies added.')
  })

  it('falls back for any other reason', () => {
    expect(runSkipNote({ outputs: { match: { skippedReason: 'all 3 scoring attempt(s) failed: x' } } })).toBe('Part of this did not run.')
  })
})
