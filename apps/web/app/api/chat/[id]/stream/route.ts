// POST /api/chat/[id]/stream: stores the person's words, then forwards the turn as LangGraph-compatible SSE.
// Closing the browser only stops forwarding; the stored turn keeps running on the server.

import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'
import { toSseResponse, type WireEvent } from '@/lib/agents/sse'
import { runStoredTurn, storePersonTurn } from '@/lib/chat/run'
import { writeSettings } from '@/lib/chat/settings'
import { loadApiKeys } from '@/lib/harness/keys'
import { chatLimits } from '@/lib/models/choice'
import { badRequest, chatNotFound, chatSession, isResponse, readJson } from '../../door'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const humanText = (input: unknown): string => {
  const messages = (input as { messages?: unknown[] } | null)?.messages
  if (!Array.isArray(messages)) return ''
  const message = [...messages].reverse().find((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'human') as { content?: unknown } | undefined
  return typeof message?.content === 'string' ? message.content : ''
}

const quotedOf = (value: unknown): { text: string; turn_id: string } | null => {
  if (!value || typeof value !== 'object') return null
  const q = value as { text?: unknown; turn_id?: unknown }
  return typeof q.text === 'string' && typeof q.turn_id === 'string' ? { text: q.text.slice(0, 4000), turn_id: q.turn_id } : null
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  const typed = humanText(body?.input)
  if (!typed || typed.length > 20_000) return badRequest('Type something to send, up to 20,000 characters.')

  const context = body?.context && typeof body.context === 'object' ? (body.context as { quoted?: unknown; choice?: unknown }) : {}
  if (context.choice !== undefined && context.choice !== null) {
    const done = await writeSettings(session.db, session.userId, params.id, { choice: context.choice }, chatLimits(await loadApiKeys(session.db, session.userId)))
    if (!done.ok) return 'notFound' in done ? chatNotFound() : NextResponse.json({ error: 'refused', message: done.error, fix: done.fix }, { status: 400 })
  }

  const turn = await storePersonTurn(session.db, session.userId, params.id, { typed, quoted: quotedOf(context.quoted) })
  if (!turn) return chatNotFound()

  return toSseResponse(async (emit) => {
    emit({ event: 'metadata', data: { thread_id: params.id, turn_id: turn.id } })
    const work = runStoredTurn(session.db, session.userId, params.id, turn, { emit: emit as (event: WireEvent) => void })
    waitUntil(work)
    await work
  }, request.signal)
}
