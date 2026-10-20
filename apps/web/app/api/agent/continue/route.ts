// POST /api/agent/continue: carry on work nobody is watching.
//
// Called by the server itself, never by a browser: by the minute sweeper through pg_net (reason
// "routine": a routine is due), and by a routine's own slice when it hands the rest on. There is no
// cookie. The request is trusted only if its signature checks out over the exact bytes received
// (HMAC-SHA256 with AGENT_CONTINUE_SECRET, header X-Cello-Signature) and its `exp` is a few minutes
// ahead at most. This is the one verifier (lib/clock/sign.ts).
//
// It answers 202 at once and does the work after the response, so the caller (the sweeper
// especially) is never held for the length of a slice.
//
// What each reason does: routine and a routine's slice run the routine; advance moves one application
// a step; a chat slice (a thread_id and no routine_id) and a stale chat post carry an unfinished chat turn
// on from its checkpoint (resumeChatTurn decides whether the thread is a chat turn at all); due, and any
// reason without what it needs, are accepted, answered and logged.

import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { HANDLERS } from '@/lib/clock/routines/index'
import { runRoutine } from '@/lib/clock/routines'
import { advanceOne } from '@/lib/advance'
import { resumeChatTurn } from '@/lib/chat/run'
import { verifyContinue, type ContinuePayload } from '@/lib/clock/sign'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function carryOn(payload: ContinuePayload): Promise<void> {
  if (payload.reason === 'slice' && typeof payload.thread_id === 'string' && typeof payload.routine_id !== 'string') {
    await resumeChatTurn(createAdminClient(), payload.thread_id, payload.turn_id, typeof payload.slice?.n === 'number' ? payload.slice.n : 0)
    return
  }
  if (payload.reason === 'stale' && typeof payload.thread_id === 'string') {
    await resumeChatTurn(createAdminClient(), payload.thread_id, payload.turn_id)
    return
  }
  if (payload.reason === 'routine' || payload.reason === 'slice') {
    if (typeof payload.routine_id !== 'string') return
    await runRoutine(createAdminClient(), payload.routine_id, payload.slice ?? null, { handlers: HANDLERS })
    return
  }
  if (payload.reason === 'advance') {
    if (typeof payload.application_id === 'string') await advanceOne(createAdminClient(), payload.application_id)
    return
  }
  // due, and a stale or slice post with no thread: nothing to hand them to.
  console.error('[clock] nothing to do for', payload.reason)
}

export async function POST(request: NextRequest) {
  const raw = await request.text()
  let verdict: ReturnType<typeof verifyContinue>
  try {
    verdict = verifyContinue(raw, request.headers.get('x-cello-signature'))
  } catch (e) {
    // The secret is not set on this deployment.
    console.error('[clock] continue request refused:', e instanceof Error ? e.name : 'error')
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }
  // The same answer for every kind of refusal: a caller learns nothing about which check failed.
  if (!verdict.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const work = carryOn(verdict.payload).catch((e) => {
    console.error('[clock] continue failed', e instanceof Error ? e.name : 'error')
  })
  if (process.env.VERCEL) waitUntil(work)
  else await work
  return NextResponse.json({ accepted: true }, { status: 202 })
}
