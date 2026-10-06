// POST /api/settings/models/test: one short call on every rung that is set up, and what
// each answered. A door and nothing else: models.test does the work.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { modelsTest } from '@/lib/commands/defs/core'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    return NextResponse.json(await runCommand(modelsTest, ctx, {}))
  } catch (e) {
    return refusalToResponse(e)
  }
}
