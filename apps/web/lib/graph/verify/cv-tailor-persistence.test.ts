// Full-stack proof of ruling 2 (langgraph port design doc, Step 4) through
// the REAL call chain: lib/graph/autopilot.ts's real, unmocked
// prepareApplicationDraft calling the REAL, unmocked verifyCvTailorDraft
// (lib/graph/verify/cv-tailor.ts). Only the lowest-level dependencies are
// faked: runAgentUnit (cv_tailor/applier), claimsFor/matchClaim, loadApiKeys,
// the judge, and the admin client itself — the two behaviors the brief names
// are asserted directly against a fake application_drafts table:
//
//   (a) "fabricated-output fixture through the graph → ZERO application_
//       drafts rows" — a containment failure that survives the bounded
//       retry loop.
//   (b) a persistent judge failure persists WITH content, status 'failed',
//       a verdict attached — NEVER 'pending_review'.
//
// This is the file the brief's two MUTATION checks target:
//   (a) delete the containment-fail branch in cv-tailor.ts → the first test
//       below goes red (application_drafts gains a row).
//   (b) change the judge-failure branch in autopilot.ts to leave status
//       'pending_review' instead of overriding to 'failed' → the second test
//       below goes red.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TailoringContainmentReport } from '../../security/job-text'

// --- fake admin: jobs / profiles / application_drafts / eval_verdicts ------

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; val: unknown }[] = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null

  constructor(
    private table: FakeTable,
    private pk: string
  ) {}

  select() {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val })
    return this
  }
  update(patch: Record<string, unknown>) {
    this.mode = 'update'
    this.patch = patch
    return this
  }
  insert(row: Record<string, unknown>) {
    this.mode = 'insert'
    this.insertRow = row
    return this
  }
  private matches(row: Row): boolean {
    return this.filters.every(({ col, val }) => row[col] === val)
  }
  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      const row: Row = { [this.pk]: this.table.nextId(this.pk), ...this.insertRow }
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
  async single() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }
}

let tables: Record<string, FakeTable>
function freshAdmin() {
  tables = { jobs: new FakeTable(), profiles: new FakeTable(), application_drafts: new FakeTable(), eval_verdicts: new FakeTable() }
  tables.jobs.rows.push({ id: 'job-1', title: 'Staff Engineer', description: 'Build things.', companies: { name: 'Acme' } })
  tables.profiles.rows.push({ id: 'user-1', resume_text: 'Senior engineer with 8 years of Go.' })
  return {
    from: (name: string) => {
      const t = tables[name]
      if (!t) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(t, 'id')
    },
  }
}

vi.mock('../../harness/supabase-admin', () => ({ createAdminClient: () => freshAdmin() }))

// --- runAgentUnit: cv_tailor + applier, faked at the lowest level ----------

let cvTailorImpl: () => { output: { resumeSummary: string; coverLetter: string; keywords: string[] }; tokensUsed: number; containment: TailoringContainmentReport }
const runAgentUnitMock = vi.fn(async (unitType: string, _ctx?: unknown) => {
  if (unitType === 'cv_tailor') return cvTailorImpl()
  if (unitType === 'applier') {
    // The REAL applier always creates a 'pending_review' handoff draft for a
    // non-submitting call — reproduced minimally here since applier itself
    // is not under test in this file (lib/harness/agents/applier.ts has its
    // own tests).
    const draftId = tables.application_drafts.nextId('draft')
    tables.application_drafts.rows.push({ id: draftId, status: 'pending_review' })
    return { output: { draftId, status: 'pending_review', submissionRef: null }, tokensUsed: 8 }
  }
  throw new Error(`unexpected unit type ${unitType}`)
})
vi.mock('../unit', () => ({ runAgentUnit: (unitType: string, ctx: unknown) => runAgentUnitMock(unitType, ctx) }))

vi.mock('../../resume/claims', () => ({ claimsFor: async () => [], matchClaim: () => [] }))
vi.mock('../../harness/keys', () => ({ loadApiKeys: async () => ({ openrouter: 'fake-key' }) }))

let judgeImpl: () => { verdict: 'pass' | 'fail'; score: number; threshold: number; n: number; summary: string; name: string }
vi.mock('../../evals/judge', () => ({
  meteredJudgeClient: vi.fn(() => ({})),
  judgeGroundedness: () => judgeImpl(),
}))

const { prepareApplicationDraft } = await import('../autopilot')

const okContainment = { ok: true, unsupported: [], reason: null } as unknown as TailoringContainmentReport
const failContainment = { ok: false, unsupported: [], reason: 'invents a security clearance' } as unknown as TailoringContainmentReport
const content = { resumeSummary: 'Tailored.', coverLetter: 'Dear team,', keywords: [] as string[] }

function unitConfig() {
  return { configurable: { userId: 'user-1', runId: 'run-1', threadId: 't-1' } }
}

beforeEach(() => {
  runAgentUnitMock.mockClear()
})

describe('ruling 2a — FAIL WITHOUT PERSIST', () => {
  it('a fabricated-output fixture (containment fails every attempt) leaves ZERO application_drafts rows', async () => {
    cvTailorImpl = () => ({ output: content, tokensUsed: 5, containment: failContainment })
    freshAdmin() // seed `tables` before prepareApplicationDraft mints its own via the mocked createAdminClient

    const result = await prepareApplicationDraft(unitConfig(), true, 'job-1')

    expect(result.status).toBe('failed')
    expect(tables.application_drafts.rows).toHaveLength(0)
    expect(runAgentUnitMock).not.toHaveBeenCalledWith('applier', expect.anything())
  })
})

describe('ruling 2c — a persistent judge failure persists status "failed", never "pending_review"', () => {
  it('persists the draft WITH content, status overridden to failed, and a verdict attached', async () => {
    cvTailorImpl = () => ({ output: content, tokensUsed: 5, containment: okContainment })
    judgeImpl = () => ({ name: 'outreach groundedness', verdict: 'fail', score: 0.1, threshold: 0.5, n: 1, summary: 'ungrounded' })
    freshAdmin()

    const result = await prepareApplicationDraft(unitConfig(), true, 'job-1')

    expect(result.status).toBe('failed')
    expect(tables.application_drafts.rows).toHaveLength(1)
    expect(tables.application_drafts.rows[0].status).toBe('failed')
    expect(tables.application_drafts.rows[0].status).not.toBe('pending_review')
    const verdictRows = tables.eval_verdicts.rows
    expect(verdictRows).toHaveLength(1)
    expect(verdictRows[0]).toMatchObject({ subject_kind: 'cv_tailor_draft', judge: 'factuality', verdict: 'fail' })
  })
})

describe('ruling 2 — the happy path still persists pending_review normally', () => {
  it('containment + judge both pass: one draft, status pending_review, no flag', async () => {
    cvTailorImpl = () => ({ output: content, tokensUsed: 5, containment: okContainment })
    judgeImpl = () => ({ name: 'outreach groundedness', verdict: 'pass', score: 0.9, threshold: 0.5, n: 1, summary: 'grounded' })
    freshAdmin()

    const result = await prepareApplicationDraft(unitConfig(), true, 'job-1')

    expect(result.status).toBe('drafted')
    expect(tables.application_drafts.rows).toHaveLength(1)
    expect(tables.application_drafts.rows[0].status).toBe('pending_review')
    expect(tables.eval_verdicts.rows).toHaveLength(0)
  })
})
