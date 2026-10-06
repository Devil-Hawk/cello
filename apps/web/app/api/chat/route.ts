// GET /api/chat: the person's chats for Recents (pinned first, then newest), or with ?earlier=1 their old
// Copilot conversations. ?archived=1 lists archived chats; ?before= pages from the last row's last_turn_at.

import { NextRequest, NextResponse } from 'next/server'
import { earlier, listChats } from '@/lib/chat/store'
import { chatSession, isResponse } from './door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const q = request.nextUrl.searchParams
  const body = q.get('earlier') ? { earlier: await earlier(session.db, session.userId) } : { chats: await listChats(session.db, session.userId, { archived: q.get('archived') === '1', before: q.get('before') ?? undefined }) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
