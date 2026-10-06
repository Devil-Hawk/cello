// GET /api/chat/find?q=<words>: the person's own roles, companies, applications, people, earlier chats and made things whose name
// holds the words, for [Add] and "@" in the compose box. Names only; adding one goes through /api/chat/[id]/attachments.

import { NextRequest, NextResponse } from 'next/server'
import { findThings } from '@/lib/chat/find'
import { chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  try {
    const found = await findThings(session.db, session.userId, request.nextUrl.searchParams.get('q') ?? '')
    return NextResponse.json({ found }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'unreadable', message: 'Cello could not search just now.' }, { status: 500 })
  }
}
