// Sourcing for the Scout: ask every job source at once, four at a time.
//
// The Scout's first step. Each source (themuse, remoteok, ycombinator and the
// rest of lib/sources) is one branch of a bounded fan-out: its own time cap, its
// own result, and one slow or broken source never sinks the others. What the
// sources return then goes through the same filters the existing sourcer uses
// (role intent, the person's hard exclusions) and the same ingest, so a role
// found here is the same row a role found by the old path would be.
//
// When the first pass is thin, the same broadening steps the sourcer uses run in
// order (adjacent titles, then location, then seniority), and the open web
// search is the last resort. The steps and filters are the sourcer's own,
// imported, not copied.

import { ingestLeads, queryAllSources, sourceAdapters, type JobLead, type SourceId } from '@/lib/sources'
import { sanitizeLeads } from '@/lib/sources/util'
import { resolveTargeting } from '@/lib/targeting'
import { keywordsForIntent, resolveRoleIntent } from '@/lib/jobs/role-taxonomy'
import { discoverJobsViaWebSearch } from '@/lib/search/job-discovery'
import {
  BROADEN_STEP_ORDER,
  buildKeywords,
  filterForIntent,
  mergeKeywords,
  planBroadenStep,
  readLocationPrefs,
  violatesHardExclusions,
  type BroadenState,
} from '@/lib/harness/agents/sourcer'
import type { AdminClient } from '@/lib/harness/types'
import { fanOut, type BranchEvent, type FanOutResult } from './fanout'

/** One source gets this long. */
export const SOURCE_BRANCH_MS = 20_000

export interface SourceRolesInput {
  admin: AdminClient
  userId: string
  query?: string
  /** How many roles to aim for. */
  limit: number
  signal?: AbortSignal
  deadlineAt: number
  onBranch?: (event: BranchEvent<SourceId, JobLead[]>) => void | Promise<void>
}

export interface SourceRolesResult {
  jobIds: string[]
  found: number
  inserted: number
  perSource: Record<string, { found: number; error?: string }>
  counts: FanOutResult<unknown>['counts']
  /** What happened, one line per step, in the person's terms. */
  notes: string[]
}

export async function sourceRoles(input: SourceRolesInput): Promise<SourceRolesResult> {
  const { data: profile } = await input.admin.from('profiles').select('resume_text, preferences').eq('id', input.userId).single()
  const resume = (profile?.resume_text as string | null) ?? null
  const baseTargeting = resolveTargeting(profile?.preferences)
  const { locations, remote } = readLocationPrefs(profile?.preferences)

  const intent = resolveRoleIntent(input.query)
  const resumeKeywords = buildKeywords(input.query, resume)
  let keywords = intent ? mergeKeywords([...keywordsForIntent(intent)], resumeKeywords) : resumeKeywords

  const jobIds = new Set<string>()
  const perSource: SourceRolesResult['perSource'] = {}
  const counts = { ok: 0, partial: 0, failed: 0 }
  const notes: string[] = []
  let found = 0
  let inserted = 0

  async function round(label: string, state: BroadenState): Promise<void> {
    const perSourceLimit = Math.min(60, Math.max(10, Math.ceil((input.limit * 1.5) / sourceAdapters.length)))
    const out = await fanOut<SourceId, JobLead[]>({
      items: sourceAdapters.map((a) => a.id),
      caps: { steps: 1, ms: SOURCE_BRANCH_MS, tokens: 0 },
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      onBranch: input.onBranch,
      worker: async (id, branch) => {
        const { leads } = await queryAllSources(
          { keywords, locations, remote, targeting: state.targeting, signal: branch.signal },
          { only: [id], totalLimit: perSourceLimit }
        )
        return leads
      },
    })
    counts.ok += out.counts.ok
    counts.partial += out.counts.partial
    counts.failed += out.counts.failed
    const merged: JobLead[] = []
    out.results.forEach((r, i) => {
      const id = sourceAdapters[i].id
      const prior = perSource[id]
      perSource[id] = { found: (prior?.found ?? 0) + (r.value?.length ?? 0), error: r.status === 'failed' ? r.error : prior?.error }
      merged.push(...(r.value ?? []))
    })
    const clean = sanitizeLeads(merged, state.targeting)
    const kept = filterForIntent(clean, intent, state.allowAdjacent).filter((l) => !violatesHardExclusions(l, baseTargeting))
    const ingest = await ingestLeads(input.admin, input.userId, kept)
    found += ingest.found
    inserted += ingest.inserted
    const before = jobIds.size
    for (const id of ingest.jobIds) jobIds.add(id)
    notes.push(`${label}: ${merged.length} found, ${kept.length} fit, ${jobIds.size - before} new to you`)
  }

  let state: BroadenState = { targeting: baseTargeting, allowAdjacent: false }
  await round('Searched the job sources', state)

  for (const stepId of BROADEN_STEP_ORDER) {
    if (jobIds.size >= input.limit || Date.now() >= input.deadlineAt || input.signal?.aborted) break
    const plan = planBroadenStep(stepId, state, intent)
    if (!plan.applicable) continue
    state = plan.next
    if (stepId === 'adjacent-titles' && intent) {
      keywords = mergeKeywords([...keywordsForIntent(intent, { includeAdjacent: true })], resumeKeywords)
    }
    await round(`Widened the search (${plan.describe})`, state)
  }

  if (jobIds.size < input.limit && Date.now() < input.deadlineAt && !input.signal?.aborted) {
    const web = await discoverJobsViaWebSearch({
      intent,
      query: input.query,
      targeting: state.targeting,
      limit: input.limit - jobIds.size,
      signal: input.signal,
      userId: input.userId,
      admin: input.admin,
    })
    if (web.leads.length > 0) {
      const clean = sanitizeLeads(web.leads, state.targeting)
      const kept = filterForIntent(clean, intent, state.allowAdjacent).filter((l) => !violatesHardExclusions(l, baseTargeting))
      const ingest = await ingestLeads(input.admin, input.userId, kept)
      found += ingest.found
      inserted += ingest.inserted
      for (const id of ingest.jobIds) jobIds.add(id)
      notes.push(`Searched the open web: ${kept.length} verified postings`)
    }
  }

  return { jobIds: [...jobIds], found, inserted, perSource, counts, notes }
}
