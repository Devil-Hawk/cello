// POST /api/roles/:id/type { typeId }   Change type (roles.set_type): the person's word for this role's title,
//                                       applied to every role of theirs with that title. typeId null takes the
//                                       correction back, which is what Undo sends.
//
// Runs as the signed-in person; set_person_role_type refuses another person's roles itself.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { setRoleType } from '@/lib/jobs/role-types/set-type'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const Body = z.object({ typeId: z.string().min(1).max(63).nullable() })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'That is not a role type.' }, { status: 400 })

  const out = await setRoleType(supabase, { userId: user.id, jobId: params.id, typeId: parsed.data.typeId })
  return out.ok ? NextResponse.json({ moved: out.moved }) : NextResponse.json({ error: out.message ?? 'Could not change the type.' }, { status: 400 })
}
