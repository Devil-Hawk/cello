// GET /api/settings/activity?days=7: requests by work and door, the activity.get command as the person.
// A door and nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { activityGet } from '@/lib/commands/defs/core'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    const days = Number(new URL(request.url).searchParams.get('days') ?? 7)
    return NextResponse.json(await runCommand(activityGet, ctx, { days: Number.isFinite(days) ? days : 7 }))
  } catch (e) {
    return refusalToResponse(e)
  }
}
