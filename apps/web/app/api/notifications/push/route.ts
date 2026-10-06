// /api/notifications/push: this browser's web push subscription.
//   GET     whether push works on this server, and the public key a browser needs to subscribe
//   POST    { endpoint, keys: { p256dh, auth } } saves this browser
//   DELETE  { endpoint } forgets it
// Without the owner's VAPID keys push is off and GET says so in a sentence.

import { NextRequest, NextResponse } from 'next/server'
import { PUSH_OFF_SENTENCE, isPushEndpoint, vapidKeys } from '@/lib/notifications/push'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const keys = vapidKeys()
  return NextResponse.json(keys ? { enabled: true, publicKey: keys.publicKey } : { enabled: false, sentence: PUSH_OFF_SENTENCE })
}

export async function POST(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  if (!vapidKeys()) return NextResponse.json({ error: PUSH_OFF_SENTENCE }, { status: 503 })
  const b = (await request.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
  const endpoint = typeof b?.endpoint === 'string' ? b.endpoint : ''
  const p256dh = typeof b?.keys?.p256dh === 'string' ? b.keys.p256dh : ''
  const auth = typeof b?.keys?.auth === 'string' ? b.keys.auth : ''
  // a browser's own push service, with keys of the size the protocol fixes (65 and 16 bytes)
  if (!isPushEndpoint(endpoint) || endpoint.length > 2000 || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
    return NextResponse.json({ error: 'That is not a browser subscription.' }, { status: 400 })
  }
  const { data: have } = await c.admin.from('push_subscriptions').select('id, user_id').eq('endpoint', endpoint).maybeSingle()
  const row = have as { id: string; user_id: string } | null
  if (row && row.user_id !== c.userId) return NextResponse.json({ error: 'That browser belongs to another account.' }, { status: 409 })
  const r = row
    ? await c.admin.from('push_subscriptions').update({ p256dh, auth }).eq('id', row.id).eq('user_id', c.userId)
    : await c.admin.from('push_subscriptions').insert({ user_id: c.userId, endpoint, p256dh, auth })
  return r.error ? NextResponse.json({ error: 'Could not save that. Try again.' }, { status: 500 }) : NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const b = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
  if (typeof b?.endpoint !== 'string') return NextResponse.json({ error: 'Say which browser.' }, { status: 400 })
  await c.admin.from('push_subscriptions').delete().eq('endpoint', b.endpoint).eq('user_id', c.userId)
  return NextResponse.json({ ok: true })
}
