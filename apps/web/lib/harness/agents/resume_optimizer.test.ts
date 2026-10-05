import { beforeEach, describe, expect, it, vi } from 'vitest'

const createResumeVersion = vi.fn()
vi.mock('@/lib/resume/store', () => ({
  createResumeVersion: (...args: unknown[]) => createResumeVersion(...args),
}))

import { optimizeResume, optimizeResumeAndSave } from './resume_optimizer'
import { ResumeOptimizerOutput } from '../schemas'
import { resumeToPlainText } from '@/lib/resume/render'
import { ResumeSchema } from '@/lib/resume/schema'
import { LEGACY_TAILORED_TEXT } from '@/lib/resume/test-fixtures'
import type { LlmRunOptions, LlmRunner } from '../types'

const SCORE = { atsScore: 70, matchedKeywords: ['Kafka'], missingKeywords: ['Data Platform'], formatIssues: [] }
const PATCH = {
  summary: 'Backend-leaning engineer building data platforms on Kafka and Postgres.',
  skills: [{ name: 'Languages', keywords: ['Python', 'Go', 'terraform'] }],
  work: [{ index: 0, highlights: ['Led a team of 6 engineers to rebuild the reporting pipeline.'] }],
  projects: [],
}

function stub(patch: unknown = PATCH): { llm: LlmRunner; calls: LlmRunOptions[] } {
  const calls: LlmRunOptions[] = []
  const llm: LlmRunner = async (opts) => {
    calls.push(opts)
    const content = opts.jsonSchema ? JSON.stringify(patch) : JSON.stringify(SCORE)
    return { content, tokensUsed: 10, promptTokens: 5, completionTokens: 5, model: 'stub' }
  }
  return { llm, calls }
}

const job = { title: 'Data Platform Engineer', company: 'Acme', description: 'Kafka, Postgres, Python.' }

describe('optimizeResume', () => {
  beforeEach(() => {
    createResumeVersion.mockReset()
  })

  it('structures the base from resumeText when no base is given, and renders the rewrite from the merge', async () => {
    const { llm, calls } = stub()
    const r = await optimizeResume({ resumeText: LEGACY_TAILORED_TEXT, job, llm })
    expect(ResumeSchema.safeParse(r.resume).success).toBe(true)
    expect(r.suggestedRewrite).toBe(resumeToPlainText(r.resume))
    expect(r.resume.work[0].highlights).toEqual(['Led a team of 6 engineers to rebuild the reporting pipeline.'])
    // identity is untouched
    expect(r.resume.work.map((w) => w.name)).toEqual(['Northwind Analytics', 'Contoso Health'])
    // 3 calls: score, rewrite (strict patch), rescore
    expect(calls).toHaveLength(3)
    expect(calls[1].jsonSchema?.name).toBe('tailor_patch')
    expect(calls[1].prompt).toMatch(/work\[0\]: Senior Software Engineer, Northwind Analytics/)
  })

  it('drops a keyword the resume never had and reports it', async () => {
    const { llm } = stub()
    const r = await optimizeResume({ resumeText: LEGACY_TAILORED_TEXT, job, llm })
    expect(r.resume.skills[0].keywords).toEqual(['Python', 'Go', 'TypeScript', 'SQL'])
    expect(r.resume.skills.flatMap((g) => g.keywords)).not.toContain('terraform')
    expect(r.warnings.join(' ')).toMatch(/terraform/)
  })

  it('keeps the base template and section order', async () => {
    const { llm } = stub()
    const first = await optimizeResume({ resumeText: LEGACY_TAILORED_TEXT, job, llm })
    const base = ResumeSchema.parse({
      ...first.resume,
      meta: { cello: { templateId: 'classic', sectionOrder: ['skills', 'work'] } },
    })
    const r = await optimizeResume({ resumeText: LEGACY_TAILORED_TEXT, base, job, llm })
    expect(r.resume.meta.cello.templateId).toBe('classic')
    expect(r.resume.meta.cello.sectionOrder).toEqual(['skills', 'work'])
  })

  it('output parses as the ResumeOptimizerOutput contract that registry, copilot and graph consume', async () => {
    const { llm } = stub()
    const r = await optimizeResume({ resumeText: LEGACY_TAILORED_TEXT, job, llm })
    expect(ResumeOptimizerOutput.safeParse(r).success).toBe(true)
    expect(typeof r.suggestedRewrite).toBe('string')
  })

  it('re-asks once on an invalid patch, then fails without saving anything', async () => {
    const { llm, calls } = stub({ summary: 1 })
    await expect(optimizeResumeAndSave({ resumeText: LEGACY_TAILORED_TEXT, job, llm, client: {} as never, userId: 'u', jobId: 'j' })).rejects.toThrow(
      /nothing was saved/
    )
    // score + 2 rewrite attempts
    expect(calls).toHaveLength(3)
    expect(createResumeVersion).not.toHaveBeenCalled()
  })
})

describe('optimizeResumeAndSave', () => {
  it('saves the structured merge, never text', async () => {
    createResumeVersion.mockReset().mockResolvedValue({ id: 'doc', version: 1 })
    const { llm } = stub()
    const r = await optimizeResumeAndSave({
      resumeText: LEGACY_TAILORED_TEXT,
      job,
      llm,
      client: {} as never,
      userId: 'u1',
      jobId: 'j1',
    })
    expect(createResumeVersion).toHaveBeenCalledTimes(1)
    const input = createResumeVersion.mock.calls[0][1]
    expect(input).toMatchObject({ userId: 'u1', jobId: 'j1', source: 'tailored', atsScore: 70 })
    expect(input.resume).toEqual(r.resume)
    expect(input.content).toBeUndefined()
  })
})
