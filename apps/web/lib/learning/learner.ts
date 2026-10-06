// `learning.update`: the nightly learner (agents-v3 5.3).
//
//   1. Outcomes. lib/strategy answers its questions over TRUSTED events only (below), and
//      code turns each answered one into a fixed-template statement, upserted by key.
//   2. Pass reasons, counted from the person's own reactions.
//   3. `taste:blend`, the count of past applications and reactions that order their roles.
//   4. At most one `learning.read` call over what the person wrote, stored `proposed`.
//
// Counts are facts from code and become active at once. A recount updates the numbers and
// never turns an `off` learning back on. A read is a proposal and acts on nothing until Keep.
//
// TRUST. A reply, rejection or stage event can be forged mail or a thread the classifier
// mislabelled, so it moves no count until its `trust` is person, proven or confirmed (K13's
// `pipeline_events.trust`). Until that column is on main, `trustedEvents` is not given and
// the outcome counts are not made at all: reactions and applications are the person's own
// and are the only counts this learner states. Nothing here ever prints "0 replies" from
// events it cannot trust.

import type { AdminClient } from '../harness/types'
import type { MemoryStore } from '../memory/types'
import { EMPTY_TARGETING } from '../targeting'
import { runStrategyAnalysis } from '../strategy'
import { createSupabaseStrategyDataSource, type ActivityRow, type StrategyDataSource } from '../strategy/datasource'
import { outcomeCounts, passReasonCounts, tasteBlendCount, type ReactionCount } from './effects'
import { runReadStep, type ReadResult, type ReadSource } from './read-step'
import { allLearnings, upsertCount, type CountInput } from './store'

export const TRUSTED = new Set(['person', 'proven', 'confirmed'])

export type TrustedActivity = ActivityRow & { trust: string }

export interface LearnerDeps {
  admin: AdminClient
  store?: MemoryStore
  /** The person's events with their trust. Absent until K13 is on main. */
  trustedEvents?: (userId: string) => Promise<TrustedActivity[]>
  /** Overrides the strategy data source (tests). */
  strategy?: StrategyDataSource
  /** Overrides the model read (tests). */
  read?: (userId: string, sources: ReadSource[]) => Promise<ReadResult>
}

export interface LearnerResult {
  counted: number
  /** Events left out of every count because they were not trusted. */
  untrusted: number
  read: ReadResult
}

/** Only events the person made, code proved or the person confirmed. Everything else is left out of every count. */
export const onlyTrusted = (events: readonly TrustedActivity[]): TrustedActivity[] => events.filter((e) => TRUSTED.has(e.trust))

interface ReactionRow extends ReactionCount {
  id: string
  note: string | null
}

async function loadReactions(admin: AdminClient, userId: string): Promise<ReactionRow[]> {
  const { data, error } = await admin.from('role_reactions').select('id, reaction, reason, surface, note').eq('user_id', userId).limit(5000)
  if (error) throw new Error(`could not read reactions: ${error.message}`)
  return (data as ReactionRow[] | null) ?? []
}

export async function runLearner(userId: string, deps: LearnerDeps): Promise<LearnerResult> {
  const { admin, store } = deps
  const counts: CountInput[] = []
  let untrusted = 0

  if (deps.trustedEvents) {
    const events = await deps.trustedEvents(userId)
    const trusted = onlyTrusted(events)
    untrusted = events.length - trusted.length
    // With no trusted event there is nothing to count: a rate over events that were all left out
    // would read as "0 replies".
    if (trusted.length > 0) {
      const base = deps.strategy ?? createSupabaseStrategyDataSource(admin, userId)
      const source: StrategyDataSource = {
        ...base,
        getActivities: async () => trusted,
        // The scope counts feed a question the learner does not use, and cost a scan of every job.
        getJobScopeCounts: async () => ({ totalJobs: 0, totalPassingAllConfiguredFilters: 0, jobsWithNoDescription: 0, excludedByDimension: {}, excludedByKeywords: null }),
      }
      // A "0 replies" group waits while any event is unconfirmed: the reply may be sitting in it.
      counts.push(...outcomeCounts(await runStrategyAnalysis(source, userId, EMPTY_TARGETING)).filter((c) => untrusted === 0 || c.params.replies !== 0))
    }
  }

  const reactions = await loadReactions(admin, userId)
  counts.push(...passReasonCounts(reactions))
  const blend = tasteBlendCount(reactions)
  if (blend) counts.push(blend)

  const known = await allLearnings(userId, store)
  for (const c of counts) await upsertCount(userId, c, store, known)

  const sources: ReadSource[] = reactions
    .filter((r) => r.note && r.note.trim().length >= 8)
    .slice(0, 40)
    .map((r) => ({ id: r.id, kind: 'note' as const, text: r.note as string }))
  const read = await (deps.read ?? ((u, s) => runReadStep(u, s, { store })))(userId, sources)

  return { counted: counts.length, untrusted, read }
}
