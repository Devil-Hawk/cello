// POST /api/chat/[id]/turns {typed, quoted?, choice?}: the person sends a message. Their words are stored first and the
// call answers at once with the turn's id; the answer is made after the response (waitUntil) and the page follows it by
// reading the chat. A closed Chat, or a chat that is not theirs, answers as a page that does not exist.

import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'
import { runStoredTurn } from '@/lib/chat/run'
import { writeSettings } from '@/lib/chat/settings'
import { loadApiKeys } from '@/lib/harness/keys'
import { chatLimits } from '@/lib/models/choice'
import { badRequest, chatNotFound, chatSession, isResponse, readJson } from '../../door'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const TYPED_MAX = 20_000

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const { db, userId } = session
  const body = await readJson(request)
  const typed = typeof body?.typed === 'string' ? body.typed.trim() : ''
  if (!typed || typed.length > TYPED_MAX) return badRequest('Type something to send, up to 20,000 characters.')
  const { data: chat } = await db.from('chats').select('id').eq('id', params.id).eq('user_id', userId).maybeSingle()
  if (!chat) return chatNotFound()
  if (body?.choice !== undefined) {
    const done = await writeSettings(db, userId, params.id, { choice: body.choice }, chatLimits(await loadApiKeys(db, userId)))
    if (!done.ok) return 'notFound' in done ? chatNotFound() : NextResponse.json({ error: 'refused', message: done.error, fix: done.fix }, { status: 400 })
  }
  const q = body?.quoted as { text?: unknown; turn_id?: unknown } | undefined
  const quoted = q && typeof q.text === 'string' && typeof q.turn_id === 'string' ? { text: q.text.slice(0, 4000), turn_id: q.turn_id } : null
  const { data: made, error } = await db.from('chat_turns').insert({ user_id: userId, chat_id: params.id, kind: 'person', typed, origin: 'person', quoted }).select('id').single()
  if (error || !made) return NextResponse.json({ error: 'save_failed', message: 'Could not save your message. Try again.' }, { status: 500 })
  const id = (made as { id: string }).id
  const { data: titled } = await db.from('chats').select('title').eq('id', params.id).eq('user_id', userId).maybeSingle()
  if (!(titled as { title: string } | null)?.title) await db.from('chats').update({ title: typed.replace(/\s+/g, ' ').slice(0, 80) }).eq('id', params.id).eq('user_id', userId)
  waitUntil(runStoredTurn(db, userId, params.id, { id, typed, quoted }).catch(() => undefined))
  return NextResponse.json({ ok: true, turn_id: id }, { status: 202 })
}
