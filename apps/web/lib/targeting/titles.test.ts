import { describe, expect, it } from 'vitest'
import {
  MAX_TARGET_TITLES,
  MAX_TITLE_LENGTH,
  normalizeTargetTitle,
  normalizeTargetTitles,
  parseTargetTitlesParam,
  resolveTargetTitles,
  serializeTargetTitlesParam,
} from './titles'

describe('normalizeTargetTitle', () => {
  it('trims and collapses whitespace but keeps the user’s casing', () => {
    expect(normalizeTargetTitle('  Senior   Data  Scientist ')).toBe('Senior Data Scientist')
  })

  it('returns empty for anything that is not a usable string', () => {
    expect(normalizeTargetTitle(null)).toBe('')
    expect(normalizeTargetTitle(undefined)).toBe('')
    expect(normalizeTargetTitle(42)).toBe('')
    expect(normalizeTargetTitle('   ')).toBe('')
  })

  it('strips the URL separator so a title can never split itself in two', () => {
    expect(normalizeTargetTitle('Data | Scientist')).toBe('Data Scientist')
  })

  it('caps absurdly long input', () => {
    expect(normalizeTargetTitle('x'.repeat(500))).toHaveLength(MAX_TITLE_LENGTH)
  })
})

describe('normalizeTargetTitles', () => {
  it('drops empties and de-dupes case-insensitively, keeping first-seen casing', () => {
    expect(normalizeTargetTitles(['Data Scientist', '', 'data scientist', '  ', 'AI Engineer'])).toEqual([
      'Data Scientist',
      'AI Engineer',
    ])
  })

  it('ignores non-string members instead of throwing', () => {
    expect(normalizeTargetTitles(['Data Scientist', null, 7, {}, 'AI Engineer'])).toEqual([
      'Data Scientist',
      'AI Engineer',
    ])
  })

  it('returns [] for a non-array', () => {
    expect(normalizeTargetTitles(null)).toEqual([])
    expect(normalizeTargetTitles('Data Scientist')).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_TARGET_TITLES + 10 }, (_, i) => `Role ${i}`)
    expect(normalizeTargetTitles(many)).toHaveLength(MAX_TARGET_TITLES)
  })
})

describe('resolveTargetTitles', () => {
  it('reads preferences.targeting.titles', () => {
    expect(resolveTargetTitles({ targeting: { titles: ['Data Scientist', 'AI Engineer'] } })).toEqual([
      'Data Scientist',
      'AI Engineer',
    ])
  })

  it('returns [] for every shape of missing/garbage input, never throwing', () => {
    expect(resolveTargetTitles(null)).toEqual([])
    expect(resolveTargetTitles(undefined)).toEqual([])
    expect(resolveTargetTitles({})).toEqual([])
    expect(resolveTargetTitles({ targeting: null })).toEqual([])
    expect(resolveTargetTitles({ targeting: {} })).toEqual([])
    expect(resolveTargetTitles({ targeting: { titles: 'Data Scientist' } })).toEqual([])
    expect(resolveTargetTitles('nonsense')).toEqual([])
  })
})

describe('the ?titles= URL form', () => {
  it('round-trips exactly', () => {
    const titles = ['Senior Data Scientist', 'AI Engineer', 'ML Engineer']
    expect(parseTargetTitlesParam(serializeTargetTitlesParam(titles))).toEqual(titles)
  })

  it('survives commas inside a title', () => {
    // The reason the separator is a pipe and not a comma.
    const titles = ['Data Scientist, Trust & Safety']
    expect(parseTargetTitlesParam(serializeTargetTitlesParam(titles))).toEqual(titles)
  })

  it('treats an absent and an empty parameter alike as "no titles"', () => {
    expect(parseTargetTitlesParam(null)).toEqual([])
    expect(parseTargetTitlesParam('')).toEqual([])
    expect(parseTargetTitlesParam('  ')).toEqual([])
  })

  it('ignores empty segments from a stray separator', () => {
    expect(parseTargetTitlesParam('Data Scientist||AI Engineer|')).toEqual(['Data Scientist', 'AI Engineer'])
  })
})
