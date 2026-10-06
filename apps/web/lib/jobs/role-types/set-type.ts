// roles.set_type (Change type): the person's word for one role's title, applied at once to every role of
// theirs with that title (migration 20261008057000). `typeId` null says "none of the types". Never changes
// title_types or anyone else's roles.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getRoleType } from './taxonomy'

type Db = SupabaseClient<any, any, any>

export async function setRoleType(db: Db, input: { userId: string; jobId: string; typeId: string | null }): Promise<{ ok: boolean; moved: number; message?: string }> {
  if (input.typeId !== null && (!getRoleType(input.typeId) || input.typeId === 'other')) return { ok: false, moved: 0, message: 'That is not a role type.' }
  const { data, error } = await db.rpc('set_person_role_type', { p_user: input.userId, p_job: input.jobId, p_type: input.typeId })
  if (error) return { ok: false, moved: 0, message: error.code === '22023' ? 'Cello cannot change the type of this role.' : 'Could not change the type.' }
  return { ok: true, moved: typeof data === 'number' ? data : 0 }
}
