// find_roles, get_role and triage_role: finding roles, reading one, and saying how the person feels about it.

import { z } from 'zod'
import { scoreTrace } from '@/lib/observability/langfuse'
import { recordReaction, roleView, shortlistFor, type RolePick } from '../scoring-port'
import { runScout } from '../subagents/scout'
import { clip, defineTool, keyFor, readFields, toolFix, writeFields, type CelloTool } from './common'

function shape(p: RolePick, detailed: boolean) {
  return {
    id: p.jobId,
    title: p.title,
    company: p.company,
    chance: p.chance,
    reason: p.reason,
    ...(p.exploration ? { exploration: true } : {}),
    ...(detailed ? { company_id: p.companyId, location: p.location, posted_at: p.postedAt, link: p.url, gaps: p.gaps } : {}),
  }
}

export const findRoles = defineTool({
  name: 'find_roles',
  description:
    'Find and rank roles for the person. With fresh false (the default) it ranks roles already tracked. With fresh true it first searches the job boards, ' +
    'which can take up to a minute. Each role has a one-sentence reason and a chance of Strong, Possible or Stretch, or "Not assessed yet" when it has not been judged. ' +
    'Use it for "find me roles" and "what should I look at today". To read one role use get_role. To record how the person feels about a role use triage_role.',
  schema: z.object({
    query: z.string().max(200).optional().describe('What to look for, for example "product manager Seattle". Leave out to rank everything tracked.'),
    filters: z
      .object({
        location: z.string().max(80).optional().describe('Only roles whose location contains this text.'),
        remote: z.boolean().optional().describe('Only remote roles.'),
        dream_only: z.boolean().optional().describe('Only roles at companies the person marked as dream companies.'),
      })
      .optional()
      .describe('Narrow the roles. Leave out for no filter.'),
    fresh: z.boolean().default(false).describe('True to search the job boards for new roles now. False to rank what is already tracked.'),
    ...readFields,
    ...writeFields,
  }),
  kind: 'read',
  untrusted: true,
  mcp: true,
  async handler(ctx, a, meta) {
    const detailed = a.response_format === 'detailed'
    if (a.fresh) {
      const out = await runScout(
        { ctx },
        { query: a.query, location: a.filters?.location, remote: a.filters?.remote, dream_only: a.filters?.dream_only, fresh: true, limit: Math.min(a.limit, 15), idempotency_key: keyFor(ctx, meta, a.idempotency_key) },
        meta.config
      )
      if (out.status === 'failed') return toolFix(out.error ?? 'Could not search for roles.', out.fix ?? 'Try again.')
      const ids = new Set((out.picks ?? []).map((p) => p.id))
      // The Scout's summary is compact; detailed adds the stored fields for the same roles.
      const detail = detailed && ids.size > 0 ? await shortlistFor({ admin: ctx.admin, userId: ctx.userId, apiKeys: ctx.apiKeys, limit: 25, query: a.query, assessMissing: 0 }) : null
      const byId = new Map((detail?.picks ?? []).map((p) => [p.jobId, p]))
      return {
        count: out.picks?.length ?? 0,
        roles: (out.picks ?? []).map((p) => (byId.get(p.id) ? shape(byId.get(p.id)!, true) : p)),
        sourced: out.sourced,
        ...(out.artifact_id ? { artifact_id: out.artifact_id } : {}),
        ...(out.status === 'partial' ? { partial: true } : {}),
        ...(out.note ? { note: out.note } : {}),
      }
    }
    const out = await shortlistFor({
      admin: ctx.admin,
      userId: ctx.userId,
      apiKeys: ctx.apiKeys,
      limit: a.limit,
      query: a.query,
      location: a.filters?.location,
      remoteOnly: a.filters?.remote,
      dreamOnly: a.filters?.dream_only,
      assessMissing: 0,
    })
    return {
      count: out.picks.length,
      of: out.pool,
      roles: out.picks.map((p) => shape(p, detailed)),
      ...(out.picks.length === 0 ? { note: 'Nothing tracked matches. Call find_roles with fresh set to true to search the job boards.' } : {}),
    }
  },
}) satisfies CelloTool

export const getRole = defineTool({
  name: 'get_role',
  description:
    'Read one role by id: title, company, location, pay when known, the chance and why, what the person\'s resume covers and what it lacks. ' +
    'It does not return the posting text. Use it after find_roles when the person asks about one role. Pass an id that find_roles returned.',
  schema: z.object({
    id: z.string().min(1).describe('The role id from find_roles.'),
    ...readFields,
    limit: z.number().int().min(1).max(25).default(10).describe('How many covered and missing items to return, 1 to 25.'),
  }),
  kind: 'read',
  untrusted: true,
  mcp: true,
  async handler(ctx, a) {
    const view = await roleView(ctx.admin, ctx.userId, a.id)
    if (!view) return toolFix(`No role with id ${a.id}.`, 'Call find_roles and use an id it returned.')
    const concise = {
      id: view.jobId,
      title: view.title,
      company: view.company,
      chance: view.chance,
      reason: view.reason,
      link: view.url,
      ...(view.assessed ? {} : { note: 'Not assessed yet. find_roles with fresh true will assess it.' }),
    }
    if (a.response_format === 'concise') return concise
    return {
      ...concise,
      company_id: view.companyId,
      location: view.location,
      posted_at: view.postedAt,
      salary: view.salary,
      covered: view.requirements.covered.slice(0, a.limit),
      missing: view.requirements.missing.slice(0, a.limit),
    }
  },
}) satisfies CelloTool

export const triageRole = defineTool({
  name: 'triage_role',
  description:
    'Record the person\'s reaction to a role: interested, not_for_me or applied, with their reason if they gave one. ' +
    'This teaches Cello what they want and moves the role in the pipeline. Use it only when the person says how they feel about a role, never to guess for them.',
  schema: z.object({
    id: z.string().min(1).describe('The role id from find_roles.'),
    reaction: z.enum(['interested', 'not_for_me', 'applied']).describe('How the person feels: interested, not_for_me, or applied if they already applied.'),
    reason: z.string().max(300).optional().describe('Why, in the person\'s words, when they said.'),
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a) {
    const out = await recordReaction({ admin: ctx.admin, userId: ctx.userId, jobId: a.id, reaction: a.reaction, reason: a.reason })
    if (!out.ok) return toolFix(out.error, out.fix)
    if (a.reaction === 'applied') void scoreTrace(ctx.traceId, 'job_applied', 1, clip(a.reason, 200) ?? undefined)
    if (a.reaction === 'not_for_me') void scoreTrace(ctx.traceId, 'job_dismissed', 0, clip(a.reason, 200) ?? undefined)
    return { ok: true, what: out.outcome.what, role_id: a.id, reaction: a.reaction }
  },
}) satisfies CelloTool
