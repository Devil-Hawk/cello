import { describe, expect, it } from 'vitest'
import { inferResumeMarkdown } from './import/infer'
import { markdownToPlainText } from './markdown'
import { markdownToResume } from './from-markdown'
import { resumeFactText, resumeToMarkdown } from './render'
import { ResumeSchema } from './schema'
import { CANONICAL_RESUME, DOCX_STYLE_MD, PASTE_TEXT, PDF_INFER_MD } from './test-fixtures'

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/
const NOISE = new Set(['present', 'current', 'now', 'today'])

/** Tokens of a text with dates, section titles and markup removed: the word bag. */
function bag(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'+#.]*/g) ?? [])
    .map((t) => t.replace(/[.']+$/, ''))
    .filter((t) => t && !MONTHS.test(t) && !NOISE.has(t))
    .sort()
}

const SECTION_WORDS = new Set([
  'summary', 'experience', 'education', 'skills', 'projects', 'certifications', 'awards', 'languages',
])

function sourceBag(source: string, dropName?: string): string[] {
  const lines = markdownToPlainText(source)
    .split('\n')
    .filter((l) => !SECTION_WORDS.has(l.trim().toLowerCase()))
  let text = lines.join('\n')
  if (dropName) text = text.replace(dropName, '')
  return bag(text)
}

const FIXTURES: Array<[string, string]> = [
  ['pasted plain text', inferResumeMarkdown(PASTE_TEXT)],
  ['docx style', DOCX_STYLE_MD],
  ['pdf infer', PDF_INFER_MD],
  ['canonical markdown', resumeToMarkdown(CANONICAL_RESUME)],
  [
    'unknown section',
    `# Ada Lovelace\n\nada@example.com\n\n## Summary\n\nMathematician.\n\n## Conference Talks\n\n- Notes on the Analytical Engine\n- A keynote on loops`,
  ],
]

describe('markdownToResume', () => {
  it.each(FIXTURES)('keeps every word of %s (word-bag invariant) and is schema-valid', (_n, md) => {
    const r = markdownToResume(md)
    expect(ResumeSchema.safeParse(r).success).toBe(true)
    expect(bag(resumeFactText(r))).toEqual(sourceBag(md))
  })

  it('round-trips the canonical resume', () => {
    const back = markdownToResume(resumeToMarkdown(CANONICAL_RESUME))
    const strip = (r: typeof back) => ({ ...r, meta: undefined })
    expect(strip(back)).toEqual(strip(CANONICAL_RESUME))
  })

  it('structures the pasted REPRO resume with sections, entries and bullets', () => {
    const r = markdownToResume(inferResumeMarkdown(PASTE_TEXT))
    expect(r.basics).toMatchObject({
      name: 'Jordan Rivera',
      email: 'jordan.rivera@example.com',
      phone: '(206) 555-0142',
    })
    expect(r.basics.location).toEqual({ city: 'Seattle', region: 'WA' })
    expect(r.work.map((w) => [w.position, w.name])).toEqual([
      ['Senior Software Engineer', 'Northwind Analytics'],
      ['Software Engineer', 'Contoso Health'],
      ['Junior Developer', 'Fabrikam Labs'],
    ])
    expect(r.work[0]).toMatchObject({ startDate: '2021-03', current: true, location: 'Seattle, WA' })
    expect(r.work[0].highlights).toHaveLength(3)
    expect(r.work[1]).toMatchObject({ startDate: '2018-06', endDate: '2021-02', current: false })
    expect(r.education[0]).toMatchObject({
      institution: 'University of Washington',
      studyType: 'B.S.',
      area: 'Computer Science',
      startDate: '2012',
      endDate: '2016',
    })
    expect(r.skills.map((s) => s.name)).toEqual(['Languages', 'Platforms', 'Practices'])
    expect(r.skills[0].keywords).toEqual(['Python', 'TypeScript', 'SQL', 'Go'])
  })

  it('puts DOCX sections written at the name level into sections, with ## entries', () => {
    const r = markdownToResume(DOCX_STYLE_MD)
    expect(r.basics.summary).toMatch(/^Product-minded/)
    expect(r.work).toHaveLength(1)
    expect(r.work[0]).toMatchObject({ position: 'Senior Software Engineer', startDate: '2021-03', current: true })
    expect(r.skills[0].name).toBe('Languages')
    expect(r.meta.cello.customSections).toEqual([])
    expect(resumeToMarkdown(r)).toMatch(/^## Summary$/m)
  })

  it('separates the date from a bold title and keeps the wrapped bullet whole', () => {
    const r = markdownToResume(PDF_INFER_MD)
    expect(r.work[0]).toMatchObject({
      position: 'Senior Software Engineer',
      name: 'Northwind Analytics',
      startDate: '2021-03',
      current: true,
    })
    expect(r.work[0].position).not.toMatch(/2021/)
  })

  it('takes a location on its own line under the title and date as the location, not a summary', () => {
    const r = markdownToResume(
      '# Ada\n\n## Experience\n\n**Engineer, Acme Mar 2021 - Present**\n\nSeattle, WA\n\n- shipped it'
    )
    expect(r.work[0]).toMatchObject({ location: 'Seattle, WA', startDate: '2021-03', current: true })
    expect(r.work[0].summary).toBeUndefined()
  })

  it('sets current only when the source says so', () => {
    const md = (dates: string) => `# Ada\n\n## Experience\n\n### Dev, Acme\n\n*${dates}*\n\n- did things`
    expect(markdownToResume(md('Mar 2021 - Current')).work[0].current).toBe(true)
    expect(markdownToResume(md('Mar 2021')).work[0].current).toBe(false)
    expect(markdownToResume(md('Mar 2021 - Jun 2022')).work[0].current).toBe(false)
  })

  it('routes an unknown section into customSections', () => {
    const r = markdownToResume(FIXTURES[4][1])
    expect(r.meta.cello.customSections).toEqual([
      { title: 'Conference Talks', items: ['Notes on the Analytical Engine', 'A keynote on loops'] },
    ])
  })

  describe('a nameless fragment', () => {
    const fragment = 'SUMMARY\nPlatform engineer with ten years of experience.\n\nSKILLS\nGo, SQL'

    it.each([
      ['the profile name', { fullName: 'Grace Hopper', email: 'g@h.org' }, 'Grace Hopper'],
      ['the email local part', { email: 'grace.hopper@navy.mil' }, 'Grace Hopper'],
      ['a placeholder', {}, 'Your Name'],
    ])('falls back to %s and warns', (_n, ctx, expected) => {
      const r = markdownToResume(inferResumeMarkdown(fragment), ctx)
      expect(r.basics.name).toBe(expected)
      expect(r.meta.cello.warnings.join(' ')).toMatch(/could not find your name/)
      expect(ResumeSchema.safeParse(r).success).toBe(true)
      expect(r.basics.summary).toMatch(/Platform engineer/)
    })
  })

  it('takes the name from a Name | contact line', () => {
    const r = markdownToResume('Ada Lovelace | ada@example.com | (555) 010-2030\n\n## Summary\n\nHi there.')
    expect(r.basics).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' })
  })
})
