import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepContext, LlmRunner } from '../types'

let facts: { id: string; text: string; url: string }[] = []
vi.mock('@/lib/dossier/facts', () => ({ companyFacts: async () => facts }))

const { cv_tailor, letterTier } = await import('./cv_tailor')

const RESUME = [
  'Marcus Delgado',
  'Led the card-authorization service (Go, gRPC, Postgres) at 4,000 requests/sec',
  'Migrated 30 services from VMs to Kubernetes (EKS)',
  'Mentor 4 engineers',
  'Designed an idempotent double-entry ledger',
].join('\n')

const DESCRIPTION = ['You will own the card-authorization path.', 'Experience running Kubernetes in production.', 'You will mentor mid-level engineers.', 'Experience with Rust is a plus.'].join('\n')

function ctx(llmContent: unknown, over: { description?: string | null; companyId?: string | null } = {}) {
  const calls: { system: string; prompt: string }[] = []
  const llm: LlmRunner = async (opts) => {
    calls.push({ system: opts.system ?? '', prompt: opts.prompt ?? '' })
    return { content: JSON.stringify(llmContent), tokensUsed: 5, promptTokens: 0, completionTokens: 0, model: 'm' }
  }
  const query = (data: unknown) => ({ select: () => query(data), eq: () => query(data), single: async () => ({ data, error: null }) })
  const admin = {
    from: (table: string) =>
      table === 'person_jobs'
        ? query({
            id: 'job-1',
            title: 'Senior Backend Engineer',
            description: over.description === undefined ? DESCRIPTION : over.description,
            location: 'Remote',
            url: null,
            company_id: over.companyId === undefined ? 'co-1' : over.companyId,
            viewer_company_name: 'Ramp',
          })
        : query({ resume_text: RESUME }),
  }
  return { calls, stepCtx: { userId: 'user-1', input: { jobId: 'job-1' }, admin, llm } as unknown as StepContext }
}

const words = (n: number, lead = 'Dear Ramp team,') => `${lead} ${'built '.repeat(n)}`.trim()

beforeEach(() => {
  facts = []
})

describe('the letter length follows the evidence, decided by code', () => {
  it.each([
    [3, true, 'full'],
    [4, true, 'full'],
    [2, true, 'focused'],
    [1, true, 'focused'],
    [0, true, 'brief'],
    [3, false, 'brief'],
  ] as const)('%i pairs with a job post %s is a %s letter', (pairs, hasPost, tier) => {
    expect(letterTier(pairs, hasPost)).toBe(tier)
  })

  it('counts only pairs whose job line and resume line both exist, and counts a pair once', async () => {
    const { stepCtx } = ctx({
      resumeSummary: 'Backend engineer, Go and Kubernetes.',
      coverLetter: words(200),
      keywords: ['go'],
      evidence: [
        { jobLine: 'J1', resumeLine: 'R2' },
        { jobLine: 'J1', resumeLine: 'R2' },
        { jobLine: 'J2', resumeLine: 'R99' },
        { jobLine: 'J99', resumeLine: 'R3' },
      ],
      companyFact: null,
    })
    const out = (await cv_tailor(stepCtx)).output as { coverLetterMeta: { tier: string; evidence: { job: string; resume: string }[] } }
    expect(out.coverLetterMeta.tier).toBe('focused')
    expect(out.coverLetterMeta.evidence).toEqual([
      { job: 'You will own the card-authorization path.', resume: 'Led the card-authorization service (Go, gRPC, Postgres) at 4,000 requests/sec' },
    ])
  })

  it('fails the word count check for a 380 word letter backed by one evidence pair', async () => {
    const { stepCtx } = ctx({
      resumeSummary: 'Backend engineer.',
      coverLetter: words(380),
      keywords: [],
      evidence: [{ jobLine: 'J1', resumeLine: 'R2' }],
      companyFact: null,
    })
    const meta = ((await cv_tailor(stepCtx)).output as { coverLetterMeta: { tier: string; words: number; checks: { id: string; ok: boolean; message: string }[] } }).coverLetterMeta
    expect(meta.tier).toBe('focused')
    expect(meta.words).toBeGreaterThan(380)
    expect(meta.checks.find((c) => c.id === 'word_count')).toMatchObject({ ok: false, message: expect.stringContaining('A focused letter runs 150 to 250') })
  })

  it('treats a job with no description as a brief letter, whatever the model cites', async () => {
    const { stepCtx } = ctx(
      { resumeSummary: 'x.', coverLetter: words(120), keywords: [], evidence: [{ jobLine: 'J1', resumeLine: 'R2' }], companyFact: null },
      { description: null }
    )
    const meta = ((await cv_tailor(stepCtx)).output as { coverLetterMeta: { tier: string; hasJobPost: boolean } }).coverLetterMeta
    expect(meta).toMatchObject({ tier: 'brief', hasJobPost: false })
  })
})

describe('the company can be mentioned only from cited research', () => {
  const letter = `${words(150)} Ramp says engineers ship to production in their first week.`

  it('gives the writer the research when a cited dossier exists, and the fact comes back with its link', async () => {
    facts = [{ id: 'D1', text: 'Engineers ship to production in their first week', url: 'https://ramp.com/careers' }]
    const { calls, stepCtx } = ctx({ resumeSummary: 'x.', coverLetter: letter, keywords: [], evidence: [{ jobLine: 'J1', resumeLine: 'R2' }], companyFact: 'D1' })
    const out = (await cv_tailor(stepCtx)).output as { coverLetterMeta: { companyFact: unknown; hasCompanyFacts: boolean } }
    expect(calls[0].prompt).toContain('D1: Engineers ship to production in their first week (https://ramp.com/careers)')
    expect(out.coverLetterMeta.companyFact).toEqual({ text: 'Engineers ship to production in their first week', url: 'https://ramp.com/careers' })
    expect(out.coverLetterMeta.hasCompanyFacts).toBe(true)
  })

  it('says there is no research on file when there is none, and drops a fact the model made up', async () => {
    const { calls, stepCtx } = ctx({ resumeSummary: 'x.', coverLetter: letter, keywords: [], evidence: [], companyFact: 'D1' })
    const out = (await cv_tailor(stepCtx)).output as { coverLetterMeta: { companyFact: unknown; hasCompanyFacts: boolean } }
    expect(calls[0].prompt).toContain('No company research on file.')
    expect(out.coverLetterMeta.companyFact).toBeNull()
    expect(out.coverLetterMeta.hasCompanyFacts).toBe(false)
  })

  it('drops a cited fact the letter never uses', async () => {
    facts = [{ id: 'D1', text: 'Engineers ship to production in their first week', url: 'https://ramp.com/careers' }]
    const { stepCtx } = ctx({ resumeSummary: 'x.', coverLetter: words(150), keywords: [], evidence: [], companyFact: 'D1' })
    expect(((await cv_tailor(stepCtx)).output as { coverLetterMeta: { companyFact: unknown } }).coverLetterMeta.companyFact).toBeNull()
  })
})

describe('what the writer is shown', () => {
  it('numbers the resume and the job post, and fences the post as data', async () => {
    const { calls, stepCtx } = ctx({ resumeSummary: 'x.', coverLetter: words(100), keywords: [], evidence: [], companyFact: null })
    await cv_tailor(stepCtx)
    expect(calls[0].system).toContain('R2: Led the card-authorization service')
    expect(calls[0].prompt).toContain('J2: Experience running Kubernetes in production.')
    expect(calls[0].prompt).toMatch(/BEGIN UNTRUSTED JOB POST/)
  })
})

describe('the prompt documents', () => {
  it('no longer state a length that contradicts a short honest letter', () => {
    for (const name of ['cv_tailor', '_voice']) {
      expect(readFileSync(join(process.cwd(), 'prompts', `${name}.md`), 'utf8'), name).not.toContain('300-420')
    }
  })

  it('state the tier lengths the checks enforce', () => {
    const doc = readFileSync(join(process.cwd(), 'prompts', 'cv_tailor.md'), 'utf8')
    expect(doc).toContain('250 to 350 words')
    expect(doc).toContain('150 to 250 words')
    expect(doc).toContain('90 to 160 words')
  })
})
