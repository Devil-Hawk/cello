import { describe, expect, it } from 'vitest'
import { deterministicLine, lineMatchesInput } from './follow_upper'

const items = [
  { company: 'Acme', days: 9 },
  { company: 'Figma', days: 16 },
  { company: 'Notion', days: 8 },
]

describe('lineMatchesInput', () => {
  it('accepts a line that restates the list exactly', () => {
    expect(lineMatchesInput('Queued 3 follow-ups for tomorrow. Figma has been silent the longest, 16 days.', items)).toBe(true)
    expect(lineMatchesInput('Queued a follow-up for tomorrow: Acme has been silent for 9 days.', [{ company: 'Acme', days: 9 }])).toBe(true)
  })

  it('rejects "about two weeks" for 9 days, which is a rounded day count', () => {
    expect(lineMatchesInput('Acme has been silent for about two weeks.', items)).toBe(false)
  })

  it('rejects a number that is not a day count from the list', () => {
    expect(lineMatchesInput('Queued 3 follow-ups. Figma has been silent for 14 days.', items)).toBe(false)
    expect(lineMatchesInput('Queued 5 follow-ups for tomorrow.', items)).toBe(false)
  })

  it('rejects a company that is not in the list, including at the start of a sentence', () => {
    expect(lineMatchesInput('Queued 3 follow-ups. Spotify has been silent the longest, 16 days.', items)).toBe(false)
    expect(lineMatchesInput('Spotify has been silent the longest.', items)).toBe(false)
    expect(lineMatchesInput('Queued 3 follow-ups, including one for Spotify.', items)).toBe(false)
  })

  it('rejects approximations, weeks and months, a long dash, and an empty line', () => {
    expect(lineMatchesInput('Figma has been silent for roughly 16 days.', items)).toBe(false)
    expect(lineMatchesInput('Figma has been silent for over 2 weeks.', items)).toBe(false)
    expect(lineMatchesInput('Figma — 16 days.', items)).toBe(false)
    expect(lineMatchesInput('   ', items)).toBe(false)
  })
})

describe('deterministicLine', () => {
  it('is the computed sentence, with the exact day counts', () => {
    expect(deterministicLine(items)).toBe('Queued 3 follow-ups (due tomorrow) for Acme (9d silent), Figma (16d silent), Notion (8d silent).')
    expect(deterministicLine([items[0]])).toBe('Queued 1 follow-up (due tomorrow) for Acme (9d silent).')
  })

  it('passes its own check', () => {
    expect(lineMatchesInput(deterministicLine(items), items)).toBe(true)
  })
})
