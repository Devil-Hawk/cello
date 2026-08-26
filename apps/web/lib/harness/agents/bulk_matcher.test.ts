// Proves bulk_matcher's per-job outcome reporting — specifically the fix for
// the transcript defect ("score_jobs by explicit ids -> scored 0/3, 2 failed"
// with no explanation, on rows that turned out to have empty descriptions):
// a description-less job must still be SCORED from its title alone (never
// silently dropped), and the reported reason must say so in plain language
// rather than a bare "failed".
//
// Uses a REAL production row (id + title + empty description, captured
// read-only from the jobs table on 2026-07-28 — "Software Engineer, Machine
// Learning Infrastructure" has description = ''), driven through the actual
// runBulkMatch/runTier1 code path with a deterministic FAKE LlmRunner (no
// network, zero cost — this repo's tests never make a real LLM call) and an
// in-memory fake AdminClient (no network, zero DB writes — this never touches
// a real Supabase project, let alone the read-only production one).

import { describe, expect, it } from 'vitest'
import { runBulkMatch } from './bulk_matcher'
import { EMPTY_TARGETING } from '@/lib/targeting'
import type { AdminClient, LlmResult, LlmRunOptions } from '../types'

const REAL_COMPANY_ID = 'company-real-1'

// Real row, read-only snapshot from prod: id 430bfe78-b711-44ce-bbae-dc6af9d482fe.
const TITLE_ONLY_JOB = {
  id: '430bfe78-b711-44ce-bbae-dc6af9d482fe',
  company_id: REAL_COMPANY_ID,
  title: 'Software Engineer, Machine Learning Infrastructure',
  description: '', // real value — this row genuinely has no description on file
  location: 'Remote',
  url: 'https://example.com/job',
  is_new: true,
  match_score: null,
  posted_at: '2026-07-01T00:00:00Z',
  job_function: 'engineering',
  seniority: 'unknown',
  language: 'en',
  country: 'US',
  is_remote: true,
  quality_score: 82,
  companies: { name: 'Real Test Co' },
}

/** Minimal in-memory fake of the exact PostgREST chain shapes bulk_matcher's
 *  explicit-id path uses: fetchJobsByIds's ownedJobsQuery `.from('jobs')
 *  .select().eq('companies.user_id', ...).in('id', ...)` and persistScores's
 *  `.from('jobs').update().eq()`. Not a general Supabase mock — just enough
 *  surface for this one code path, so this stays a fake, not a
 *  reimplementation of the query builder.
 *
 *  eqCalls records every `.eq(col, value)` the query actually built, so a
 *  test can assert the ownership filter (`companies.user_id`) was really
 *  applied — not just that the query happened to return the right rows
 *  because the fixture only ever contains one company. */
function fakeAdmin(jobs: typeof TITLE_ONLY_JOB[]): {
  admin: AdminClient
  persisted: Map<string, { score: number; matchDetails: unknown }>
  eqCalls: [string, unknown][]
} {
  const persisted = new Map<string, { score: number; matchDetails: unknown }>()
  const eqCalls: [string, unknown][] = []

  function selectBuilder() {
    let idFilter: string[] | null = null
    const builder = {
      eq(col: string, value: unknown) {
        eqCalls.push([col, value])
        return builder
      },
      in(col: string, values: string[]) {
        if (col === 'id') idFilter = values
        return builder
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        const data = jobs.filter((j) => !idFilter || idFilter.includes(j.id))
        resolve({ data, error: null })
      },
    }
    return builder
  }

  function updateBuilder(patch: { match_score: number; match_details: unknown }) {
    const builder = {
      eq(_col: string, jobId: string) {
        persisted.set(jobId, { score: patch.match_score, matchDetails: patch.match_details })
        return builder
      },
      then(resolve: (v: { error: null }) => void) {
        resolve({ error: null })
      },
    }
    return builder
  }

  const admin = {
    from(_table: string) {
      return {
        select: () => selectBuilder(),
        update: (patch: { match_score: number; match_details: unknown }) => updateBuilder(patch),
      }
    },
  }
  return { admin: admin as unknown as AdminClient, persisted, eqCalls }
}

/** Deterministic tier-1-shaped fake LLM — no network, zero cost. Scores below
 *  the tier-2 threshold so this test stays focused on tier-1's titleOnly
 *  handling without also needing to fake scoreJobWithLlm's response shape. */
async function fakeLlm(opts: LlmRunOptions): Promise<LlmResult> {
  const content = JSON.stringify({
    scores: [{ id: 'j1', score: 42, reason: 'Relevant infra/ML background but seniority looks light for this role.' }],
  })
  void opts
  return { content, tokensUsed: 120, promptTokens: 100, completionTokens: 20, model: 'fake/test-model' }
}

describe('runBulkMatch — description-less jobs are scored, never silently failed', () => {
  it('scores a real title-only (empty-description) job from its title alone, with a reason that says so', async () => {
    const { admin, eqCalls } = fakeAdmin([TITLE_ONLY_JOB])
    const userId = 'user-real-1'

    const result = await runBulkMatch({
      admin,
      userId,
      companyIds: [REAL_COMPANY_ID],
      resume: 'Experienced backend engineer with Python, Kubernetes, and ML infrastructure background.',
      targeting: EMPTY_TARGETING,
      llm: fakeLlm,
      limit: 5,
      jobIds: [TITLE_ONLY_JOB.id],
    })

    // OWNERSHIP SCOPING: the explicit-id path must still scope through the
    // companies FK join (ownedJobsQuery), not trust the caller-supplied
    // jobIds alone — this is the query-shape half of the fix in the commit
    // that removed the .in('company_id', companyIds) array from this path.
    expect(eqCalls).toContainEqual(['companies.user_id', userId])

    // Never a bare "failed" — scored, not dropped, just because description is empty.
    expect(result.scored).toBe(1)
    expect(result.failed).toBe(0)

    expect(result.jobOutcomes).toHaveLength(1)
    const outcome = result.jobOutcomes[0]
    console.log('\nscore_jobs per-job outcome for a real description-less job:')
    console.log(`  jobId=${outcome.jobId} status=${outcome.status} tier=${outcome.tier} score=${outcome.score}`)
    console.log(`  reason: ${outcome.reason}`)

    expect(outcome.jobId).toBe(TITLE_ONLY_JOB.id)
    expect(outcome.status).toBe('scored')
    expect(outcome.tier).toBe(1)
    expect(outcome.score).toBe(42)
    expect(outcome.titleOnly).toBe(true)
    // The reason must be a concrete explanation, not a bare "failed" — and it
    // must explicitly disclose the lower-confidence, title-only basis.
    expect(outcome.reason).not.toMatch(/^failed$/i)
    expect(outcome.reason).toMatch(/title only/i)
    expect(outcome.reason).toMatch(/lower.confidence/i)
  })

  it('still reports the concrete model reason (not a generic message) for a job WITH a description', async () => {
    const jobWithDesc = {
      ...TITLE_ONLY_JOB,
      id: 'has-desc-job-1',
      description: 'Own our feature store and model-serving infrastructure end to end.',
    }
    const { admin } = fakeAdmin([jobWithDesc])

    const result = await runBulkMatch({
      admin,
      userId: 'user-real-1',
      companyIds: [REAL_COMPANY_ID],
      resume: 'Experienced backend engineer with Python, Kubernetes, and ML infrastructure background.',
      targeting: EMPTY_TARGETING,
      llm: fakeLlm,
      limit: 5,
      jobIds: [jobWithDesc.id],
    })

    const outcome = result.jobOutcomes[0]
    expect(outcome.status).toBe('scored')
    expect(outcome.titleOnly).toBe(false)
    expect(outcome.reason).not.toMatch(/title only/i)
    expect(outcome.reason).toBe('Relevant infra/ML background but seniority looks light for this role.')
  })
})
