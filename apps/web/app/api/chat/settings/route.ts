// /api/chat/settings: chat.settings. GET reads what the next turn runs on and the ladder for the picker (`?chat=` for one
// chat, none for a new chat); POST {chat, choice, review, tools_off, as_default} writes it (with no chat, only a choice with as_default: the default for new chats). A choice above the person's
// highest is refused with the reason and nothing is stored.

import { NextRequest, NextResponse } from 'next/server'
import { readSettings, writeSettings } from '@/lib/chat/settings'
import { loadApiKeys } from '@/lib/harness/keys'
import { chatLimits } from '@/lib/models/choice'
import { freeModels } from '@/lib/models/free'
import { badRequest, chatNotFound, chatSession, isResponse, readJson } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const view = await readSettings(session.db, session.userId, request.nextUrl.searchParams.get('chat'), chatLimits(await loadApiKeys(session.db, session.userId)), freeModels())
  return view ? NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } }) : chatNotFound()
}

export async function POST(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (!body) return badRequest('Send a setting.')
  const { chat, ...settings } = body
  if (chat !== undefined && typeof chat !== 'string') return badRequest('Say which chat.')
  const done = await writeSettings(session.db, session.userId, chat ?? null, settings, chatLimits(await loadApiKeys(session.db, session.userId)))
  if (done.ok) return NextResponse.json({ ok: true })
  if ('notFound' in done) return chatNotFound()
  return NextResponse.json({ error: 'refused', message: done.error, fix: done.fix }, { status: 400 })
}
