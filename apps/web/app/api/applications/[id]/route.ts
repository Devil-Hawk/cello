// GET /api/applications/[id]: one application with its timeline, newest first.

import { NextRequest, NextResponse } from 'next/server'
import { groupOf } from '@/lib/pipeline/groups'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  const { data: application } = await c.admin
    .from('applications')
    .select('*, jobs(title, url, location, companies(name))')
    .eq('id', params.id)
    .eq('user_id', c.userId)
    .maybeSingle()
  if (!application) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  const { data: timeline } = await c.admin
    .from('pipeline_events')
    .select('id, kind, actor, channel, actor_label, step, sentence, from_state, to_state, trust, created_at')
    .eq('application_id', params.id)
    .eq('user_id', c.userId)
    .order('created_at', { ascending: false })
    .limit(200)
  return NextResponse.json({ application: { ...application, group: groupOf(application as never, null) }, timeline: timeline ?? [] })
}
