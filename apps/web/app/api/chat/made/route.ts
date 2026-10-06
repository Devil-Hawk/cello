// GET /api/chat/made: what Cello made for the person, newest first. ?application= narrows it to one application's
// (for its record), ?chat= to one chat's, ?before= pages from the last row's updated_at.

import { NextRequest, NextResponse } from 'next/server'
import { listMade } from '@/lib/chat/store'
import { chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const q = request.nextUrl.searchParams
  const made = await listMade(session.db, session.userId, { applicationId: q.get('application') ?? undefined, chatId: q.get('chat') ?? undefined, before: q.get('before') ?? undefined })
  return NextResponse.json({ made }, { headers: { 'Cache-Control': 'no-store' } })
}
