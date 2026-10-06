import { describe, expect, it, vi } from 'vitest'
import { inferResumeMarkdown } from './infer'
import { HEURISTIC_WARNING, structureResume, type StructureRunner } from './structure'
import { ResumeSchema } from '../schema'
import { PASTE_TEXT } from '../test-fixtures'

const SOURCE = `Jane Okafor
jane@example.com | Seattle, WA

EXPERIENCE
Senior Software Engineer, Hooli
03/2021 - Current
- Led a team of four on the billing platform.

EDUCATION
B.S. Computer Science, University of Washington | 2018

SKILLS
Languages: Python, Go`

const MD = inferResumeMarkdown(SOURCE)

const llmJson = (over: Record<string, unknown> = {}) => ({
  basics: { name: 'Jane Okafor', label: '', email: 'jane@example.com', phone: '', url: '', location: 'Seattle, WA', summary: '' },
  work: [
    {
      name: 'Hooli',
      position: 'Senior Software Engineer',
      location: '',
      dates: '03/2021 - Current',
      summary: '',
      highlights: ['Led a team of four on the billing platform.'],
    },
  ],
  education: [
    { institution: 'University of Washington', studyType: 'B.S.', area: 'Computer Science', location: '', dates: '2018', courses: [] },
  ],
  skills: [{ name: 'Languages', keywords: ['Python', 'Go'] }],
  projects: [],
  certificates: [],
  customSections: [],
  ...over,
})

const runner = (...answers: unknown[]): { run: StructureRunner; calls: ReturnType<typeof vi.fn> } => {
  const calls = vi.fn()
  let i = 0
  const run: StructureRunner = async (opts) => {
    calls(opts)
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return { content: typeof a === 'string' ? a : JSON.stringify(a) }
  }
  return { run, calls }
}

describe('structureResume', () => {
  it('uses valid LLM JSON, with a strict schema on the request', async () => {
    const { run, calls } = runner(llmJson())
    const { resume, warnings } = await structureResume(MD, SOURCE, { run })
    expect(resume.work[0]).toMatchObject({ name: 'Hooli', startDate: '2021-03', current: true })
    expect(resume.meta.cello.structuredBy).toBe('llm')
    expect(warnings).toEqual([])
    expect(calls).toHaveBeenCalledTimes(1)
    const opts = calls.mock.calls[0][0]
    expect(opts.jsonSchema.name).toBe('resume')
    expect(opts.temperature).toBe(0)
  })

  it('accepts "03/2021 - Current" normalised to Mar 2021 and Present (no false positive)', async () => {
    const { run } = runner(llmJson())
    const { resume } = await structureResume(MD, SOURCE, { run })
    expect(resume.meta.cello.structuredBy).toBe('llm')
  })

  it('re-asks once with the issue paths when the first answer is invalid, then uses the second', async () => {
    const bad = llmJson({ work: [{ name: 'Hooli' }] })
    const { run, calls } = runner(bad, llmJson())
    const { resume } = await structureResume(MD, SOURCE, { run })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[1][0].prompt).toMatch(/work\.0\.position/)
    expect(resume.meta.cello.structuredBy).toBe('llm')
  })

  it('falls back with a warning after two invalid answers', async () => {
    const { run, calls } = runner('not json at all')
    const { resume, warnings } = await structureResume(MD, SOURCE, { run })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(resume.meta.cello.structuredBy).toBe('heuristic')
    expect(warnings).toContain(HEURISTIC_WARNING)
    expect(resume.work[0].name).toBe('Hooli')
  })

  it('falls back when the model invents an employer', async () => {
    const lie = llmJson({
      work: [{ name: 'Initech', position: 'Director', location: '', dates: '2018', summary: '', highlights: [] }],
    })
    const { run } = runner(lie)
    const { resume } = await structureResume(MD, SOURCE, { run })
    expect(resume.meta.cello.structuredBy).toBe('heuristic')
    expect(JSON.stringify(resume)).not.toContain('Initech')
  })

  it('falls back when a date year is not in the source', async () => {
    const lie = llmJson()
    ;(lie.work[0] as { dates: string }).dates = 'Mar 2015 - Present'
    const { run } = runner(lie)
    const { resume } = await structureResume(MD, SOURCE, { run })
    expect(resume.meta.cello.structuredBy).toBe('heuristic')
  })

  it('falls back on a timeout', async () => {
    const run: StructureRunner = () => new Promise(() => {})
    const { resume } = await structureResume(MD, SOURCE, { run, timeoutMs: 20 })
    expect(resume.meta.cello.structuredBy).toBe('heuristic')
  })

  it('is heuristic and still valid with no runner', async () => {
    const { resume, warnings } = await structureResume(inferResumeMarkdown(PASTE_TEXT), PASTE_TEXT)
    expect(ResumeSchema.safeParse(resume).success).toBe(true)
    expect(resume.work).toHaveLength(3)
    expect(warnings).toContain(HEURISTIC_WARNING)
  })

  it('is valid even for nameless input, with or without the LLM', async () => {
    const fragment = 'SUMMARY\nPlatform engineer.\n\nSKILLS\nGo, SQL'
    const md = inferResumeMarkdown(fragment)
    const plain = await structureResume(md, fragment, { nameCtx: { fullName: 'Grace Hopper' } })
    expect(plain.resume.basics.name).toBe('Grace Hopper')

    const nameless = llmJson({
      basics: { name: '', label: '', email: '', phone: '', url: '', location: '', summary: 'Platform engineer.' },
      work: [],
      education: [],
      skills: [{ name: '', keywords: ['Go', 'SQL'] }],
    })
    const { run } = runner(nameless)
    const viaLlm = await structureResume(md, fragment, { run, nameCtx: { email: 'grace.hopper@navy.mil' } })
    expect(viaLlm.resume.basics.name).toBe('Grace Hopper')
    expect(viaLlm.resume.meta.cello.structuredBy).toBe('llm')
    expect(viaLlm.warnings.join(' ')).toMatch(/could not find your name/)
  })
})
