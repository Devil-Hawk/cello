import { describe, expect, it } from 'vitest'
import {
  ResumeLlmSchema,
  ResumeSchema,
  TailorPatchSchema,
  datesFor,
  llmJsonSchema,
  normalizeLlmResume,
  parseDateRange,
  parseLooseDate,
} from './schema'
import { CANONICAL_RESUME } from './test-fixtures'

describe('ResumeSchema', () => {
  it('accepts a valid document and rejects an unnormalised date', () => {
    expect(ResumeSchema.safeParse(CANONICAL_RESUME).success).toBe(true)
    const bad = {
      ...CANONICAL_RESUME,
      work: [{ name: 'A', position: 'B', startDate: 'Jan 2020', highlights: [] }],
    }
    expect(ResumeSchema.safeParse(bad).success).toBe(false)
  })

  it('defaults every list and the meta block', () => {
    const r = ResumeSchema.parse({ basics: { name: 'Ada' } })
    expect(r.work).toEqual([])
    expect(r.meta.cello.customSections).toEqual([])
    expect(r.meta.cello.warnings).toEqual([])
  })

  it('needs only a name', () => {
    expect(ResumeSchema.safeParse({ basics: { name: '' } }).success).toBe(false)
  })
})

describe('parseLooseDate', () => {
  it.each([
    ['Mar 2021', '2021-03'],
    ['March 2021', '2021-03'],
    ['03/2021', '2021-03'],
    ['3/2021', '2021-03'],
    ['2021-03', '2021-03'],
    ['Sept 2020', '2020-09'],
    ['2021', '2021'],
  ])('parses %s', (input, date) => {
    expect(parseLooseDate(input)).toEqual({ date })
  })

  it.each(['Present', 'current', 'Now', 'Today'])('%s means current', (word) => {
    expect(parseLooseDate(word)).toEqual({ current: true })
  })

  it('keeps what it cannot read as a label', () => {
    expect(parseLooseDate('Summer 2019')).toEqual({ label: 'Summer 2019' })
    expect(parseLooseDate('13/2021')).toEqual({ label: '13/2021' })
  })
})

describe('parseDateRange', () => {
  it('splits ranges in every common spelling', () => {
    expect(parseDateRange('Mar 2021 - Present')).toEqual({ startDate: '2021-03', current: true })
    expect(parseDateRange('Jun 2018 – Feb 2021')).toEqual({ startDate: '2018-06', endDate: '2021-02' })
    expect(parseDateRange('2012-2016')).toEqual({ startDate: '2012', endDate: '2016' })
    expect(parseDateRange('2021-03 - 2022-05')).toEqual({ startDate: '2021-03', endDate: '2022-05' })
    expect(parseDateRange('03/2019-12/2021')).toEqual({ startDate: '2019-03', endDate: '2021-12' })
    expect(parseDateRange('Mar 2022 to present')).toEqual({ startDate: '2022-03', current: true })
  })

  it('never invents a Present: an open end needs the word', () => {
    expect(parseDateRange('2019')).toEqual({ single: '2019' })
  })

  it('keeps the original text when it will not normalise', () => {
    expect(parseDateRange('Summer 2019 - Fall 2020')).toEqual({ dateLabel: 'Summer 2019 - Fall 2020' })
  })
})

describe('datesFor', () => {
  it('places a single date by section type', () => {
    expect(datesFor('2019', 'work')).toEqual({ startDate: '2019', current: false })
    expect(datesFor('2016', 'education')).toEqual({ endDate: '2016', current: false })
  })
})

describe('LLM schemas', () => {
  it.each([
    ['resume', ResumeLlmSchema],
    ['patch', TailorPatchSchema],
  ])('%s is strict-mode safe: closed objects, every property required', (_name, schema) => {
    const check = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false)
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort())
      }
      Object.values(n).forEach(check)
    }
    check(llmJsonSchema(schema))
  })
})

describe('normalizeLlmResume', () => {
  const empty = {
    basics: { name: '', label: '', email: '', phone: '', url: '', location: '', summary: '' },
    work: [],
    education: [],
    skills: [],
    projects: [],
    certificates: [],
    customSections: [],
  }

  it('parses dates, drops empties and applies the name chain', () => {
    const r = normalizeLlmResume(
      {
        ...empty,
        basics: { ...empty.basics, location: 'Seattle, WA', email: ' a@b.co ' },
        work: [
          { name: 'Acme', position: 'Dev', location: '', dates: 'Mar 2021 - Present', summary: '', highlights: ['x', ' '] },
        ],
        education: [{ institution: 'UW', studyType: 'B.S.', area: '', location: '', dates: '2016', courses: [] }],
        skills: [{ name: '', keywords: ['Go', ''] }, { name: 'Empty', keywords: [] }],
      },
      { email: 'jo.smith@example.com' }
    )
    expect(r.basics.name).toBe('Jo Smith')
    expect(r.basics.email).toBe('a@b.co')
    expect(r.basics.location).toEqual({ city: 'Seattle', region: 'WA' })
    expect(r.work[0]).toMatchObject({ startDate: '2021-03', current: true, highlights: ['x'] })
    expect(r.education[0]).toMatchObject({ endDate: '2016', current: false })
    expect(r.skills).toEqual([{ name: 'Skills', keywords: ['Go'] }])
    expect(r.meta.cello.warnings.join(' ')).toMatch(/could not find your name/)
  })
})
