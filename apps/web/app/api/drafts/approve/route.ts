// POST /api/drafts/approve  { draftId }
//
// The human-approve action of the one-click-apply flow. The route is a door and
// nothing else: the session door proves who is asking, runCommand runs
// conversations.send, and the approval itself lives in
// lib/commands/send/draft.ts. Approving a draft attempts an OFFICIAL-API
// submission (Greenhouse, Lever, Ashby) via lib/ats-apply.
//
// HARD BOUNDARY: official APIs only, no captcha bypass, no form stuffing.

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

    let draftId: string
    try {
      const body = await request.json()
      draftId = typeof body?.draftId === 'string' ? body.draftId : ''
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 })

    const result = await runCommand(conversationsSend, ctx, { via: 'draft', draft_id: draftId })
    return NextResponse.json(result.body, { status: result.status })
  } catch (e) {
    return refusalToResponse(e)
  }
}
