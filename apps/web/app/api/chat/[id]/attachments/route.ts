// /api/chat/[id]/attachments: the person adds a tile (POST {kind, ref}) or removes one (DELETE ?tile=<attachment id>).
// The ref is checked strictly and read through the thing's own get command under the person's rights, so
// another person's role, chat or made thing is refused. Detaching keeps the row.

import { NextRequest, NextResponse } from 'next/server'
import { attach, detach } from '@/lib/chat/attach'
import { badRequest, chatSession, isResponse, readJson } from '../../door'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const body = await readJson(request)
  if (!body || typeof body.kind !== 'string') return badRequest('Say which thing to add.')
  const out = await attach(session.db, session.userId, params.id, { kind: body.kind, ref: body.ref }, { origin: 'person', door: 'chat.attach' })
  return NextResponse.json(out, { status: out.ok ? 200 : 422 })
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const tile = request.nextUrl.searchParams.get('tile')
  if (!tile) return badRequest('Say which tile to remove.')
  const out = await detach(session.db, session.userId, params.id, tile)
  return NextResponse.json(out, { status: out.ok ? 200 : 404 })
}
