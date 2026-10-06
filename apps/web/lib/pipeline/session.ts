// What every session route of the pipeline does first: know who is asking, and turn a move's answer
// into an HTTP answer. The person comes from the session cookie, never from the request body; the
// door is the session's (actor person), so the person-only kinds are open to it and to nothing else.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { DOORS } from './actors'
import type { Ctx } from './commands'
import type { MoveResult } from './transition'

export async function sessionCtx(): Promise<Ctx | NextResponse> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to do that.' }, { status: 401 })
  return { admin: createAdminClient(), userId: user.id, door: DOORS.session }
}

const STATUS: Record<string, number> = { missing: 404, person_only: 403, extension_only: 403, demo: 403, cap: 429, paused: 409, stale: 409, already: 409, send_block: 409 }

/** 200 with the event, or the refusal with its sentence. */
export function reply(r: MoveResult): NextResponse {
  if (r.ok) return NextResponse.json({ ok: true, replay: r.replay, event: r.event })
  return NextResponse.json({ ok: false, refusal: r.refusal, error: r.sentence }, { status: STATUS[r.refusal] ?? 400 })
}

export const isCtx = (v: Ctx | NextResponse): v is Ctx => !(v instanceof NextResponse)
