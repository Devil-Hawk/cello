// roles.retype: the backfill of K5c, on the clock, code only (no model call). In slices that stop before the
// deadline it does two things until nothing is left:
//
//   1. types every stored role by tier 1: roles never typed, and roles code typed under an older taxonomy
//      version (a version bump re-runs code rows and rows still pending; a row a model typed keeps its type)
//   2. maps each person's old target titles to at most 8 role types, most titles first, and marks the
//      mapping for review. A person with no titles, or whose titles map to nothing, keeps the old filter
//      until they choose: their types stay empty.

import { getRoleType, typeTitle, TAXONOMY_VERSION } from '../../jobs/role-types'
import { resolveTargetTitles } from '../../targeting/titles'
import type { RoutineContext, RoutineOutcome } from '../routines'

const BATCH = 200
const PEOPLE_PAGE = 50
const MAX_TYPES = 8

interface JobRow {
  id: string
  title: string
}

/** Roles to type: never typed, or typed by code under an older version. A model's answer is never overwritten. */
async function typeStoredRoles(ctx: RoutineContext): Promise<{ typed: number; more: boolean }> {
  let typed = 0
  while (ctx.now() < ctx.deadlineAt) {
    const { data, error } = await ctx.admin
      .from('jobs')
      .select('id, title')
      .or(`title_norm.is.null,type_prov->>taxonomy_version.is.null,type_prov->>taxonomy_version.neq.${TAXONOMY_VERSION}`)
      .or('type_origin.is.null,type_origin.eq.code')
      .order('id')
      .limit(BATCH)
    if (error) throw new Error('list_roles')
    const rows = (data ?? []) as JobRow[]
    if (rows.length === 0) return { typed, more: false }
    const batch = rows.map((r) => {
      const t = typeTitle(r.title ?? '')
      // an untyped role still records the version it was tried under, so it is not tried again until the next bump
      return { id: r.id, title_norm: t.title_norm, dept_norm: t.dept_norm, role_type: t.role_type, type_origin: t.type_origin, type_prov: t.type_prov ?? { taxonomy_version: TAXONOMY_VERSION } }
    })
    const { error: writeError } = await ctx.admin.rpc('apply_title_types', { p_rows: batch })
    if (writeError) throw new Error('apply_title_types')
    typed += rows.length
  }
  return { typed, more: true }
}

/** Old target titles to role types: the most titles first, at most 8; titles no rule types are left out. */
export function mapTitlesToTypes(titles: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const title of titles) {
    const type = typeTitle(title).role_type
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TYPES).map(([id]) => id)
}

/** People who set targets before role types and have not been looked at: `role_types` is not in their targeting. */
async function mapOldTargets(ctx: RoutineContext): Promise<{ mapped: number; more: boolean }> {
  let mapped = 0
  while (ctx.now() < ctx.deadlineAt) {
    const { data, error } = await ctx.admin
      .from('profiles')
      .select('id, preferences')
      .not('preferences->targeting', 'is', null)
      .is('preferences->targeting->role_types', null)
      .order('id')
      .limit(PEOPLE_PAGE)
    if (error) throw new Error('list_profiles')
    const people = (data ?? []) as { id: string; preferences: Record<string, unknown> | null }[]
    if (people.length === 0) return { mapped, more: false }
    for (const p of people) {
      const prefs = p.preferences ?? {}
      const targeting = (prefs.targeting && typeof prefs.targeting === 'object' ? prefs.targeting : {}) as Record<string, unknown>
      const types = mapTitlesToTypes(resolveTargetTitles(prefs))
      const next: Record<string, unknown> = { ...targeting, role_types: types }
      if (types.length > 0) {
        next.role_types_review = true
        next.functions = [...new Set(types.map((id) => getRoleType(id)?.family).filter((f): f is string => !!f))]
      }
      // ponytail: read-modify-write of one person's preferences; a save in the same second is overwritten (and redone
      // from the person's types at the next slice), a row-level lock would need a function for one backfill.
      const { error: writeError } = await ctx.admin.from('profiles').update({ preferences: { ...prefs, targeting: next } }).eq('id', p.id)
      if (writeError) throw new Error('write_profile')
      if (types.length > 0) mapped++
    }
  }
  return { mapped, more: true }
}

export async function rolesRetype(ctx: RoutineContext): Promise<RoutineOutcome> {
  try {
    const roles = await typeStoredRoles(ctx)
    const people = roles.more ? { mapped: 0, more: true } : await mapOldTargets(ctx)
    const found = { typed: Number(ctx.state?.typed ?? 0) + roles.typed, mapped: Number(ctx.state?.mapped ?? 0) + people.mapped }
    return roles.more || people.more ? { ok: true, next: found } : { ok: true, found }
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : 'failed' }
  }
}
