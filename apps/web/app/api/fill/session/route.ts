// POST /api/fill/session: the extension is on an application's form and asks what to fill.
// { applicationId, fields: [{ id, label, kind?, options?, required? }] }. Refused while Pause is on, and for a
// posting already sent. A Ready application moves to Applying under a lease; the person's click is the
// only way here, and nothing is submitted by this call.

import { NextRequest, NextResponse } from 'next/server'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'
import { buildSession, cleanFields, loadFillApp } from '@/lib/fill/session'
import { DOORS } from '@/lib/pipeline/actors'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { transition } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEASE_MS = 30 * 60_000

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  const b = (await request.json().catch(() => null)) as { applicationId?: unknown; fields?: unknown } | null
  const fields = cleanFields(b?.fields)
  if (typeof b?.applicationId !== 'string' || !UUID.test(b.applicationId) || !fields) return NextResponse.json({ error: 'Send the application and the fields on the form.' }, { status: 400 })

  const { data: profile } = await a.admin.from('profiles').select('preferences').eq('id', a.userId).maybeSingle()
  if (readPipelineSettings((profile as { preferences?: unknown } | null)?.preferences).pausedAt !== null) return NextResponse.json({ error: 'Cello is paused.' }, { status: 409 })

  const app = await loadFillApp(a.admin, a.userId, b.applicationId)
  if (!app) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  if (app.posting_url_hash) {
    const { data: blocked } = await a.admin.rpc('pipeline_send_blocked', { p_user: a.userId, p_hash: app.posting_url_hash })
    if (blocked === true) return NextResponse.json({ error: 'You already sent this one.' }, { status: 409 })
  }
  if (!['ready', 'applying', 'needs_you'].includes(app.state ?? '')) return NextResponse.json({ error: 'This one is not ready to fill.' }, { status: 409 })

  const session = await buildSession(a.admin, app, fields)
  if (app.state === 'ready') {
    const r = await transition(a.admin, {
      applicationId: app.id,
      from: ['ready'],
      to: 'applying',
      step: 'Filling the form',
      event: {
        kind: 'fill.started',
        actor: DOORS.extension.actor,
        channel: DOORS.extension.channel,
        sentence: 'Your browser started filling the form.',
        idempotencyKey: `fill:${app.id}:${app.last_event_at ?? 'none'}`,
        payload: { auto: false, files: session.files.map((f) => ({ name: f.name, id: f.id })) },
      },
    })
    if (!r.ok) return NextResponse.json({ error: r.sentence, refusal: r.refusal }, { status: 409 })
    // the person's own fill: if the tab closes after filling, the sweeper asks "Did you send it?"
    await a.admin.from('applications').update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString(), lease_holder: crypto.randomUUID() }).eq('id', app.id).eq('user_id', a.userId).eq('state', 'applying')
  }
  return NextResponse.json(session)
}
