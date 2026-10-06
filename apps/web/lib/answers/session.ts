// The first thing every answers route does: the person from the session, and a refusal when the
// account is a demo, which cannot save answers.

import { NextResponse } from 'next/server'
import { isDemoProfile } from '@/lib/access/guardrails'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'
import type { Ctx } from '@/lib/pipeline/commands'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function readerCtx(): Promise<Ctx | NextResponse> {
  return sessionCtx()
}

export async function writerCtx(): Promise<Ctx | NextResponse> {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const { data } = await c.admin.from('profiles').select('is_demo, demo_expires_at').eq('id', c.userId).maybeSingle()
  if (isDemoProfile(data as { is_demo: boolean | null; demo_expires_at: string | null } | null)) {
    return NextResponse.json({ error: 'This is a demo, so nothing is saved.' }, { status: 403 })
  }
  return c
}
