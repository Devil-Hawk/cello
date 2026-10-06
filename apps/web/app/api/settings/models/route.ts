// GET /api/settings/models: which rungs are set up, the person's highest rung and
// order, and today's free-model count. PUT: change the highest rung, the order or
// credit_bought. A door and nothing else: models.get and settings.models do the work
// (lib/commands/defs/core.ts), and the screen over them is PG4's.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { modelsGet, settingsModels } from '@/lib/commands/defs/core'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    return NextResponse.json(await runCommand(modelsGet, ctx, {}))
  } catch (e) {
    return refusalToResponse(e)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    return NextResponse.json(await runCommand(settingsModels, ctx, body))
  } catch (e) {
    return refusalToResponse(e)
  }
}
