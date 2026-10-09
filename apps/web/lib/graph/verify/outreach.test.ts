// reviewOutreachDraft: the deterministic checks, the claims judge, the specificity
// judge and the ONE regeneration that names what to fix. The writer and the
// judges are faked, so these tests are about the control flow and what the
// judges are shown, not about a model.

import { describe, expect, it, vi } from 'vitest'
import type { LlmRunner } from '../../harness/types'
import type { OutreachDraftInput, OutreachDraftResult } from '../../harness/agents/outreach'
import { MissingKeyError } from '../../harness/providers'
import { BudgetCapError } from '../../harness/spend'
import { reviewOutreachDraft, type ReviewDeps } from './outreach'

const input: OutreachDraftInput = {
  userName: 'Marcus Delgado',
  userEmail: 'marcus@example.com',
  jobTitle: 'Senior Backend Engineer',
  companyName: 'Ramp',
  contactName: 'Jane Park',
  resumeText: 'Marcus Delgado\nDesigned an idempotent double-entry ledger that cut reconciliation breaks by 92%\nMentor 4 engineers',
  jobDescription: 'You will own the ledger that records every payout.\nWe run Go and Kafka.',
  kind: 'initial',
}

const GOOD = [
  'Hi Jane,',
  '',
  'The post says this role owns the ledger that records every payout. I designed an idempotent double-entry ledger that cut reconciliation breaks by 92%, which is why Ramp caught my eye.',
  '',
  'Would you be open to a short chat?',
  '',
  'Thanks,',
  'Marcus Delgado',
].join('\n')

const draft = (body = GOOD, over: Partial<OutreachDraftResult> = {}): OutreachDraftResult => ({
  subject: 'Senior Backend Engineer at Ramp',
  body,
  tokensUsed: 20,
  source: 'model',
  ...over,
})

const ok = (text: string, source: string) => ({ claims: [{ text, about: 'sender', source, status: 'supported' }] })
const specificOk = { specific: true, detail: 'ledger that records every payout', source: 'J1', why: 'ties to J1' }

function runner(answer: unknown | ((prompt: string) => unknown)): { run: LlmRunner; prompts: string[] } {
  const prompts: string[] = []
  const run: LlmRunner = async (opts) => {
    prompts.push(opts.prompt ?? '')
    const a = typeof answer === 'function' ? (answer as (p: string) => unknown)(opts.prompt ?? '') : answer
    return { content: JSON.stringify(a), tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'judge' }
  }
  return { run, prompts }
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps & { claims: ReturnType<typeof runner>; specificity: ReturnType<typeof runner> } {
  const claims = runner(ok('I designed an idempotent double-entry ledger', 'R2'))
  const specificity = runner(specificOk)
  return {
    generate: async () => draft(),
    claimsRun: claims.run,
    specificityRun: specificity.run,
    ...over,
    claims,
    specificity,
  }
}

describe('a draft that passes', () => {
  it('is returned unchanged with both verdicts and no regeneration', async () => {
    const generate = vi.fn(async () => draft())
    const d = deps({ generate })
    const review = await reviewOutreachDraft(d, input, draft())
    expect(generate).not.toHaveBeenCalled()
    expect(review.body).toBe(GOOD)
    expect(review.failed).toBe(false)
    expect(review.verdicts.map((v) => [v.name, v.verdict])).toEqual([
      ['groundedness', 'pass'],
      ['specificity', 'pass'],
    ])
    expect(review.checks.ok).toBe(true)
  })

  it('shows the specificity judge the job text, not just the title', async () => {
    const d = deps()
    await reviewOutreachDraft(d, input, draft())
    expect(d.specificity.prompts[0]).toContain('J1: You will own the ledger that records every payout.')
    expect(d.specificity.prompts[0]).toContain('Senior Backend Engineer, Ramp')
  })

  it('shows the claims judge the same numbered resume the writer saw', async () => {
    const d = deps()
    await reviewOutreachDraft(d, input, draft())
    expect(d.claims.prompts[0]).toContain('R2: Designed an idempotent double-entry ledger that cut reconciliation breaks by 92%')
  })
})

describe('an unsupported claim', () => {
  const bad = GOOD.replace('I designed', 'I led a team of 8 and designed')
  const unsupported = { claims: [{ text: 'I led a team of 8', about: 'sender', source: null, status: 'unsupported' }] }

  it('triggers one regeneration whose corrective text quotes the claim', async () => {
    const generate = vi.fn(async (_i: OutreachDraftInput) => draft())
    const claims = runner((prompt: string) => (prompt.includes('led a team of 8') ? unsupported : ok('I designed an idempotent double-entry ledger', 'R2')))
    const review = await reviewOutreachDraft(deps({ generate, claimsRun: claims.run }), input, draft(bad))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0].correctiveContext).toContain('1. Remove or rewrite "I led a team of 8".')
    expect(review.body).toBe(GOOD)
    expect(review.failed).toBe(false)
    expect(review.tokensUsed).toBe(40)
  })

  it('keeps the original when the regeneration is worse', async () => {
    const worse = GOOD.replace('Thanks,', 'Happy to send my resume too. Could you also introduce me?\n\nThanks,')
    const generate = vi.fn(async () => draft(worse))
    const claims = runner(unsupported)
    const review = await reviewOutreachDraft(deps({ generate, claimsRun: claims.run }), input, draft(bad))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(review.body).toBe(bad)
    expect(review.failed).toBe(true)
  })
})

describe('a failing deterministic check', () => {
  it('triggers a regeneration when there are two asks', async () => {
    const twoAsks = GOOD.replace('Thanks,', 'Could you also introduce me to the team?\n\nThanks,')
    const generate = vi.fn(async (_i: OutreachDraftInput) => draft())
    const review = await reviewOutreachDraft(deps({ generate }), input, draft(twoAsks))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0].correctiveContext).toContain('2 asks. Keep one so the reply is easy.')
    expect(review.body).toBe(GOOD)
  })

  it('names the sign-off when the draft is signed with something else', async () => {
    const generate = vi.fn(async (_i: OutreachDraftInput) => draft())
    await reviewOutreachDraft(deps({ generate }), input, draft(GOOD.replace('Marcus Delgado', 'mdelgado')))
    expect(generate.mock.calls[0][0].correctiveContext).toContain('Signed "mdelgado", not your name "Marcus Delgado".')
  })
})

describe('the standard template', () => {
  const template = draft('Hi Jane,\n\nI am interested in the Senior Backend Engineer role at Ramp. Would you be open to a short chat?\n\nThanks,\nMarcus Delgado', {
    tokensUsed: 0,
    source: 'template',
    templateReason: 'missing_key',
  })

  it('is checked by code only: no judge runs and nothing is regenerated', async () => {
    const generate = vi.fn()
    const d = deps({ generate })
    const review = await reviewOutreachDraft(d, input, template)
    expect(generate).not.toHaveBeenCalled()
    expect(d.claims.prompts).toEqual([])
    expect(review).toMatchObject({ source: 'template', templateReason: 'missing_key', verdicts: [] })
    expect(review.checks.ok).toBe(true)
  })

  it('never replaces a model draft when the regeneration falls back to it', async () => {
    const twoAsks = GOOD.replace('Thanks,', 'Could you also introduce me to the team?\n\nThanks,')
    const review = await reviewOutreachDraft(deps({ generate: async () => template }), input, draft(twoAsks))
    expect(review.body).toBe(twoAsks)
    expect(review.source).toBe('model')
  })
})

describe('when the judges cannot run', () => {
  it.each([
    ['a missing key', new MissingKeyError(), 'missing-key'],
    ['the spending cap', new BudgetCapError(10, 10), 'budget-cap'],
  ] as const)('reports %s as a typed refusal with no verdicts, and still returns the draft', async (_l, err, refused) => {
    const throwing: LlmRunner = async () => {
      throw err
    }
    const review = await reviewOutreachDraft(deps({ claimsRun: throwing, specificityRun: throwing }), input, draft())
    expect(review).toMatchObject({ body: GOOD, verdicts: [], judgeRefused: refused, judgeUnavailable: false })
  })

  it('logs an unexpected judge error and returns the draft, unjudged', async () => {
    const onError = vi.fn()
    const throwing: LlmRunner = async () => {
      throw new Error('402 payment required')
    }
    const review = await reviewOutreachDraft(deps({ claimsRun: throwing }), input, draft(), onError)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(review).toMatchObject({ body: GOOD, verdicts: [], judgeUnavailable: true })
  })
})
