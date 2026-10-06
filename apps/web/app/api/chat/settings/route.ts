// /api/chat/settings: chat.settings. GET reads what the next turn runs on and the ladder for the picker (`?chat=` for one
// chat, none for a new chat); POST {chat, choice, review, tools_off, as_default} writes it. A choice above the person's
// highest is refused with the reason and nothing is stored.

import { NextRequest, NextResponse } from 'next/server'
import { readSettings, writeSettings } from '@/lib/chat/settings'
import { badRequest, chatNotFound, chatSession, isResponse, readJson } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const view = await readSettings(session.db, session.userId, request.nextUrl.searchParams.get('chat'))
  return view ? NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } }) : chatNotFound()
}

export async function POST(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (!body || typeof body.chat !== 'string') return badRequest('Say which chat.')
  const { chat, ...settings } = body
  const done = await writeSettings(session.db, session.userId, chat, settings)
  if (done.ok) return NextResponse.json({ ok: true })
  if ('notFound' in done) return chatNotFound()
  return NextResponse.json({ error: 'refused', message: done.error, fix: done.fix }, { status: 400 })
}
