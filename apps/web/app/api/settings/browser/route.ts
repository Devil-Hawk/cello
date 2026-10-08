// GET /api/settings/browser: the person's own browser as Cello knows it: whether the extension is connected, when it
// was last seen, and Send for me's limit and today's count.
// DELETE: Disconnect. The extension's token is revoked and Send for me is turned off with it.
// The state is read from the token row and extension_status(); nothing here is the extension's own claim.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { autonomyUpdate } from '@/lib/commands/defs/core'
import { FILL_SCOPE } from '@/lib/fill/auth'
import type { ExtensionStatus } from '@/app/api/extension/status/route'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    const admin = ctx.admin()
    const { data } = await admin
      .from('api_tokens')
      .select('id, last_used_at, created_at')
      .eq('user_id', ctx.userId)
      .is('revoked_at', null)
      .contains('scopes', [FILL_SCOPE])
      .order('created_at', { ascending: false })
      .limit(1)
    const token = (data as { id: string; last_used_at: string | null; created_at: string }[] | null)?.[0] ?? null
    const { data: status } = await admin.rpc('extension_status', { p_user: ctx.userId })
    const s = (status ?? {}) as Partial<ExtensionStatus>
    return NextResponse.json({
      connected: token !== null,
      lastSeen: token?.last_used_at ?? null,
      sendForMe: s.send_for_me === true,
      paused: s.paused === true,
      cap: typeof s.cap === 'number' ? s.cap : 3,
      sentToday: Number(s.sent_today ?? 0),
      triesToday: Number(s.tries_today ?? 0),
    })
  } catch (e) {
    return refusalToResponse(e)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    const admin = ctx.admin()
    const { data } = await admin.from('profiles').select('preferences').eq('id', ctx.userId).maybeSingle()
    const pipeline = ((data as { preferences?: { pipeline?: Record<string, unknown> } } | null)?.preferences?.pipeline ?? {}) as Record<string, unknown>
    // off first: if the revoke below failed, Send for me would still be off
    if ((pipeline.send as { mode?: string } | undefined)?.mode === 'auto') {
      await runCommand(autonomyUpdate, ctx, { pipeline: { ...pipeline, send: { ...(pipeline.send as Record<string, unknown>), mode: 'me' } } })
    }
    const { error } = await admin.from('api_tokens').update({ revoked_at: new Date().toISOString() }).eq('user_id', ctx.userId).is('revoked_at', null).contains('scopes', [FILL_SCOPE])
    if (error) return NextResponse.json({ error: 'Could not disconnect. Nothing changed.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return refusalToResponse(e)
  }
}
