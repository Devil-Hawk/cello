// Tests for lib/harness/agents/application_follow_up.ts: the drafted message,
// its template fallback and the contacts on file. The timing rule itself is
// tested in lib/pipeline/follow-up.test.ts.
//
// Same zero-network, zero-DB fake-admin style as
// lib/harness/agents/analyst.test.ts: the unit is driven directly with a
// fake AdminClient and a fake ctx.llm, never a real database or model.

import { describe, expect, it } from 'vitest'
import { application_follow_up } from './application_follow_up'
import type { AdminClient, LlmResult, LlmRunOptions, StepContext } from '../types'

interface ApplicationFixture {
  id: string
  stage: string
  applied_at: string | null
  updated_at: string
  job_id: string | null
}

interface FollowUpOutputShape {
  applicationId: string
  suggestion: string
  suggestedContacts?: string[]
  draftMessage?: string
}

const DEFAULT_APPLICATION: ApplicationFixture = {
  id: 'app-1',
  stage: 'applied',
  applied_at: null,
  updated_at: new Date().toISOString(),
  job_id: 'job-1',
}
const JOB_ROW = { id: 'job-1', title: 'Senior Backend Engineer', company_id: 'company-1' }
const COMPANY_ROW = { name: 'Acme Corp' }
const PROFILE_ROW = { full_name: 'John Doe' }
const CONTACTS_ROWS = [{ name: 'Jane Smith' }]

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

interface FakeAdminOpts {
  application?: ApplicationFixture | null
  job?: typeof JOB_ROW | null
  company?: typeof COMPANY_ROW | null
  contacts?: typeof CONTACTS_ROWS
}

/** Minimal fake of the exact PostgREST chain shapes application_follow_up.ts issues:
 *  single-row `.eq(...).single()` lookups against applications/jobs/
 *  companies/profiles, and a plain (no `.single()`) `.eq(...).eq(...)` list
 *  read against contacts. */
function fakeAdmin(opts: FakeAdminOpts = {}): AdminClient {
  const application = 'application' in opts ? opts.application : DEFAULT_APPLICATION
  const job = 'job' in opts ? opts.job : JOB_ROW
  const company = 'company' in opts ? opts.company : COMPANY_ROW
  const contacts = opts.contacts ?? CONTACTS_ROWS

  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => {
          if (table === 'applications') {
            return application ? { data: application, error: null } : { data: null, error: { message: 'no row' } }
          }
          if (table === 'jobs') return { data: job, error: null }
          if (table === 'companies') return { data: company, error: null }
          if (table === 'profiles') return { data: PROFILE_ROW, error: null }
          throw new Error(`fakeAdmin: unexpected single() on table "${table}"`)
        },
        then(resolve: (v: { data: unknown; error: null }) => void) {
          if (table === 'contacts') return resolve({ data: contacts, error: null })
          throw new Error(`fakeAdmin: unexpected list read on table "${table}"`)
        },
      }
      return builder
    },
  } as unknown as AdminClient
}

function ctxWith(llm: (opts: LlmRunOptions) => Promise<LlmResult>, adminOpts?: FakeAdminOpts): StepContext {
  return {
    userId: 'user-1',
    runId: 'run-1',
    stepLabel: 'application_follow_up',
    agentType: 'application_follow_up',
    input: { applicationId: 'app-1' },
    deps: {},
    admin: fakeAdmin(adminOpts),
    apiKeys: {},
    llm,
    signal: new AbortController().signal,
  } as StepContext
}

function stubLlm(content: string): (opts: LlmRunOptions) => Promise<LlmResult> {
  return async () => ({ content, tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: 'stub' })
}

function throwingLlm(error: unknown): (opts: LlmRunOptions) => Promise<LlmResult> {
  return async () => {
    throw error
  }
}

async function runFollowUp(llm: (opts: LlmRunOptions) => Promise<LlmResult>, adminOpts?: FakeAdminOpts): Promise<FollowUpOutputShape> {
  const result = await application_follow_up(ctxWith(llm, adminOpts))
  return result.output as FollowUpOutputShape
}

describe('follow-up timing', () => {
  it('suggests a follow-up once the stage minimum has elapsed', async () => {
    const output = await runFollowUp(stubLlm('Hi, following up on my application...'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(6), stage: 'applied' },
    })
    expect(output.suggestion).toContain('6 days')
    expect(output.suggestion.toLowerCase()).toContain('follow up')
    expect(output.draftMessage).toBeDefined()
  })

  it('is too soon before the stage minimum', async () => {
    const output = await runFollowUp(stubLlm('unused'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(3), stage: 'applied' },
    })
    expect(output.suggestion).toContain('too soon')
    expect(output.draftMessage).toBeUndefined()
  })

  it('still suggests contacts on file even when it is too soon to follow up', async () => {
    const output = await runFollowUp(stubLlm('unused'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(3), stage: 'applied' },
    })
    expect(output.suggestion).toContain('too soon')
    expect(output.suggestedContacts).toContain('Jane Smith')
  })

  it('treats an application that was never marked applied as not yet due', async () => {
    const output = await runFollowUp(stubLlm('unused'), {
      application: { ...DEFAULT_APPLICATION, applied_at: null, stage: 'applied' },
    })
    expect(output.suggestion).toContain('too soon')
  })

  it('has no follow-up at a stage outside the follow-up set', async () => {
    const output = await runFollowUp(stubLlm('unused'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(30), stage: 'rejected' },
    })
    expect(output.suggestion).toBe('No follow-up action needed at this stage.')
    expect(output.draftMessage).toBeUndefined()
  })

  it('gives an offer-specific suggestion at the offer stage', async () => {
    const output = await runFollowUp(stubLlm('Following up on the offer...'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(3), stage: 'offer' },
    })
    expect(output.suggestion.toLowerCase()).toContain('offer')
  })

  it('picks a thank-you message within the interview window, addressed to the model', async () => {
    let capturedSystem: string | undefined
    let capturedPrompt: string | undefined
    const output = await runFollowUp(
      async (opts) => {
        capturedSystem = opts.system
        capturedPrompt = opts.prompt
        return { content: 'Dear Jane, thank you...', tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: 'stub' }
      },
      { application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(2), stage: 'interview' } }
    )
    expect(output.draftMessage).toBe('Dear Jane, thank you...')
    expect(capturedSystem).toContain('professional messages')
    expect(capturedPrompt).toContain('thank you email')
    // The chain-of-thought block is part of the actual prompt sent to the
    // model, not decoration, every prompt builder embeds it.
    expect(capturedPrompt).toContain('## REASONING PROCESS')
    expect(capturedPrompt).toContain('<think>')
  })
})

describe('drafted message', () => {
  it('drafts via the metered llm when a follow-up is due', async () => {
    const output = await runFollowUp(stubLlm('Hi Jane, following up on my application...'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(6) },
    })
    expect(output.draftMessage).toBe('Hi Jane, following up on my application...')
  })

  it('falls back to the deterministic template when the model call fails', async () => {
    const output = await runFollowUp(throwingLlm(new Error('rate limited')), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(6) },
    })
    expect(output.draftMessage).toContain('Dear Hiring Manager')
  })

  it('suggests contacts at the company when any are on file', async () => {
    const output = await runFollowUp(stubLlm('Hi there'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(6) },
    })
    expect(output.suggestedContacts).toContain('Jane Smith')
  })

  it('omits suggestedContacts when none are on file', async () => {
    const output = await runFollowUp(stubLlm('Hi there'), {
      application: { ...DEFAULT_APPLICATION, applied_at: daysAgo(6) },
      contacts: [],
    })
    expect(output.suggestedContacts).toBeUndefined()
  })
})

describe('a missing application is a typed failure, not a silent 500', () => {
  it('throws when the application does not exist for this user', async () => {
    await expect(application_follow_up(ctxWith(stubLlm('unused'), { application: null }))).rejects.toThrow(/not found/)
  })
})
