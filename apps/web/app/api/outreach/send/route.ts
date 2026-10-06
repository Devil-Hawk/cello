// POST /api/outreach/send: send a drafted outreach message through the person's
// OWN Gmail account. The route is a door and nothing else: the session door
// proves who is asking (and refuses another site's request), runCommand runs
// conversations.send, and the guardrails (demo, approve-queue, daily cap, real
// identity, follow-ups) live in lib/commands/send/outreach.ts.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { conversationsSend } from '@/lib/commands/defs/core'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)

    // `approve: true` means "the human is approving this in the same breath as
    // sending it", which keeps approve-and-send atomic: the client no longer
    // PATCHes the row to 'approved' first.
    let id: string
    let approve = false
    try {
      const body = await request.json()
      id = typeof body?.id === 'string' ? body.id : ''
      approve = body?.approve === true
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const result = await runCommand(conversationsSend, ctx, { via: 'outreach', outreach_id: id, approve })
    return NextResponse.json(result.body, { status: result.status })
  } catch (e) {
    return refusalToResponse(e)
  }
}
