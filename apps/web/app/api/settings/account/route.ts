// DELETE /api/settings/account { confirm: "delete my account" }: settings.delete_account as the person.
// A door and nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { deleteAccount } from '@/lib/commands/defs/core'

export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await runCommand(deleteAccount, ctx, body))
  } catch (e) {
    return refusalToResponse(e)
  }
}
