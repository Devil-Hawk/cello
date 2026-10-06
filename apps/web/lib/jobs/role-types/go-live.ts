// pnpm role-types:go-live: the owner's switch for role_types_live (13.2). It refuses unless the caller is
// the instance owner and S2's latest run on the owner's labels passed (keep recall at least 0.95). Turning
// it off is always allowed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isOwner } from '../../measures/owner'

type Db = SupabaseClient<any, any, any>

export async function setRoleTypesLive(
  db: Db,
  input: { owner: string | null | undefined; on: boolean; env?: Record<string, string | undefined> }
): Promise<{ ok: boolean; message: string }> {
  if (!isOwner(input.owner, input.env)) return { ok: false, message: 'Only the instance owner can change this.' }

  if (input.on) {
    const { data, error } = await db.from('measure_runs').select('passed, ran_at').eq('measure_id', 'S2').order('ran_at', { ascending: false }).limit(1).maybeSingle()
    if (error) return { ok: false, message: 'Could not read the S2 run, so nothing changed.' }
    const run = data as { passed: boolean | null; ran_at: string } | null
    if (!run) return { ok: false, message: 'S2 has no run on your labels yet. Run it first.' }
    if (run.passed !== true) return { ok: false, message: "S2's latest run on your labels did not pass (keep recall must be at least 0.95), so the switch stays off." }
  }

  const note = input.on ? 'on: the type step decides what is kept' : 'off: the old title filter decides, the type step is counted beside it (T20)'
  const { error } = await db.from('instance_flags').upsert({ key: 'role_types_live', on: input.on, set_by: input.owner, set_at: new Date().toISOString(), note }, { onConflict: 'key' })
  if (error) return { ok: false, message: 'Could not write the switch, so nothing changed.' }
  return { ok: true, message: input.on ? 'role_types_live is on.' : 'role_types_live is off.' }
}
