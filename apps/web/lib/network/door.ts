// One route door for a family of commands: POST { command, input } runs the named command as the signed-in
// person (the route hands in its own sessionDoor), and nothing else. The list is the allowlist; a name outside it is a 404 here, and runCommand holds
// every other check (door, proof, input shape, limits, output). Routes under app/api/network, settings/learned,
// conversations and applications/results are each one line over this.

import { NextRequest, NextResponse } from 'next/server'
import type { AnyCommand } from '@/lib/commands/define'
import type { CommandContext } from '@/lib/commands/define'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'

/** `mint` is the route's own sessionDoor: a proof is minted only in a route file. */
export function commandDoor(allowed: readonly AnyCommand[], mint: (request: NextRequest) => Promise<CommandContext>) {
  const byId = new Map(allowed.map((c) => [c.id, c]))
  return {
    dynamic: 'force-dynamic' as const,
    async POST(request: NextRequest) {
      try {
        let body: { command?: unknown; input?: unknown }
        try {
          body = await request.json()
        } catch {
          return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        const def = typeof body.command === 'string' ? byId.get(body.command) : undefined
        if (!def) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        const ctx = await mint(request)
        return NextResponse.json(await runCommand(def, ctx, body.input ?? {}))
      } catch (e) {
        return refusalToResponse(e)
      }
    },
  }
}
