// GET /api/extension/status
//
// The numbers the extension popup shows: whether Send for me is on, whether Cello is
// paused, how many applications were sent today, how many tries today's cap has used and
// the cap. One read of extension_status() in SQL; the extension computes nothing.
//
// Authenticated by the extension's fill token (api_tokens scope `fill:extension`), the
// same credential the fill routes take. The relay token cannot read it.

import { NextRequest, NextResponse } from 'next/server'
import { validateToken } from '@/lib/access/tokens'
import { createAdminClient } from '@/lib/harness/supabase-admin'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const FILL_SCOPE = 'fill:extension'

export interface ExtensionStatus {
  send_for_me: boolean
  paused: boolean
  sent_today: number
  tries_today: number
  cap: number
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  const bearer = auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  if (!bearer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  const admin = createAdminClient()
  const token = await validateToken(admin, bearer)
  if (!token.ok || !token.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  if (!token.scopes?.includes(FILL_SCOPE)) {
    return NextResponse.json({ error: 'This token cannot read the extension status.' }, { status: 403, headers: NO_STORE })
  }

  const { data, error } = await admin.rpc('extension_status', { p_user: token.userId })
  const s = data as Partial<ExtensionStatus> | null
  if (error || !s || typeof s.cap !== 'number') {
    console.error('[extension/status] failed', error?.message)
    return NextResponse.json({ error: "Couldn't read the status." }, { status: 500, headers: NO_STORE })
  }
  const body: ExtensionStatus = {
    send_for_me: s.send_for_me === true,
    paused: s.paused === true,
    sent_today: Number(s.sent_today ?? 0),
    tries_today: Number(s.tries_today ?? 0),
    cap: s.cap,
  }
  return NextResponse.json(body, { headers: NO_STORE })
}
