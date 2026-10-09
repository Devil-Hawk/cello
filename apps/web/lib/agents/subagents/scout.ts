// The Scout: find roles and say which fit, and why, in the person's terms.
//
//   sources -> rank -> save
//
// sources asks every job source at once, four at a time (lib/agents/sources.ts).
// rank is the scoring seam: hard filters on what the person stated, an assessment of
// roles that have none yet, and the ordering with one labelled exploration slot. It is
// one call (scoring-port.shortlistFor) so the scoring package can fill it in without
// touching this graph. save keeps the shortlist as an artifact.
//
// The Scout reads text other people wrote (job posts), so it holds no tool that sends,
// submits or writes the person's profile. It hands back schema-shaped picks and a
// short reason per role, never posting text.

import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph'
import type { CompiledSubAgent } from 'deepagents'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import { createArtifact } from '../artifacts'
import { ARTIFACT_WRITE_TYPES } from '../backends'
import type { AgentContext } from '../context'
import { summarizeCounts } from '../fanout'
import { shortlistFor, type RolePick } from '../scoring-port'
import { sourceRoles, type SourceRolesResult } from '../sources'
import { branchRecorder, finishTask, retitleTask, startTask, type TaskScope } from '../tasks'
import { activity, asSubAgentRunnable, invokeSpecialist, lastHumanText, parseBrief, summaryMessage, type Fix } from './common'

export const ScoutBriefSchema = z.object({
  query: z.string().max(200).optional(),
  location: z.string().max(80).optional(),
  remote: z.boolean().optional(),
  dream_only: z.boolean().optional(),
  /** Go and look for new postings now. Delegated work defaults to true. */
  fresh: z.boolean().default(true),
  limit: z.number().int().min(1).max(15).default(8),
  idempotency_key: z.string().max(160).optional(),
})
export type ScoutBrief = z.input<typeof ScoutBriefSchema>

export const SCOUT_BRIEF_SHAPE = '{"query":"product manager Seattle","limit":8}'

export interface ScoutPick {
  id: string
  title: string | null
  company: string | null
  chance: RolePick['chance']
  reason: string
  exploration: boolean
}

export interface ScoutResult {
  status: 'ok' | 'partial' | 'failed'
  artifact_id?: string
  picks?: ScoutPick[]
  /** What the sources turned up, in plain words. */
  sourced?: { found: number; inserted: number; summary: string }
  assessed_now?: number
  error?: string
  fix?: string
  note?: string
}

export interface ScoutDeps {
  ctx: AgentContext
}

const ScoutState = Annotation.Root({
  ...MessagesAnnotation.spec,
  brief: Annotation<z.output<typeof ScoutBriefSchema> | null>(),
  sourced: Annotation<SourceRolesResult | null>(),
  picks: Annotation<{ picks: RolePick[]; pool: number; assessedNow: number; skippedReason?: string } | null>(),
  result: Annotation<ScoutResult | null>(),
})
type State = typeof ScoutState.State

const fail = (f: Fix): ScoutResult => ({ status: 'failed', error: f.error, fix: f.fix })

export const toScoutPick = (p: RolePick): ScoutPick => ({
  id: p.jobId,
  title: p.title,
  company: p.company,
  chance: p.chance,
  reason: p.reason,
  exploration: p.exploration,
})

export function buildScoutGraph(deps: ScoutDeps) {
  const { ctx } = deps
  const scope: TaskScope = {
    admin: ctx.admin,
    userId: ctx.userId,
    threadId: ctx.threadId,
    conversationId: ctx.conversationId,
    scheduledTaskId: ctx.scheduledTaskId,
    traceId: ctx.traceId,
  }

  async function intake(state: State) {
    if (state.brief) return {}
    const parsed = parseBrief(ScoutBriefSchema, lastHumanText(state.messages) || '{}', SCOUT_BRIEF_SHAPE)
    if (!parsed.ok || !parsed.brief) return { result: fail({ error: parsed.error ?? 'The brief was not usable.', fix: `Delegate again with a JSON brief like ${SCOUT_BRIEF_SHAPE}.` }) }
    return { brief: parsed.brief }
  }

  async function sources(state: State, config: RunnableConfig) {
    const brief = state.brief!
    if (!brief.fresh) return { sourced: null }
    activity(config, 'Searching the job boards')
    const parent = await startTask(scope, { agent: 'scout', title: 'Searching the job boards', parentId: ctx.rootTaskId ?? null })
    try {
      const out = await sourceRoles({
        admin: ctx.admin,
        userId: ctx.userId,
        query: brief.query,
        limit: Math.max(brief.limit * 3, 20),
        signal: config?.signal ?? ctx.signal,
        deadlineAt: ctx.deadlineAt,
        onBranch: branchRecorder(scope, parent, 'scout', (id: string) => `Searching ${id}`),
      })
      const title = summarizeCounts('Searching', { one: 'source', many: 'sources' }, out.counts.ok + out.counts.partial + out.counts.failed, out.counts)
      await retitleTask(ctx.admin, parent, title)
      await finishTask(ctx.admin, parent, {
        status: out.counts.failed + out.counts.partial > 0 ? 'partial' : 'done',
        partialReason: out.counts.partial > 0 ? 'time' : null,
        summary: out.notes.join('. '),
      })
      return { sourced: out }
    } catch (e) {
      await finishTask(ctx.admin, parent, { status: 'failed', summary: e instanceof Error ? e.message : String(e) })
      // Sourcing failing does not stop the Scout: what is already tracked can still be ranked.
      return { sourced: null }
    }
  }

  async function rank(state: State, config: RunnableConfig) {
    const brief = state.brief!
    activity(config, 'Ranking roles against your resume')
    const out = await shortlistFor({
      admin: ctx.admin,
      userId: ctx.userId,
      apiKeys: ctx.apiKeys,
      limit: brief.limit,
      query: brief.query,
      location: brief.location,
      remoteOnly: brief.remote,
      dreamOnly: brief.dream_only,
      // Assess a few unassessed roles that made the pool; each is a model call.
      assessMissing: brief.fresh ? 6 : 0,
      signal: config?.signal ?? ctx.signal,
    })
    return { picks: out }
  }

  async function save(state: State, config: RunnableConfig) {
    const { brief, picks, sourced } = state
    if (!brief || !picks) return {}
    if (!ARTIFACT_WRITE_TYPES.scout.includes('shortlist')) return {}
    const found = sourced ? { found: sourced.found, inserted: sourced.inserted, summary: sourced.notes.join('. ') } : undefined
    if (picks.picks.length === 0) {
      return {
        result: {
          status: 'ok' as const,
          picks: [],
          ...(found ? { sourced: found } : {}),
          note: brief.fresh
            ? 'Nothing new matched. Try a broader title or location, or ask what the person would accept.'
            : 'Nothing tracked matches. Search for new roles with fresh set to true.',
        },
      }
    }
    activity(config, 'Saving the shortlist')
    const ref = await createArtifact(ctx.admin, {
      userId: ctx.userId,
      type: 'shortlist',
      title: brief.query ? `Roles for ${brief.query}` : 'Shortlist',
      content: {
        items: picks.picks.map((p) => ({
          job_id: p.jobId,
          title: p.title,
          company: p.company,
          reason: p.reason,
          chance: p.chance,
          gaps: p.gaps,
          exploration: p.exploration,
        })),
        generated_at: new Date().toISOString(),
        note: picks.skippedReason ? `Some roles were not assessed (${picks.skippedReason}).` : null,
      },
      author: 'cello',
      conversationId: ctx.conversationId,
      idempotencyKey: brief.idempotency_key,
      traceId: ctx.traceId,
    })
    const partial = Boolean(sourced && sourced.counts.failed + sourced.counts.partial > 0) || Boolean(picks.skippedReason)
    const result: ScoutResult = {
      status: partial ? 'partial' : 'ok',
      artifact_id: ref.id,
      picks: picks.picks.map(toScoutPick),
      assessed_now: picks.assessedNow,
      ...(found ? { sourced: found } : {}),
      ...(partial ? { note: 'Some sources or assessments did not finish. Say so when you report the roles.' } : {}),
    }
    return { result }
  }

  function respond(state: State) {
    const result = state.result ?? fail({ error: 'The scout did not produce a result.', fix: 'Try again.' })
    return { messages: [summaryMessage(result as unknown as Record<string, unknown>)], result }
  }

  return new StateGraph(ScoutState)
    .addNode('intake', intake)
    .addNode('sources', sources)
    .addNode('rank', rank)
    .addNode('save', save)
    .addNode('respond', respond)
    .addEdge(START, 'intake')
    .addConditionalEdges('intake', (s) => (s.result ? 'respond' : 'sources'), ['sources', 'respond'])
    .addEdge('sources', 'rank')
    .addEdge('rank', 'save')
    .addEdge('save', 'respond')
    .addEdge('respond', END)
    .compile()
}

export async function runScout(deps: ScoutDeps, brief: ScoutBrief, config?: RunnableConfig): Promise<ScoutResult> {
  const parsed = ScoutBriefSchema.parse(brief)
  const out = await invokeSpecialist(buildScoutGraph(deps), { brief: parsed, messages: [] }, config)
  return (out.result as ScoutResult | null) ?? fail({ error: 'The scout did not produce a result.', fix: 'Try again.' })
}

export const SCOUT_DESCRIPTION =
  'Finds roles: asks every job source, drops what the person ruled out, and ranks the rest with a one-sentence reason and a Strong, Possible or Stretch label. ' +
  `Use it for one list of roles. Pass the description as a JSON brief like ${SCOUT_BRIEF_SHAPE}. ` +
  'Returns a short JSON summary with the picks and a saved shortlist artifact. It never contacts anyone.'

export function scoutSubAgent(deps: ScoutDeps): CompiledSubAgent {
  return { name: 'scout', description: SCOUT_DESCRIPTION, runnable: asSubAgentRunnable(buildScoutGraph(deps) as never) }
}
