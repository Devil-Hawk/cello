// POST /api/roles/:id/judge   judges this role now, on the person's own key or the free allowance they have left.
//
// 200 with the verdict (band, readings, provenance and the legacy fit shape the jobs page still reads), 404 for a role the
// person does not hold, 429 with the day line when no free call is left (or when the minute is full), 400 when there is no
// resume or no model. Behind the session and the cross-site check.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { judgeRole, judgeStatus, stopAnswer } from '@/lib/roles/judge'
import { getRoleFit } from '@/lib/scoring'
import { setTraceMeta, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (isCrossSiteRequest(request.headers)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })

  const admin = createAdminClient()
  return withTrace(admin, user.id, { name: 'judge-role' }, async () => {
    setTraceMeta({ job_id: params.id })
    const out = await judgeRole(admin, user.id, params.id)
    if (out.judged.length === 0) {
      if (out.stopped === null) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
      const { status, ...body } = await stopAnswer(out.stopped, () => judgeStatus(admin, user.id))
      return NextResponse.json(body, { status })
    }
    const [fit, row] = await Promise.all([
      getRoleFit(admin, user.id, params.id),
      admin.from('person_roles').select('band, readings, prov, judged_at').eq('user_id', user.id).eq('job_id', params.id).maybeSingle(),
    ])
    const { band, readings, prov, judged_at } = (row.data ?? {}) as Record<string, unknown>
    return NextResponse.json({ ...fit, band, readings, prov, judgedAt: judged_at })
  })
}
