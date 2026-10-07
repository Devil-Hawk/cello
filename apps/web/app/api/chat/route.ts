// POST /api/chat {chips, choice?}: starts a chat, holding the chips the person added (each checked as theirs), and answers
// with its id. The first message goes to /api/chat/[id]/turns.
// GET /api/chat: the person's chats for Recents (pinned first, then newest), or with ?earlier=1 their old
// Copilot conversations. ?archived=1 lists archived chats; ?before= pages from the last row's last_turn_at; ?limit= sizes the page.

import { NextRequest, NextResponse } from 'next/server'
import { attach, refFromId } from '@/lib/chat/attach'
import { writeSettings } from '@/lib/chat/settings'
import { earlier, listChats } from '@/lib/chat/store'
import { loadApiKeys } from '@/lib/harness/keys'
import { chatLimits } from '@/lib/models/choice'
import { ATTACH_KINDS } from '@/lib/chat/types'
import { badRequest, chatSession, isResponse, readJson } from './door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const q = request.nextUrl.searchParams
  const body = q.get('earlier') ? { earlier: await earlier(session.db, session.userId) } : { chats: await listChats(session.db, session.userId, { archived: q.get('archived') === '1', before: q.get('before') ?? undefined, limit: Number(q.get('limit')) || undefined }) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const { db, userId } = session
  const body = await readJson(request)
  const chips = Array.isArray(body?.chips) ? (body.chips as { kind?: unknown; id?: unknown }[]).slice(0, 25) : []
  if (chips.some((c) => typeof c?.kind !== 'string' || typeof c?.id !== 'string' || !ATTACH_KINDS.some((k) => k === c.kind))) return badRequest('Those are not things a chat can hold.')
  const { data: chat, error } = await db.from('chats').insert({ user_id: userId }).select('id').single()
  if (error || !chat) return NextResponse.json({ error: 'save_failed', message: 'Could not start a chat. Try again.' }, { status: 500 })
  const id = (chat as { id: string }).id
  // Work the chat starts is recorded against this thread (agent_tasks.thread_id), which is the chat's own id.
  await db.from('graph_threads').insert({ thread_id: id, user_id: userId, surface: 'agent' })
  for (const c of chips as { kind: string; id: string }[]) {
    const ref = refFromId(c.kind, c.id)
    if (ref) await attach(db, userId, id, { kind: c.kind, ref }, { origin: 'person', door: 'session' })
  }
  if (body?.choice !== undefined) await writeSettings(db, userId, id, { choice: body.choice }, chatLimits(await loadApiKeys(db, userId)))
  return NextResponse.json({ id }, { status: 201 })
}
