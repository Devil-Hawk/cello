// POST /api/chat/[id]/stop: Stop. With {task_id} it stops that one worker; with {turn_id} it stops the whole turn.
// Both are the person's own rows only: a task or turn id that is not theirs stops nothing.

import { NextRequest, NextResponse } from 'next/server'
import { requestStop, requestStopWorker } from '@/lib/chat/workers'
import { badRequest, chatSession, isResponse, readJson } from '../../door'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (typeof body?.task_id === 'string') {
    const stopped = await requestStopWorker(session.db, session.userId, body.task_id)
    return NextResponse.json({ ok: stopped, stopped: stopped ? 1 : 0 }, { status: stopped ? 200 : 404 })
  }
  if (typeof body?.turn_id === 'string') {
    const stopped = await requestStop(session.db, session.userId, body.turn_id)
    return NextResponse.json({ ok: true, stopped })
  }
  return badRequest('Say which task or turn to stop.')
}
