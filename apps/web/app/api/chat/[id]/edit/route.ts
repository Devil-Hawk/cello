// POST /api/chat/[id]/edit {turn_id, typed}: chat.edit_turn. The person edits one of their own earlier messages; the
// chat forks from there and the old version stays behind "Version 1 of 2". Nothing the old branch made is touched.
// The new branch's answer is made after the response, as for a new message.

import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'
import { forkFromTurn } from '@/lib/chat/edit'
import { runStoredTurn } from '@/lib/chat/run'
import { badRequest, chatSession, isResponse, readJson } from '../../door'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (!body || typeof body.turn_id !== 'string' || typeof body.typed !== 'string') return badRequest('Say which turn and the new words.')
  const out = await forkFromTurn(session.db, session.userId, params.id, body.turn_id, body.typed.slice(0, 20_000))
  if (out.ok) {
    const typed = body.typed.trim().slice(0, 20_000)
    waitUntil(runStoredTurn(session.db, session.userId, params.id, { id: out.id, typed }).catch(() => undefined))
    return NextResponse.json({ ok: true, turn_id: out.id })
  }
  return NextResponse.json({ error: 'refused', message: out.error, fix: out.fix }, { status: 422 })
}
