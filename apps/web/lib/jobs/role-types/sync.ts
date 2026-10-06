// pnpm role-types:sync: the `role_types` table is the module (taxonomy.ts), written by this and nothing else.
// A type the module no longer has is retired, never deleted: roles and people may still point at it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ROLE_TYPES, TAXONOMY_VERSION } from './taxonomy'

type Db = SupabaseClient<any, any, any>

export interface RoleTypeRow {
  id: string
  label: string
  family: string
  related: string[]
  taxonomy_version: number
  retired_at: null
  replaced_by: null
}

/** What the table holds when it equals the module. */
export function roleTypeRows(): RoleTypeRow[] {
  return ROLE_TYPES.map((r) => ({ id: r.id, label: r.label, family: r.family, related: [...r.related], taxonomy_version: TAXONOMY_VERSION, retired_at: null, replaced_by: null }))
}

/** The ids where the table and the module differ: missing, extra (and not retired), or with another label, family, relations or version. */
export function diffRoleTypes(table: (Partial<RoleTypeRow> & { id: string; retired_at?: string | null })[]): string[] {
  const live = new Map(table.filter((t) => !t.retired_at).map((t) => [t.id, t]))
  const differ = new Set<string>()
  for (const want of roleTypeRows()) {
    const have = live.get(want.id)
    if (!have || have.label !== want.label || have.family !== want.family || have.taxonomy_version !== want.taxonomy_version || [...(have.related ?? [])].sort().join() !== [...want.related].sort().join()) differ.add(want.id)
  }
  for (const id of live.keys()) if (!ROLE_TYPES.some((r) => r.id === id)) differ.add(id)
  return [...differ].sort()
}

export async function syncRoleTypes(db: Db): Promise<{ written: number; retired: string[] }> {
  const { error } = await db.from('role_types').upsert(roleTypeRows(), { onConflict: 'id' })
  if (error) throw new Error(`role_types upsert failed: ${error.message}`)
  const { data, error: readError } = await db.from('role_types').select('id').is('retired_at', null)
  if (readError) throw new Error(`role_types read failed: ${readError.message}`)
  const keep = new Set(ROLE_TYPES.map((r) => r.id))
  const retired = ((data ?? []) as { id: string }[]).map((r) => r.id).filter((id) => !keep.has(id))
  if (retired.length > 0) {
    const { error: retireError } = await db.from('role_types').update({ retired_at: new Date().toISOString() }).in('id', retired)
    if (retireError) throw new Error(`role_types retire failed: ${retireError.message}`)
  }
  return { written: ROLE_TYPES.length, retired }
}
