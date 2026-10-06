// GET /api/applications: the person's applications, each with the group it belongs to.
// POST /api/applications: { jobId } starts one (Apply); { add: {company, title, url?, stage?, appliedAt?} }
// records one the person made themselves.

import { NextRequest, NextResponse } from 'next/server'
import { addByHand } from '@/lib/pipeline/add'
import { start } from '@/lib/pipeline/commands'
import { groupOf } from '@/lib/pipeline/groups'
import { isCtx, reply, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

const COLUMNS =
  'id, job_id, stage, state, step, needs_reason, needs_detail, next_at, applied_at, interview_at, instruction, found_state, closed_reason, cost_usd, last_event_at, created_at, source, jobs(title, url, location, companies(name))'

export async function GET() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const { data, error } = await c.admin.from('applications').select(COLUMNS).eq('user_id', c.userId).order('last_event_at', { ascending: false, nullsFirst: false }).limit(500)
  if (error) return NextResponse.json({ error: 'Could not load your applications. Try again.' }, { status: 500 })
  const applications = (data ?? []).map((a) => ({ ...a, group: groupOf(a as never, null) }))
  return NextResponse.json({ applications })
}

export async function POST(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  let body: { jobId?: unknown; add?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Send JSON.' }, { status: 400 })
  }
  if (typeof body.jobId === 'string') return reply(await start(c, body.jobId))
  if (body.add && typeof body.add === 'object') {
    const a = body.add
    const text = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : null)
    const r = await addByHand(c.admin, c.userId, { company: text('company') ?? '', title: text('title') ?? '', url: text('url'), stage: text('stage'), appliedAt: text('appliedAt') })
    return r.ok ? NextResponse.json({ ok: true, applicationId: r.applicationId, existed: r.existed }) : NextResponse.json({ ok: false, error: r.sentence }, { status: 400 })
  }
  return NextResponse.json({ error: 'Say which role to apply to, or what to add.' }, { status: 400 })
}
