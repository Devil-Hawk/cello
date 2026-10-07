// POST /api/applications/[id]/[action]: one route for every move the person makes on an application.
// The action is looked up in a fixed list, so no other word reaches a command. Every one is the
// person's, from a session: a command that only the person may give (mark sent, approve, stage) is
// refused again in SQL for any other actor.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { advanceOne } from '@/lib/advance'
import * as commands from '@/lib/pipeline/commands'
import { isCtx, reply, sessionCtx } from '@/lib/pipeline/session'
import { CLOSED_REASONS, STAGES, type ClosedReason, type Stage } from '@/lib/pipeline/types'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Body = Record<string, unknown>

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

const ACTIONS: Record<string, (c: commands.Ctx, id: string, b: Body) => Promise<NextResponse>> = {
  pause: async (c, id) => reply(await commands.pauseOne(c, id)),
  resume: async (c, id) => reply(await commands.resumeOne(c, id)),
  skip: async (c, id) => reply(await commands.skip(c, id)),
  'run-again': async (c, id) => reply(await commands.runAgain(c, id)),
  approve: async (c, id, b) => {
    if (typeof b.hash !== 'string' || !b.hash) return bad('Say which resume version you approve.')
    const moved = await commands.approveDocument(c, id, b.hash)
    // The next steps run now, so the person does not wait for the minute sweeper.
    if (moved.ok) waitUntil(advanceOne(c.admin, id).catch(() => null))
    return reply(moved)
  },
  'apply-anyway': async (c, id) => reply(await commands.applyAnyway(c, id)),
  'allow-send': async (c, id) => reply(await commands.allowSend(c, id)),
  stage: async (c, id, b) => (STAGES.includes(b.stage as Stage) ? reply(await commands.setStage(c, id, b.stage as Stage)) : bad('That is not a stage.')),
  'mark-sent': async (c, id) => reply(await commands.markSent(c, id)),
  retract: async (c, id) => reply(await commands.retract(c, id)),
  'not-applied': async (c, id) => reply(await commands.notApplied(c, id)),
  close: async (c, id, b) => (CLOSED_REASONS.includes(b.reason as ClosedReason) ? reply(await commands.close(c, id, b.reason as ClosedReason)) : bad('Say why it closed.')),
  // the person's own columns: no move, no event
  'interview-date': async (c, id, b) => {
    const t = typeof b.at === 'string' ? new Date(b.at) : null
    if (b.at !== null && (!t || Number.isNaN(t.getTime()))) return bad('That date is not one Cello can use.')
    return own(c, id, { interview_at: t ? t.toISOString() : null })
  },
  instruction: async (c, id, b) => {
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (text.length > 1000) return bad('Keep it under 1,000 characters.')
    return own(c, id, { instruction: text || null })
  },
}

async function own(c: commands.Ctx, id: string, patch: Record<string, unknown>): Promise<NextResponse> {
  const { data } = await c.admin.from('applications').update(patch).eq('id', id).eq('user_id', c.userId).select('id').maybeSingle()
  return data ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
}

export async function POST(request: NextRequest, { params }: { params: { id: string; action: string } }) {
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, params.action) ? ACTIONS[params.action] : null
  if (!run) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  let body: Body = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    return bad('Send JSON.')
  }
  return run(c, params.id, body && typeof body === 'object' ? body : {})
}
