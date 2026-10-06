// POST /api/fill/token: the person connects their extension. A session mints a scoped token (fill and
// Pause only), shown once. A new one revokes the old: Send for me is bound to one browser's token.
// Demo accounts cannot connect an extension.

import { NextResponse } from 'next/server'
import { createToken } from '@/lib/access/tokens'
import { isDemoProfile } from '@/lib/access/guardrails'
import { FILL_SCOPE } from '@/lib/fill/auth'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function POST() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const { data } = await c.admin.from('profiles').select('is_demo, demo_expires_at').eq('id', c.userId).maybeSingle()
  if (isDemoProfile(data as { is_demo: boolean | null; demo_expires_at: string | null } | null)) {
    return NextResponse.json({ error: 'This is a demo, so the extension cannot connect.' }, { status: 403 })
  }
  await c.admin.from('api_tokens').update({ revoked_at: new Date().toISOString() }).eq('user_id', c.userId).is('revoked_at', null).contains('scopes', [FILL_SCOPE])
  const issued = await createToken(c.admin as never, { userId: c.userId, name: 'Cello extension', scopes: [FILL_SCOPE] })
  return NextResponse.json({ token: issued.token, id: issued.id })
}
