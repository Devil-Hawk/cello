import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'

const mocks = vi.hoisted(() => ({
  cvTailor: vi.fn(),
  optimize: vi.fn(),
  outreach: vi.fn(),
}))
vi.mock('@/lib/harness/agents/cv_tailor', () => ({ cv_tailor: mocks.cvTailor }))
vi.mock('@/lib/harness/agents/resume_optimizer', () => ({ optimizeResume: mocks.optimize }))
vi.mock('@/lib/harness/agents/outreach', () => ({ generateOutreachDraft: mocks.outreach, fallbackOutreachDraft: vi.fn() }))
vi.mock('@/lib/context/assemble', () => ({ buildOutreachContext: vi.fn(async () => 'RELATIONSHIP HISTORY: none recorded.') }))

import type { AgentContext } from '../context'
import { buildWriterGraph, runWriter, type WriterDeps } from './writer'
import { makeFakeAdmin, type FakeAdmin } from '../testing/fake-admin'
import { getArtifact } from '../artifacts'

const RESUME = 'Dana Lee\nSenior engineer at Acme, 2019 to 2024. Built the billing system and cut release time by 40%.\nPython, Postgres.'
const LETTER_SENTENCE = 'I built the billing system at Acme and cut release time by 40%.'
const letter = (sentences: number) => Array.from({ length: sentences }, () => LETTER_SENTENCE).join(' ')

function setup(over: Partial<AgentContext> = {}) {
  const admin: FakeAdmin = makeFakeAdmin(
    {
      profiles: [{ id: 'u1', resume_text: RESUME, full_name: 'Dana Lee' }],
      companies: [{ id: 'c1', user_id: 'u1', name: 'Stripe', domain: 'stripe.com' }],
      jobs: [{ id: 'j1', company_id: 'c1', title: 'Product Engineer', description: 'Build payments.', match_details: { highlights: ['Built billing at Acme'] } }],
      contacts: [{ id: 'k1', user_id: 'u1', name: 'Sam Rivera', title: 'Engineering Manager', email: 'sam@stripe.com' }],
    },
    { artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) } }
  )
  admin.rpcHandlers.artifact_add_version = async (args) => {
    const art = admin.tables.artifacts.find((r) => r.id === args.p_artifact_id)!
    art.current_version = (art.current_version as number) + 1
    admin.tables.artifact_versions.push({ artifact_id: art.id, version: art.current_version, author: args.p_author, content: args.p_content, content_text: args.p_content_text })
    return art.current_version
  }
  const ctx: AgentContext = {
    admin,
    userId: 'u1',
    userEmail: 'dana@example.com',
    apiKeys: { openrouter: 'k', userId: 'u1' },
    isDemo: false,
    threadId: 't1',
    conversationId: 'conv1',
    autonomy: 'ask',
    traceId: 'trace-1',
    deadlineAt: Date.now() + 60_000,
    ...over,
  }
  const judge = vi.fn(async () => ({ score: 0.9 }))
  const deps: WriterDeps = { ctx, llm: vi.fn() as never, judge }
  return { admin, ctx, deps, judge }
}

const tailorOut = (coverLetter: string) => ({ output: { jobId: 'j1', resumeSummary: 'Engineer.', coverLetter, keywords: ['billing'] }, tokensUsed: 0 })

beforeEach(() => {
  mocks.cvTailor.mockReset()
  mocks.optimize.mockReset()
  mocks.outreach.mockReset()
})

describe('Writer: cover letter', () => {
  it('writes, reviews and saves a draft artifact and sends nothing', async () => {
    const { deps, admin, judge } = setup()
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.status).toBe('ok')
    expect(result.review?.passed).toBe(true)
    expect(judge).toHaveBeenCalledTimes(1)
    const saved = await getArtifact(admin, 'u1', result.artifact_id!)
    expect(saved?.artifact).toMatchObject({ type: 'cover_letter', job_id: 'j1', company_id: 'c1', conversation_id: 'conv1' })
    expect(saved?.version.author).toBe('cello')
    expect((saved?.version.review as { passed: boolean }).passed).toBe(true)
    // Nothing outside artifacts was written.
    expect(Object.keys(admin.tables).sort()).toEqual(['artifact_versions', 'artifacts', 'companies', 'contacts', 'jobs', 'profiles'])
  })

  it('sends a failing draft back once with the issues, then saves the better one', async () => {
    const { deps } = setup()
    mocks.cvTailor.mockResolvedValueOnce(tailorOut(letter(5))).mockResolvedValueOnce(tailorOut(letter(25)))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(mocks.cvTailor).toHaveBeenCalledTimes(2)
    const second = mocks.cvTailor.mock.calls[1][0] as { input: { correctiveContext?: string } }
    expect(second.input.correctiveContext).toMatch(/words/)
    expect(result.status).toBe('ok')
  })

  it('after one revision a still-failing draft is saved with its issues, not hidden', async () => {
    const { deps, admin } = setup()
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(5)))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(mocks.cvTailor).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('needs_attention')
    expect(result.review?.issues.join(' ')).toMatch(/words/)
    expect(admin.tables.artifacts).toHaveLength(1)
  })

  it('a letter that claims what the resume does not is never saved when the tailor refuses twice', async () => {
    const { deps, admin } = setup()
    mocks.cvTailor.mockRejectedValue(new Error('cv_tailor: refused to return tailored content — the tailored text makes claims your resume does not support (Google)'))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/stays inside your resume/)
    expect(result.fix).toContain('Google')
    expect(admin.tables.artifacts ?? []).toHaveLength(0)
  })

  it('catches an unsupported claim in a draft the tailor let through', async () => {
    const { deps } = setup()
    const bad = `${letter(24)} I led the payments team at Google for ten years.`
    mocks.cvTailor.mockResolvedValue(tailorOut(bad))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.status).toBe('needs_attention')
    expect(result.review?.checks.find((c) => c.name === 'Claims match your resume')?.ok).toBe(false)
  })

  it('a judge that cannot run is skipped, not counted as a pass', async () => {
    const { deps } = setup()
    deps.judge = vi.fn(async () => {
      throw new Error('judge unavailable')
    })
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.review?.judge.status).toBe('skipped')
  })

  it('a judge that fails the draft sends it back', async () => {
    const { deps } = setup()
    deps.judge = vi.fn().mockResolvedValueOnce({ score: 0.1 }).mockResolvedValueOnce({ score: 0.8 })
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(mocks.cvTailor).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('ok')
  })
})

describe('Writer: briefs and refusals', () => {
  it('a cover letter needs a role and says how to get one', async () => {
    const { deps } = setup()
    const result = await runWriter(deps, { type: 'cover_letter' })
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.fix).toMatch(/find_roles/)
    expect(mocks.cvTailor).not.toHaveBeenCalled()
  })

  it('refuses a role that is not the persons', async () => {
    const { deps } = setup()
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'someone-elses' })
    expect(result.status).toBe('failed')
    expect(mocks.cvTailor).not.toHaveBeenCalled()
  })

  it('refuses without a resume', async () => {
    const { deps, admin } = setup()
    admin.tables.profiles[0].resume_text = ''
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.error).toMatch(/no resume/i)
  })

  it('refuses without a key and says where to add one', async () => {
    const { deps, ctx } = setup()
    ctx.apiKeys = {}
    const result = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    expect(result.error).toMatch(/OpenRouter/)
  })

  it('a retried call with the same key returns the first artifact and writes nothing new', async () => {
    const { deps, admin } = setup()
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const brief = { type: 'cover_letter' as const, job_id: 'j1', idempotency_key: 't1:call-7' }
    const first = await runWriter(deps, brief)
    const second = await runWriter(deps, brief)
    expect(second.artifact_id).toBe(first.artifact_id)
    expect(second.note).toMatch(/Already written/)
    expect(mocks.cvTailor).toHaveBeenCalledTimes(1)
    expect(admin.tables.artifacts).toHaveLength(1)
  })

  it('reached through the task tool, a text brief is parsed and a bad one is refused with the shape to use', async () => {
    const { deps } = setup()
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const graph = buildWriterGraph(deps)
    const good = await graph.invoke({ messages: [new HumanMessage('Brief: ```json\n{"type":"cover_letter","job_id":"j1"}\n```')] })
    expect(JSON.parse(String(good.messages.at(-1)?.content)).status).toBe('ok')
    const bad = await graph.invoke({ messages: [new HumanMessage('please write something nice')] })
    const parsed = JSON.parse(String(bad.messages.at(-1)?.content))
    expect(parsed.status).toBe('failed')
    expect(parsed.fix).toContain('"type":"cover_letter"')
  })
})

describe('Writer: outreach and revision', () => {
  it('writes an email to a contact with one ask and saves it with the recipient', async () => {
    const { deps, admin } = setup()
    mocks.outreach.mockResolvedValue({
      subject: 'Billing at Acme',
      body: 'Hi Sam, I built the billing system at Acme and cut release time by 40%. Could we talk for ten minutes about the Product Engineer role?',
      tokensUsed: 0,
    })
    const result = await runWriter(deps, { type: 'outreach_email', job_id: 'j1', contact_id: 'k1' })
    expect(result.status).toBe('ok')
    const saved = await getArtifact(admin, 'u1', result.artifact_id!)
    expect(saved?.artifact.contact_id).toBe('k1')
    expect(saved?.version.content_text).toContain('To: Sam Rivera <sam@stripe.com>')
    const call = mocks.outreach.mock.calls[0]
    expect(call[1]).toMatchObject({ contactName: 'Sam Rivera', kind: 'initial', userName: 'Dana Lee' })
    // The posting reaches the drafter framed as data.
    expect(String(call[1].jobDescription)).toContain('UNTRUSTED')
  })

  it('an email with two asks goes back once', async () => {
    const { deps } = setup()
    mocks.outreach
      .mockResolvedValueOnce({ subject: 's', body: 'Hi Sam, I built the billing system at Acme. Could we talk? Could you also send a referral?', tokensUsed: 0 })
      .mockResolvedValueOnce({ subject: 's', body: 'Hi Sam, I built the billing system at Acme and cut release time by 40%. I would value your view on how the team approaches billing reliability. Could we talk for ten minutes?', tokensUsed: 0 })
    const result = await runWriter(deps, { type: 'outreach_email', contact_id: 'k1' })
    expect(mocks.outreach).toHaveBeenCalledTimes(2)
    expect(String(mocks.outreach.mock.calls[1][1].correctiveContext)).toMatch(/asks 2 things/)
    expect(result.status).toBe('ok')
  })

  it('a banned phrase and an em dash are caught', async () => {
    const { deps } = setup()
    mocks.outreach.mockResolvedValue({ subject: 's', body: 'Hi Sam, I am excited to leverage my billing work at Acme — could we talk?', tokensUsed: 0 })
    const result = await runWriter(deps, { type: 'outreach_email', contact_id: 'k1' })
    expect(result.status).toBe('needs_attention')
    expect(result.review?.checks.find((c) => c.name === 'Plain wording')?.detail).toMatch(/leverage/)
  })

  it('a revision adds a new version to the same artifact with Cello as the author', async () => {
    const { deps, admin } = setup()
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(25)))
    const first = await runWriter(deps, { type: 'cover_letter', job_id: 'j1' })
    mocks.cvTailor.mockResolvedValue(tailorOut(letter(26)))
    const revised = await runWriter(deps, { type: 'cover_letter', artifact_id: first.artifact_id, instructions: 'Make it longer' })
    expect(revised.artifact_id).toBe(first.artifact_id)
    expect(revised.version).toBe(2)
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(admin.tables.artifact_versions).toHaveLength(2)
    expect(String((mocks.cvTailor.mock.calls[1][0] as { input: { correctiveContext?: string } }).input.correctiveContext)).toContain('Make it longer')
  })

  it('tailors a resume for a role', async () => {
    const { deps } = setup()
    const body = Array.from({ length: 30 }, () => 'Senior engineer at Acme built the billing system and cut release time by 40%.').join('\n')
    mocks.optimize.mockResolvedValue({ suggestedRewrite: body, rescore: { atsScore: 82 }, matchedKeywords: ['billing'], missingKeywords: [], formatIssues: [], atsScore: 70, tokensUsed: 0 })
    const result = await runWriter(deps, { type: 'resume', job_id: 'j1' })
    expect(result.status).toBe('ok')
    expect(result.type).toBe('resume')
  })
})
