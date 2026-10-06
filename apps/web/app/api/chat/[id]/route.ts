// /api/chat/[id]: one chat with its turns and tiles (GET), the person's changes to it (PATCH: title, pinned,
// archived) and deleting it with its memories (DELETE). Someone else's chat answers the same as a missing one.

import { NextRequest, NextResponse } from 'next/server'
import { deleteChat } from '@/lib/chat/memory'
import { loadChatPage } from '@/lib/chat/page-data'
import { archiveChat, pinChat, renameChat } from '@/lib/chat/store'
import { getMemoryStore } from '@/lib/memory/mem0-store'
import { badRequest, chatNotFound, chatSession, isResponse, readJson } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const page = await loadChatPage(session.db, session.userId, params.id)
  return page ? NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } }) : chatNotFound()
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (!body) return badRequest('Send a title, pinned or archived.')
  const { db, userId } = session
  const done: boolean[] = []
  if (typeof body.title === 'string') done.push(await renameChat(db, userId, params.id, body.title))
  if (typeof body.pinned === 'boolean') done.push(await pinChat(db, userId, params.id, body.pinned))
  if (typeof body.archived === 'boolean') done.push(await archiveChat(db, userId, params.id, body.archived))
  if (done.length === 0) return badRequest('Send a title, pinned or archived.')
  return done.every(Boolean) ? NextResponse.json({ ok: true }) : chatNotFound()
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const ok = await deleteChat(session.db, getMemoryStore(), session.userId, params.id)
  return ok ? NextResponse.json({ ok: true }) : chatNotFound()
}
