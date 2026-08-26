// Tests for lib/graph/unit.ts#runAgentUnit — the one agent contract for all
// 15 agents. lib/harness/registry.ts (UNIT_REGISTRY) and lib/harness/keys.ts
// (loadApiKeys) are mocked so this file exercises ONLY runAgentUnit's own
// contract (validation, fresh-runner-per-call, truncation-retry, containment
// attach, journaling) — never a real database or a real model. Same
// fake-PostgREST-chain style as lib/graph/journal.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, AgentFn, AgentResult } from '../harness/types'
import { STEP_AGENT_TYPES } from '../harness/schemas'
import { TruncatedResponseError } from '../harness/providers'

// --- mocks -------------------------------------------------------------------

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

const callLlmMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callLlm: (...args: unknown[]) => callLlmMock(...args) }
})

// Every unit type this file needs to control resolves through here — a
// controllable stand-in for the real UNIT_REGISTRY (lib/harness/registry.ts),
// so this file tests runAgentUnit's OWN behavior, never a real agent's DB
// reads/writes. Reassigned per test via `impls`.
const impls: Partial<Record<string, AgentFn>> = {}
vi.mock('../harness/registry', () => ({
  UNIT_REGISTRY: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        const fn = impls[prop]
        if (!fn) throw new Error(`unit.test.ts: no impl registered for unit type "${prop}"`)
        return fn
      },
    }
  ),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('../observability/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability/log')>()
  return { ...actual, logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args) }
})

const { runAgentUnit, MissingUserIdError } = await import('./unit')

// --- fake admin (same shape as lib/graph/journal.test.ts's FakeTable/FakeQuery) ---

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  constructor(private idField: string) {}
  nextId(): string {
    this.seq += 1
    return `${this.idField}-${this.seq}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; op: 'eq' | 'is'; val: unknown }[] = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null

  constructor(
    private table: FakeTable,
    private pk: string
  ) {}

  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val })
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, op: 'is', val })
    return this
  }
  insert(row: Record<string, unknown>) {
    this.mode = 'insert'
    this.insertRow = row
    return this
  }
  update(patch: Record<string, unknown>) {
    this.mode = 'update'
    this.patch = patch
    return this
  }
  private matches(row: Row): boolean {
    return this.filters.every(({ col, op, val }) => (op === 'is' && val === null ? row[col] == null : row[col] === val))
  }
  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      const row: Row = { [this.pk]: this.table.nextId(), ...this.insertRow }
      this.table.rows.push(row)
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      const matched = this.table.rows.filter((r) => this.matches(r))
      for (const r of matched) Object.assign(r, this.patch)
      return { data: matched, error: null }
    }
    return { data: this.table.rows.filter((r) => this.matches(r)), error: null }
  }
  async maybeSingle() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  async single() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }
}

function makeFakeAdmin(resumeText = '') {
  const tables = {
    trace_spans: new FakeTable('span_id'),
    agent_runs: new FakeTable('id'),
    profiles: new FakeTable('id'),
  }
  tables.profiles.rows.push({ id: 'user-1', resume_text: resumeText })
  // journal.ts resolves a new step row's user_id off its agent_runs row
  // (trace_spans.user_id is NOT NULL) — baseConfig below always runs as
  // 'run-1', so that's the one row every test needs seeded.
  tables.agent_runs.rows.push({ id: 'run-1', user_id: 'user-1' })
  const admin = {
    from: (name: string) => {
      const table = (tables as Record<string, FakeTable>)[name]
      if (!table) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(table, name === 'trace_spans' ? 'span_id' : 'id')
    },
  } as unknown as AdminClient
  return { admin, tables }
}

function baseConfig(userId: string) {
  return { configurable: { userId, runId: 'run-1', threadId: 'thread-1' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(impls)) delete impls[k]
  loadApiKeysMock.mockResolvedValue({ userId: 'user-1', provider: { active: 'openrouter' } })
})

// -----------------------------------------------------------------------------

describe('runAgentUnit — userId is required', () => {
  it('throws MissingUserIdError when config.configurable.userId is absent', async () => {
    const { admin } = makeFakeAdmin()
    impls.follow_upper = async () => ({ output: { message: 'hi', suggestedContacts: [] }, tokensUsed: 0 })
    await expect(runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('') })).rejects.toThrow(
      MissingUserIdError
    )
    expect(loadApiKeysMock).not.toHaveBeenCalled()
  })
})

describe('runAgentUnit — fresh LlmRunner per call', () => {
  it('calls loadApiKeys once per runAgentUnit invocation, never cached', async () => {
    const { admin } = makeFakeAdmin()
    impls.follow_upper = async () => ({ output: { message: 'hi', suggestedContacts: [] }, tokensUsed: 0 })

    await runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })
    await runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })

    expect(loadApiKeysMock).toHaveBeenCalledTimes(2)
  })
})

describe('runAgentUnit — shared truncation-retry policy', () => {
  it('retries once with doubled maxTokens on TruncatedResponseError, then succeeds', async () => {
    const { admin } = makeFakeAdmin()
    callLlmMock
      .mockRejectedValueOnce(new TruncatedResponseError(100, 100))
      .mockResolvedValueOnce({ content: 'ok', tokensUsed: 5, promptTokens: 3, completionTokens: 2, model: 'x' })

    impls.follow_upper = async (ctx) => {
      const res = await ctx.llm({ prompt: 'p', maxTokens: 100 })
      return { output: { message: res.content, suggestedContacts: [] }, tokensUsed: res.tokensUsed }
    }

    const result = await runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })
    expect(result.output).toEqual({ message: 'ok', suggestedContacts: [] })
    expect(callLlmMock).toHaveBeenCalledTimes(2)
    expect(callLlmMock.mock.calls[1][1]).toMatchObject({ maxTokens: 200 })
  })

  it('retries exactly once — a second truncation still surfaces to the caller', async () => {
    const { admin } = makeFakeAdmin()
    callLlmMock.mockRejectedValue(new TruncatedResponseError(100, 100))
    impls.follow_upper = async (ctx) => {
      const res = await ctx.llm({ prompt: 'p', maxTokens: 100 })
      return { output: { message: res.content, suggestedContacts: [] }, tokensUsed: 0 }
    }

    await expect(runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })).rejects.toThrow(
      TruncatedResponseError
    )
    expect(callLlmMock).toHaveBeenCalledTimes(2) // one attempt + exactly one retry, never more
  })
})

describe('runAgentUnit — journaling always finishes, even when the failure happens AFTER fn(stepCtx) resolves', () => {
  it('journals the step as failed (not left stuck at "running") when schema.output.parse rejects the agent output', async () => {
    const { admin, tables } = makeFakeAdmin()
    impls.sourcer = async () => ({ output: { totally: 'wrong shape' } as unknown, tokensUsed: 3 }) as unknown as AgentResult

    await expect(runAgentUnit('sourcer', { input: {}, admin, config: baseConfig('user-1') })).rejects.toThrow()

    const row = tables.trace_spans.rows.find((r) => r.name === 'sourcer')
    expect((row?.attributes as Record<string, unknown> | undefined)?.stepStatus).toBe('failed')
    expect(row?.end_time).toBeTruthy()
  })

  it('journals the step as failed when the containment path itself throws (e.g. resolveResumeText\'s DB call rejects)', async () => {
    const { admin, tables } = makeFakeAdmin('Software engineer with five years of experience.')
    const realFrom = admin.from.bind(admin)
    ;(admin as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      if (name === 'profiles') throw new Error('profiles lookup exploded')
      return realFrom(name)
    }
    // cv_tailor's own input carries no resumeText, so runAgentUnit must fall
    // back to the profiles read that is about to blow up.
    const { input, output } = fixtureFor('cv_tailor')
    impls.cv_tailor = async () => output

    await expect(runAgentUnit('cv_tailor', { input, admin, config: baseConfig('user-1') })).rejects.toThrow(
      'profiles lookup exploded'
    )

    const row = tables.trace_spans.rows.find((r) => r.name === 'cv_tailor')
    expect((row?.attributes as Record<string, unknown> | undefined)?.stepStatus).toBe('failed')
    expect(row?.end_time).toBeTruthy()
  })
})

describe('STEP_AGENT_TYPES stays exactly the current 10 (planner-emittable set, unchanged by the graph port)', () => {
  it('matches the pre-port list exactly', () => {
    expect([...STEP_AGENT_TYPES]).toEqual([
      'sourcer',
      'matcher',
      'enricher',
      'cv_tailor',
      'applier',
      'verifier',
      'follow_upper',
      'interview_prep',
      'company_researcher',
      'contact_sourcer',
    ])
  })
})

// -----------------------------------------------------------------------------
// Containment: detect, attach, never gate (ruling 2)
// -----------------------------------------------------------------------------

const CONTENT_UNIT_TYPES = ['cv_tailor', 'resume_optimizer', 'outreach', 'follow_upper'] as const

/** Minimal, schema-valid input/output pair per content-authoring unit type,
 *  each carrying a claim the resume below never supports. */
function fixtureFor(unitType: (typeof CONTENT_UNIT_TYPES)[number]): { input: unknown; output: AgentResult } {
  switch (unitType) {
    case 'cv_tailor':
      return {
        input: { jobId: 'job-1' },
        output: {
          output: {
            jobId: 'job-1',
            resumeSummary: 'Senior engineer.',
            // Borrowed from the fabrication-eval corpus's own attack shape
            // (lib/evals/fabrication.eval.test.ts / fabrication.golden.json —
            // a fabricated credential/employer the source never supported):
            // "I hold an active security clearance and spent ten years at Google."
            coverLetter: 'I hold an active security clearance and spent ten years at Google.',
            keywords: [],
          },
          tokensUsed: 0,
        },
      }
    case 'resume_optimizer':
      return {
        input: { resumeText: 'Software engineer with five years of experience.', job: { title: 'Engineer' } },
        output: {
          output: {
            atsScore: 80,
            missingKeywords: [],
            formatIssues: [],
            matchedKeywords: [],
            suggestedRewrite: 'I earned a PhD in Computer Science from MIT.',
            rescore: { atsScore: 80, missingKeywords: [], formatIssues: [], matchedKeywords: [] },
            tokensUsed: 0,
          },
          tokensUsed: 0,
        },
      }
    case 'outreach':
      return {
        input: { userName: 'Jane', userEmail: 'jane@example.com', jobTitle: 'Engineer', companyName: 'Acme' },
        output: {
          output: { subject: 'Re: Engineer role', body: 'I was previously the CTO of Meta.', tokensUsed: 0 },
          tokensUsed: 0,
        },
      }
    case 'follow_upper':
      return {
        input: {},
        output: { output: { message: 'Following up — I have a PhD from MIT.', suggestedContacts: [] }, tokensUsed: 0 },
      }
  }
}

describe('runAgentUnit — containment is attached for the four content-authoring unit types', () => {
  it.each(CONTENT_UNIT_TYPES)('%s: result carries containment, and a failing report is returned, never thrown', async (unitType) => {
    const { input, output } = fixtureFor(unitType)
    const { admin } = makeFakeAdmin('Software engineer with five years of experience.')
    impls[unitType] = async () => output

    const result = await runAgentUnit(unitType, { input, admin, config: baseConfig('user-1') })

    expect(result.containment).toBeDefined()
    expect(result.containment!.ok).toBe(false)
    expect(result.containment!.unsupported.length).toBeGreaterThan(0)
  })

  it('a clean draft (nothing the resume does not already say) reports ok:true', async () => {
    const { admin } = makeFakeAdmin('Senior engineer with strong Python experience.')
    impls.follow_upper = async () => ({
      output: { message: 'Following up on your Python engineering roles.', suggestedContacts: [] },
      tokensUsed: 0,
    })

    const result = await runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })
    expect(result.containment!.ok).toBe(true)
    expect(result.containment!.unsupported).toEqual([])
  })

  it('a unit type outside the content-authoring set carries no containment field at all', async () => {
    const { admin } = makeFakeAdmin()
    impls.sourcer = async () => ({ output: { jobIds: [], found: 0, inserted: 0 }, tokensUsed: 0 })
    const result = await runAgentUnit('sourcer', { input: {}, admin, config: baseConfig('user-1') })
    expect('containment' in result).toBe(false)
  })
})

// Mutation check for ruling 2 (spec item 3: "remove the containment call in
// an in-memory copy → test red"), executed against the REAL source, not a
// hand-written stand-in:
//
//   Edited apps/web/lib/graph/unit.ts, replacing the containment computation
//   block inside the try{} with `const containment:
//   TailoringContainmentReport | undefined = undefined`, then ran
//   `pnpm -F @cello/web test -- --run lib/graph/unit.test.ts`.
//
//   Result: 6 failures — the four `it.each(CONTENT_UNIT_TYPES)` cases plus
//   the clean-draft ok:true case in the "containment is attached" describe
//   block above (each hits `expect(result.containment).toBeDefined()`), and
//   "journals the step as failed when the containment path itself throws"
//   in the "journaling always finishes" describe block further above (with
//   the computation deleted, resolveResumeText's mocked-to-throw profiles
//   read is never reached, so the call resolves instead of rejecting). Zero
//   failures elsewhere. Reverted the file immediately after (`git diff
//   --stat` empty).
//
// That confirms those two describe blocks already ARE the mutation-sensitive
// tests for ruling 2 — both call the real runAgentUnit (not a stand-in
// copy) and go red the moment the attach line is deleted. No separate
// decorative "mutation" test is added here: one that doesn't exercise
// lib/graph/unit.ts's own source proves nothing about it, and duplicating
// the same assertions under a different describe name would only pretend to
// add coverage that already exists above.

describe('runAgentUnit — operator-visible failure logging', () => {
  it('routes a genuine agent failure through logHarnessError before rethrowing', async () => {
    const { admin } = makeFakeAdmin()
    impls.follow_upper = async () => {
      throw new Error('provider exploded')
    }

    await expect(runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })).rejects.toThrow(
      'provider exploded'
    )
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx, err] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>, Error]
    expect(ctx.agentType).toBe('follow_upper')
    expect(ctx.phase).toBe('unit')
    expect(err.message).toBe('provider exploded')
  })

  it('does NOT log expected control-flow stops (spend cap) as errors, per docs/OBSERVABILITY.md', async () => {
    const { admin } = makeFakeAdmin()
    const { BudgetCapError } = await import('../harness/spend')
    impls.follow_upper = async () => {
      throw new BudgetCapError(10, 10)
    }

    await expect(runAgentUnit('follow_upper', { input: {}, admin, config: baseConfig('user-1') })).rejects.toThrow(
      BudgetCapError
    )
    expect(logHarnessErrorMock).not.toHaveBeenCalled()
  })
})
