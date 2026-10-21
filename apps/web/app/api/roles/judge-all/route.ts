// POST /api/roles/judge-all   "Check chances for all": judges up to 12 waiting roles now, newest first and followed employers
// first, within the person's own key or their free allowance for the day, then puts the person at the front of the next
// roles.match slice so the rest follow without waiting for their turn.
//
// 200 { scored, remaining, line, stopped }, 429 with the day line when nothing could be judged for want of a free call, 400
// when there is no resume or no model. Behind the session and the cross-site check.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { judgeRoles, judgeStatus, nextWaiting, stopAnswer } from '@/lib/roles/judge'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Roles judged in the request itself; the clock takes the rest. */
const NOW_LIMIT = 12
const FRONT_LIMIT = 50

export async function POST(request: NextRequest) {
  if (isCrossSiteRequest(request.headers)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const out = await judgeRoles(admin, user.id, await nextWaiting(admin, user.id, NOW_LIMIT))
  const status = await judgeStatus(admin, user.id)
  if (out.judged.length === 0 && out.stopped) {
    const { status: code, ...body } = stopAnswer(out.stopped, status)
    return NextResponse.json(body, { status: code })
  }
  if (status.waiting > 0 && out.stopped !== 'day') {
    // ponytail: read-modify-write of the routine's args; two clicks in the same instant can lose one (that person still waits their turn).
    const { data } = await admin.from('routines').select('id, args').eq('command', 'roles.match').is('user_id', null).maybeSingle()
    const routine = data as { id: string; args: Record<string, unknown> | null } | null
    if (routine) {
      const front = Array.isArray(routine.args?.front) ? (routine.args!.front as string[]) : []
      await admin
        .from('routines')
        .update({ args: { ...routine.args, front: [user.id, ...front.filter((id) => id !== user.id)].slice(0, FRONT_LIMIT) }, next_due_at: new Date().toISOString(), poked_at: null })
        .eq('id', routine.id)
    }
  }
  return NextResponse.json({ scored: out.judged.length, failed: 0, remaining: status.waiting, line: status.line, stopped: out.stopped })
}
