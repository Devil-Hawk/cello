// GET /api/chat/made: what Cello made for the person, newest first. ?application= narrows it to one application's
// (for its record, with the chats that hold it), ?chat= to one chat's, ?before= pages from the last row's updated_at.

import { NextRequest, NextResponse } from 'next/server'
import { chatsHolding, listMade } from '@/lib/chat/store'
import { chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const q = request.nextUrl.searchParams
  const application = q.get('application') ?? undefined
  const made = await listMade(session.db, session.userId, { applicationId: application, chatId: q.get('chat') ?? undefined, before: q.get('before') ?? undefined })
  // An application's record lists its chats beside what was made.
  const chats = application ? await chatsHolding(session.db, session.userId, application) : undefined
  return NextResponse.json({ made, chats }, { headers: { 'Cache-Control': 'no-store' } })
}
