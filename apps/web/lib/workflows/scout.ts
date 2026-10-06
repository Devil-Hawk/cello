// The Scout: which roles to show today. A workflow (K17), a fixed StateGraph over lib/scoring.
//
//   assess -> rank
//
//   assess   the hard facts the person stated (a role that breaks one is set aside with its reason, code),
//            then requirements, chance and want for what is left (assessRoles, cached per role)
//   rank     the shortlist: the likeliest, plus one exploration pick, saved for the day
//
// ponytail: filters, requirements, chance and want are one node. assessRoles keeps them together because they
// share one cache keyed by the resume and the stated preferences, and a role set aside by a stated fact is
// stored with its reason there. Split it when a step needs to run on its own.
//
// `roles.pick` reads this only while the `picks_live` flag is on (the shortlist measure S4 passes before
// it is switched on). With the flag off, or with no flag table at all, picks are not made.

import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { AdminClient } from '@/lib/harness/types'
import { assessRoles, type AssessResult, type PipelineDeps, type ShortlistRequest } from '@/lib/scoring/pipeline'
import { chooseShortlist, toPicks } from '@/lib/scoring/shortlist'
import type { ShortlistPick } from '@/lib/scoring/types'

const ScoutState = Annotation.Root({
  request: Annotation<ShortlistRequest>(),
  assessed: Annotation<AssessResult | null>(),
  picks: Annotation<ShortlistPick[]>(),
})

export interface ScoutResult extends AssessResult {
  picks: ShortlistPick[]
}

export function buildScoutGraph(deps: PipelineDeps) {
  return new StateGraph(ScoutState)
    .addNode('assess', async (s) => ({ assessed: await assessRoles(deps, s.request) }))
    .addNode('rank', async (s) => {
      const picks = toPicks(chooseShortlist(s.assessed!.rankables, { size: s.request.size ?? 6, exploreCount: s.request.exploreCount }))
      await deps.store.saveShortlist(s.request.userId, s.request.forDate, picks)
      return { picks }
    })
    .addEdge(START, 'assess')
    .addEdge('assess', 'rank')
    .addEdge('rank', END)
    .compile()
}

/** Runs the Scout for one person and day. */
export async function runScout(deps: PipelineDeps, request: ShortlistRequest): Promise<ScoutResult> {
  const out = await buildScoutGraph(deps).invoke({ request, assessed: null, picks: [] })
  const assessed = out.assessed as AssessResult
  return { ...assessed, picks: out.picks }
}

/** True only when the instance has switched the daily picks on. Absent flag table or row: off. */
export async function picksLive(admin: AdminClient): Promise<boolean> {
  try {
    const { data, error } = await admin.from('instance_flags').select('on').eq('key', 'picks_live').maybeSingle()
    return !error && (data as { on?: boolean } | null)?.on === true
  } catch {
    return false
  }
}
