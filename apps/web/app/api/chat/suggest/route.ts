// GET /api/chat/suggest: the greeting and three suggestions of an empty chat. Code, no model.

import { NextRequest, NextResponse } from 'next/server'
import { suggest } from '@/lib/chat/suggest'
import { chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const { data } = await session.db.from('profiles').select('full_name').eq('id', session.userId).maybeSingle()
  const timeZone = request.nextUrl.searchParams.get('tz') ?? undefined
  const out = await suggest(session.db, session.userId, { name: (data as { full_name: string | null } | null)?.full_name, timeZone })
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
