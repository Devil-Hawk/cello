// Agent: strategist — turns outcome data (applications/activities/
// resume_documents/outreach_messages) plus the user's targeting preferences
// into (1) honestly-gated ANSWERS to the eight strategy questions in
// lib/strategy/questions/*.ts and (2) plain-language PROPOSED campaign
// changes for the user to approve. See lib/strategy/index.ts's module doc for
// the full honesty contract — this file is a thin AgentFn wrapper around
// runStrategyAnalysis(), it contains no analysis logic of its own.
//
// WIRED (lib/graph/unit.ts#runAgentUnit's UNIT_REGISTRY, lib/harness/
// registry.ts): 'strategist' is in AGENT_TYPES and lib/harness/schemas.ts's
// agentSchemas map — StrategistInput/StrategistOutput now live there (this
// file imports them back) so every AgentFn's schema lives in the same place.
// It is deliberately NOT in STEP_AGENT_TYPES — the planner may still not emit
// a bare 'strategist' DAG step; it is callable only as a direct unit, the same
// way app/api/strategy/route.ts calls runStrategyAnalysis directly. Both
// paths share the same core, so they can never drift out of sync — the
// contact_sourcer / /api/contacts/source pattern this note is copied from.
//
// SAFETY: this agent only ever READS applications/activities/resume_documents/
// outreach_messages/jobs/companies/profiles and returns proposals as DATA.
// It never writes to profiles.preferences.targeting, resume_documents, or any
// other table, and it never sends anything — turning a proposal into an
// actual applied change stays a separate, human-gated step (a future
// /api/strategy/proposals/:id/approve route, owned by whichever workstream
// wires the UI up, not this one). See lib/strategy/proposals.ts's module doc.

import type { AgentFn } from '../types'
import { StrategistInput, StrategistOutput } from '../schemas'
import { runStrategyAnalysis } from '../../strategy'
import { createSupabaseStrategyDataSource } from '../../strategy/datasource'
import { buildSyntheticFixture } from '../../strategy/fixtures'
import { resolveTargeting } from '../../targeting'

export { StrategistInput, StrategistOutput }

export const strategist: AgentFn = async (ctx) => {
  const input = StrategistInput.parse(ctx.input ?? {})

  let targeting = resolveTargeting({})
  if (!input.useSyntheticDemo) {
    const { data: profile, error } = await ctx.admin.from('profiles').select('preferences').eq('id', ctx.userId).single()
    if (error) console.error('[strategy] strategist: profile fetch failed', error)
    targeting = resolveTargeting(profile?.preferences ?? {})
  }

  const dataSource = input.useSyntheticDemo ? buildSyntheticFixture() : createSupabaseStrategyDataSource(ctx.admin, ctx.userId)
  const report = await runStrategyAnalysis(dataSource, ctx.userId, targeting)

  return { output: report, tokensUsed: 0 }
}
