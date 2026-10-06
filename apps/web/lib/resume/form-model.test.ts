// The rules behind the section form: dates in, cards moved, empties dropped,
// and what blocks a save. Pure, because vitest has no DOM here (see
// components/resume/resume-form.test.tsx for what renders).

import { describe, expect, it } from 'vitest'
import {
  cleanResume,
  dateText,
  duplicateItem,
  emptyResume,
  fingerprint,
  moveItem,
  moveSection,
  previewMarkdown,
  removeItem,
  sectionKeys,
  singleDateText,
  toSaveable,
  validateResume,
  withCurrent,
  withDateText,
  withSingleDate,
} from './form-model'
import { resumeToMarkdown } from './render'
import { ResumeSchema, type Resume } from './schema'
import { CANONICAL_RESUME } from './test-fixtures'

const blankJob: Resume['work'][number] = { name: '', position: '', current: false, highlights: [] }
const cert = (): Resume['certificates'][number] => ({ name: 'x' })

describe('dates are text that never blocks a save', () => {
  it('"Mar 2021" becomes startDate 2021-03 and shows as "Mar 2021"', () => {
    const job = withDateText({ ...blankJob }, 'Mar 2021', 'work')
    expect(job.startDate).toBe('2021-03')
    expect(job.endDate).toBeUndefined()
    expect(dateText(job)).toBe('Mar 2021')
  })

  it('a range sets both ends, and "Present" sets current', () => {
    const done = withDateText({ ...blankJob }, 'Mar 2021 - Jun 2023', 'work')
    expect(done).toMatchObject({ startDate: '2021-03', endDate: '2023-06', current: false })
    const now = withDateText({ ...blankJob }, 'Mar 2021 - Present', 'work')
    expect(now).toMatchObject({ startDate: '2021-03', current: true })
    expect(dateText(now)).toBe('Mar 2021 - Present')
  })

  it('text that will not parse is kept as typed, and a resume with it still saves', () => {
    const job = withDateText({ ...blankJob, name: 'Acme', position: 'Cook' }, 'Summer 2019', 'work')
    expect(job.dateLabel).toBe('Summer 2019')
    expect(dateText(job)).toBe('Summer 2019')
    const resume = { ...CANONICAL_RESUME, work: [job] }
    expect(validateResume(resume)).toEqual([])
    expect(toSaveable(resume)?.work[0].dateLabel).toBe('Summer 2019')
  })

  it('a lone date is placed by section: start for a job, graduation for a school', () => {
    const job = withDateText({ ...blankJob }, '2019', 'work')
    expect([job.startDate, job.endDate]).toEqual(['2019', undefined])
    const school = withDateText<Resume['education'][number]>({ institution: 'UW', current: false, courses: [] }, '2016', 'education')
    expect([school.startDate, school.endDate]).toEqual([undefined, '2016'])
  })

  it('retyping a date after an unreadable one replaces the old text, so it stops printing', () => {
    const label = withDateText({ ...blankJob }, 'Summer 2019', 'work')
    const fixed = withDateText(label, 'Mar 2021', 'work')
    expect(fixed.dateLabel).toBeUndefined()
    expect(dateText(fixed)).toBe('Mar 2021')
    const ended = withDateText(withDateText({ ...blankJob }, 'Mar 2021 - Jun 2023', 'work'), '2019', 'work')
    expect([ended.startDate, ended.endDate]).toEqual(['2019', undefined])
  })

  it('clearing the field clears the dates', () => {
    const job = withDateText({ ...blankJob }, 'Mar 2021 - Present', 'work')
    const cleared = withDateText(job, '', 'work')
    expect(dateText(cleared)).toBe('')
    expect(cleared.current).toBe(false)
  })

  it('Current sets current and clears the end; unticking stops printing Present', () => {
    const ended = withDateText({ ...blankJob }, 'Mar 2021 - Jun 2023', 'work')
    const now = withCurrent(ended, true)
    expect(now).toMatchObject({ current: true, endDate: undefined })
    expect(dateText(now)).toBe('Mar 2021 - Present')
    expect(dateText(withCurrent(now, false))).toBe('Mar 2021')
  })

  it('a certificate or award keeps one date, or its text', () => {
    expect(withSingleDate(cert(), 'Mar 2021').date).toBe('2021-03')
    const label = withSingleDate(cert(), 'Fall term')
    expect(label.dateLabel).toBe('Fall term')
    expect(singleDateText(label)).toBe('Fall term')
    expect(singleDateText({ date: '2021-03' })).toBe('Mar 2021')
  })
})

describe('moving, duplicating and removing', () => {
  const items = ['a', 'b', 'c']

  it('moves up and down, and stops at the ends', () => {
    expect(moveItem(items, 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(items, 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(items, 0, -1)).toEqual(items)
    expect(moveItem(items, 2, 1)).toEqual(items)
  })

  it('duplicates right after the original, as a copy that shares nothing', () => {
    const jobs = [{ name: 'A', highlights: ['x'] }]
    const out = duplicateItem(jobs, 0)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual(out[0])
    out[1].highlights.push('y')
    expect(out[0].highlights).toEqual(['x'])
  })

  it('removes one, leaving the input untouched so Undo can put it back', () => {
    expect(removeItem(items, 1)).toEqual(['a', 'c'])
    expect(items).toEqual(['a', 'b', 'c'])
  })
})

describe('section order', () => {
  it('moving a section is written to sectionOrder and the markdown follows it', () => {
    const before = sectionKeys(CANONICAL_RESUME)
    const at = before.indexOf('skills')
    const moved = moveSection(CANONICAL_RESUME, 'skills', -1)
    const after = sectionKeys(moved)
    expect(after.indexOf('skills')).toBe(at - 1)
    expect(moved.meta.cello.sectionOrder).toEqual(after)
    const md = resumeToMarkdown(moved)
    expect(md.indexOf('## Skills')).toBeLessThan(md.indexOf('## Projects') === -1 ? md.length : md.indexOf('## Projects'))
  })

  it('does not move the first section up or the last one down', () => {
    const first = sectionKeys(CANONICAL_RESUME)[0]
    expect(moveSection(CANONICAL_RESUME, first, -1)).toBe(CANONICAL_RESUME)
    const keys = sectionKeys(CANONICAL_RESUME)
    expect(moveSection(CANONICAL_RESUME, keys[keys.length - 1], 1)).toBe(CANONICAL_RESUME)
  })
})

describe('cleaning and validating', () => {
  it('drops empty cards and blank highlights rather than failing, and keeps filled ones', () => {
    const draft: Resume = {
      ...CANONICAL_RESUME,
      work: [...CANONICAL_RESUME.work, { ...blankJob }, { ...blankJob, highlights: ['', '  '] }],
      skills: [...CANONICAL_RESUME.skills, { name: 'Empty', keywords: [] }],
    }
    const cleaned = cleanResume(draft)
    expect(cleaned.work).toHaveLength(CANONICAL_RESUME.work.length)
    expect(cleaned.skills).toHaveLength(CANONICAL_RESUME.skills.length)
    const job = { ...CANONICAL_RESUME.work[0], highlights: ['kept', ''] }
    expect(cleanResume({ ...CANONICAL_RESUME, work: [job] }).work[0].highlights).toEqual(['kept'])
  })

  it('an empty name is the one thing that blocks a save', () => {
    const noName = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: '   ' } }
    expect(validateResume(noName)).toEqual([{ id: 'resume-field-name', message: 'Add your name' }])
    expect(toSaveable(noName)).toBeNull()
    expect(validateResume(CANONICAL_RESUME)).toEqual([])
  })

  it('the saved result is a valid resume', () => {
    expect(ResumeSchema.safeParse(toSaveable(CANONICAL_RESUME)).success).toBe(true)
  })

  it('a fresh resume is empty, and unsaveable until it has a name', () => {
    expect(toSaveable(emptyResume())).toBeNull()
    expect(fingerprint(emptyResume())).toBe(fingerprint(cleanResume(emptyResume())))
  })

  it('"has this changed" ignores blank cards and stray spaces, but sees a real edit', () => {
    const withBlank = { ...CANONICAL_RESUME, work: [...CANONICAL_RESUME.work, { ...blankJob }] }
    expect(fingerprint(withBlank)).toBe(fingerprint(CANONICAL_RESUME))
    const padded = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: `  ${CANONICAL_RESUME.basics.name} ` } }
    expect(fingerprint(padded)).toBe(fingerprint(CANONICAL_RESUME))
    const edited = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, summary: 'Something new.' } }
    expect(fingerprint(edited)).not.toBe(fingerprint(CANONICAL_RESUME))
  })
})

describe('the preview follows the form', () => {
  it('a new job with a typed highlight appears in the preview text', () => {
    const job = { ...blankJob, name: 'Globex', position: 'Staff Engineer', highlights: ['Cut deploy time by half'] }
    const md = previewMarkdown({ ...CANONICAL_RESUME, work: [...CANONICAL_RESUME.work, job] })
    expect(md).toContain('### Staff Engineer, Globex')
    expect(md).toContain('- Cut deploy time by half')
  })

  it('a blank name previews as a placeholder, not an empty heading', () => {
    const md = previewMarkdown({ ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: '' } })
    expect(md.startsWith('# Your name')).toBe(true)
  })

  it('the draft never contains an em dash the user did not type', () => {
    expect(previewMarkdown(CANONICAL_RESUME)).not.toContain('—')
  })
})
