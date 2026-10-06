// Agent: bulk_matcher. Assesses a batch of roles for one person in one pass, for
// the "check my unassessed roles" actions and the copilot.
//
// It used to triage every role with a 0-100 score and re-score the promising ones.
// There is no score any more. A batch now goes through the same assessment as
// everything else (lib/scoring): roles that break a stated fact are filtered with
// the reason, the rest are judged on what the person wants and on their chance
// against the resume, each requirement checked on a cited line. A role that could
// not be assessed this time stays unassessed, so the next call picks it up again.

import type { AdminClient, DecryptedApiKeys, LlmRunner } from '../types'
import { scoreJobBatch, type AssessedJobResult } from './matcher'

export interface BulkMatchOptions {
  admin: AdminClient
  userId: string
  llm: LlmRunner
  /** Max roles to assess this call. */
  limit: number
  /** Overrides the account's default model when set. */
  model?: string
  /** Explicit ids to assess instead of the newest unassessed roles. */
  jobIds?: string[]
  /** Lets the taste similarity use an embedding provider. */
  apiKeys?: DecryptedApiKeys
}

export interface JobScoreOutcome {
  jobId: string
  /** assessed: want and chance recorded. blocked: filtered, with the stated fact it breaks. not-assessed: tried, will be retried. */
  status: 'assessed' | 'blocked' | 'not-assessed'
  chance: AssessedJobResult['chance']
  /** Always a concrete explanation, never a bare "failed". */
  reason: string
  /** True when the posting had no description on file, so the chance cannot be checked yet. */
  titleOnly: boolean
}

export interface BulkMatchResult {
  /** Roles with a recorded verdict (assessed or filtered). */
  scored: number
  /** Roles attempted that got no verdict this time. */
  failed: number
  candidatesConsidered: number
  skippedReasons: Record<string, number>
  /** Assessment passes made. */
  batches: number
  tokensUsed: number
  jobOutcomes: JobScoreOutcome[]
}

function withModel(llm: LlmRunner, model: string | undefined): LlmRunner {
  if (!model) return llm
  return (opts) => llm({ ...opts, model: opts.model ?? model })
}

/** Assesses up to `limit` roles. Never throws on a model failure; the reason is in the result. */
export async function runBulkMatch(opts: BulkMatchOptions): Promise<BulkMatchResult> {
  const batch = await scoreJobBatch({
    admin: opts.admin,
    userId: opts.userId,
    llm: withModel(opts.llm, opts.model),
    limit: opts.limit,
    jobIds: opts.jobIds,
    apiKeys: opts.apiKeys,
  })
  if (batch.skippedReason && batch.scored.length === 0) {
    return { scored: 0, failed: batch.failedCount, candidatesConsidered: batch.candidatesConsidered, skippedReasons: { [batch.skippedReason]: 1 }, batches: 0, tokensUsed: 0, jobOutcomes: [] }
  }
  const jobOutcomes: JobScoreOutcome[] = batch.scored.map((s) => {
    if (s.blocked.length > 0) return { jobId: s.jobId, status: 'blocked', chance: null, reason: s.blocked[0], titleOnly: false }
    const thin = s.chance === 'cannot_assess'
    return {
      jobId: s.jobId,
      status: 'assessed',
      chance: s.chance,
      reason: thin ? 'The posting does not list requirements yet, so the chance cannot be checked.' : (s.wantReason ?? 'Assessed.'),
      titleOnly: thin,
    }
  })
  return {
    scored: batch.scored.length,
    failed: batch.failedCount,
    candidatesConsidered: batch.candidatesConsidered,
    skippedReasons: batch.skippedReason ? { [batch.skippedReason]: 1 } : {},
    batches: 1,
    tokensUsed: 0, // metered per call through the runner
    jobOutcomes,
  }
}
