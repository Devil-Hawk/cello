// After a user's companies are checked: read the requirements of the postings
// the parser could not split, with a free model, once each.
//
// The parser already ran on every row at ingest (lib/ats/index.ts). What is
// left are postings with enough text and no requirements section. Those get at
// most one model read until their description changes (a changed description is
// re-parsed, which drops model_checked_at). The model's allowance is shared
// with page reading, which goes first.

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '../ats/concurrency'
import { completeRequirements } from '../jobs/requirements-model'
import { RequirementsSchema, parseRequirements, type Requirements } from '../jobs/requirements'
import type { ModelBudget, ModelCall } from './model'

type Db = SupabaseClient<any, any, any>

export interface PendingJob {
  id: string
  title: string
  description: string
  location: string | null
  salaryRange: string | null
  requirements: unknown
}

export interface RequirementsRows {
  /** Open postings of the user's companies with a description of 400+ characters, an unresolved requirements record and no model read, newest first. */
  pending(limit: number): Promise<PendingJob[]>
  save(id: string, requirements: Requirements): Promise<void>
}

const MIN_DESCRIPTION_CHARS = 400
const CONCURRENCY = 3

export function supabaseRequirementsRows(db: Db, userId: string, dryRun = false): RequirementsRows {
  return {
    async pending(limit) {
      const { data, error } = await db
        .from('jobs')
        .select('id, title, description, location, salary_range, requirements, companies!inner(user_id)')
        .eq('companies.user_id', userId)
        .eq('requirements->>skills_resolved', 'false')
        .is('requirements->>model_checked_at', null)
        .or('still_open.is.null,still_open.eq.true')
        // 400 underscores then %: matches a description of at least 400 characters.
        .like('description', `${'_'.repeat(MIN_DESCRIPTION_CHARS)}%`)
        .order('requirements_extracted_at', { ascending: false, nullsFirst: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        location: (r.location as string | null) ?? null,
        salaryRange: (r.salary_range as string | null) ?? null,
        requirements: r.requirements,
      }))
    },
    async save(id, requirements) {
      if (dryRun) return
      const { error } = await db
        .from('jobs')
        .update({ requirements, requirements_extracted_at: new Date().toISOString() } as never)
        .eq('id', id)
      if (error) throw new Error(error.message)
    },
  }
}

export interface RequirementsPassResult {
  /** Postings a model read this pass. */
  read: number
  /** Of those, the ones that now have skill lists. */
  resolved: number
  /** True when the allowance ran out before the list did. */
  limited: boolean
}

export async function runRequirementsPass(
  rows: RequirementsRows,
  call: ModelCall,
  budget: ModelBudget
): Promise<RequirementsPassResult> {
  const out: RequirementsPassResult = { read: 0, resolved: 0, limited: false }
  if (budget.n <= 0) {
    out.limited = true
    return out
  }
  let pending: PendingJob[]
  try {
    pending = await rows.pending(budget.n)
  } catch {
    return out
  }

  await mapWithConcurrency(pending, CONCURRENCY, async (job) => {
    if (budget.n <= 0) {
      out.limited = true
      return
    }
    const parsed = RequirementsSchema.safeParse(job.requirements)
    const base = parsed.success
      ? parsed.data
      : parseRequirements({ title: job.title, description: job.description, location: job.location, salaryRange: job.salaryRange })
    const next = await completeRequirements(base, { title: job.title, description: job.description }, call)
    if (!next.model_checked_at) return
    out.read++
    if (next.skills_resolved && !base.skills_resolved) out.resolved++
    try {
      await rows.save(job.id, next)
    } catch {
      /* the next pass reads it again */
    }
  })
  if (budget.hit) out.limited = true
  return out
}
