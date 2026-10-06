// GET /api/chat/object?kind=role&ref=<id>: the name of one thing, read under the person's rights, so a chip in the
// compose box can say what it is before anything is attached. A thing that is not theirs answers as not found.

import { NextRequest, NextResponse } from 'next/server'
import { refFromId } from '@/lib/chat/attach'
import { objectName } from '@/lib/chat/types'
import { getObject } from '@/lib/chat/ports/commands.stub'
import { chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const kind = request.nextUrl.searchParams.get('kind') ?? ''
  const ref = refFromId(kind, request.nextUrl.searchParams.get('ref') ?? '')
  const found = ref ? await getObject(session.db, session.userId, kind as Parameters<typeof getObject>[2], ref) : null
  return found ? NextResponse.json({ kind: found.kind, ref: found.id, name: objectName(found) }, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'not_found', message: 'That is not in your account.' }, { status: 404 })
}
