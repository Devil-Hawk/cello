// POST /api/chat/keep {artifact_id}: chat.keep, the person's own click on Keep in the side panel. Sets the current
// version of one of their made things as kept. Through the session door: the loop cannot call it.

import { NextRequest, NextResponse } from 'next/server'
import { chatKeep } from '@/lib/commands/defs/chat'
import { sessionDoor } from '@/lib/commands/doors'
import { refusalToResponse } from '@/lib/commands/http'
import { runCommand } from '@/lib/commands/run'
import { chatOpen } from '@/lib/chat/shown'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { badRequest, readJson } from '../door'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    if (!(await chatOpen(createAdminClient(), ctx.userId))) return new NextResponse(null, { status: 404 })
    const body = await readJson(request)
    if (typeof body?.artifact_id !== 'string') return badRequest('Say which made thing to keep.')
    return NextResponse.json(await runCommand(chatKeep, ctx, { artifact_id: body.artifact_id }))
  } catch (e) {
    return refusalToResponse(e)
  }
}
