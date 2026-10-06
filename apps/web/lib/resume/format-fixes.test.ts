import { describe, expect, it } from 'vitest'
import { formatFixes, resumeHealth } from './format-fixes'
import { structureResume } from './import/structure'
import { COLUMNS_WARNING, looksLikeColumns } from './import/infer'
import { CANONICAL_RESUME } from './test-fixtures'

const clone = () => structuredClone(CANONICAL_RESUME)

describe('formatFixes', () => {
  it('finds nothing on the canonical resume', () => {
    expect(formatFixes(CANONICAL_RESUME, 'a few words')).toEqual([])
  })

  it('names a work or education entry with no date', () => {
    const r = clone()
    r.work[0] = { ...r.work[0], startDate: undefined, endDate: undefined, dateLabel: undefined, current: false }
    r.education[0] = { ...r.education[0], startDate: undefined, endDate: undefined, dateLabel: undefined, current: false }
    expect(formatFixes(r, '')).toEqual([
      `Add dates to ${r.work[0].position} at ${r.work[0].name}.`,
      `Add dates to ${r.education[0].institution}.`,
    ])
  })

  it('asks for an email or phone only when both are missing', () => {
    const r = clone()
    r.basics.email = undefined
    expect(formatFixes(r, '')).toEqual([])
    r.basics.phone = undefined
    expect(formatFixes(r, '')).toEqual(['Add an email or phone under your name.'])
  })

  it('lists the columns warning the import left on the resume', () => {
    const r = clone()
    r.meta.cello.warnings.push(COLUMNS_WARNING)
    expect(formatFixes(r, '')).toEqual([COLUMNS_WARNING])
  })

  it('flags a resume over 900 words and not one at 900', () => {
    const words = (n: number) => Array(n).fill('word').join(' ')
    expect(formatFixes(CANONICAL_RESUME, words(900))).toEqual([])
    expect(formatFixes(CANONICAL_RESUME, words(901))).toEqual(['Over two pages. Most roles want one or two.'])
  })
})

describe('resumeHealth', () => {
  it('is the thin line at 149 words and nothing at 150', () => {
    expect(resumeHealth(149)).toBe('149 words. Too thin for chance checks: add 3 to 5 bullet points per role, with outcomes.')
    expect(resumeHealth(150)).toBeNull()
  })
})

describe('looksLikeColumns', () => {
  it('sees a table row and a three-column line', () => {
    expect(looksLikeColumns('Skills\n| Python | Go | SQL |')).toBe(true)
    expect(looksLikeColumns('Acme Corp      Seattle      2019')).toBe(true)
  })

  it('does not take a contact line, an indent or a plain resume for columns', () => {
    expect(looksLikeColumns('Seattle, WA | me@example.com | (206) 555-0142')).toBe(false)
    expect(looksLikeColumns('Jane Doe\n    - indented bullet\nEngineer')).toBe(false)
  })

  it('structuring a table keeps the warning on the resume', async () => {
    const { resume } = await structureResume('# Jane Doe\n\n## Skills\n\nPython', 'Jane Doe\n| Python | Go | SQL |')
    expect(resume.meta.cello.warnings).toContain(COLUMNS_WARNING)
  })
})
