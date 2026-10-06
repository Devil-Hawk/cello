// POST /api/fill/session: the extension is on a form and asks what to fill.
// { url, fields: [{ key, label, type, options, required }], application?, auto? }  ->
// { status: 'ok', application, session, company, values, categories, drafts, file }, or
// { status: 'none' | 'refused' | 'ended', ... }. Refused while Pause is on, for a posting already sent,
// for an application that is not ready to fill and for one an automatic claim holds. A Ready application
// moves to Applying under a lease; the person's click is the only way here, and nothing is submitted by
// this call. The fields are classified here, and the answer holds values for those keys only.

import { NextRequest, NextResponse } from 'next/server'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'
import { saveSessionFields } from '@/lib/fill/record'
import { buildSession, findFillAppByUrl, loadFillApp, toWire } from '@/lib/fill/session'
import { SessionBody, UUID, formFieldsOf, serverFields } from '@/lib/fill/wire'
import { DOORS } from '@/lib/pipeline/actors'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { note, transition } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

const LEASE_MS = 30 * 60_000
const X = DOORS.extension

const refuse = (reason: string, message: string, status = 409) => NextResponse.json({ status: 'refused', reason, message }, { status })

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  const parsed = SessionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Send the address and the fields on the form.' }, { status: 400 })
  const b = parsed.data
  const id = b.application ?? b.application_id
  if (id !== undefined && !UUID.test(id)) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })

  const { data: profile } = await a.admin.from('profiles').select('preferences').eq('id', a.userId).maybeSingle()
  if (readPipelineSettings((profile as { preferences?: unknown } | null)?.preferences).pausedAt !== null) return refuse('paused', 'Cello is paused.')

  const app = id ? await loadFillApp(a.admin, a.userId, id) : await findFillAppByUrl(a.admin, a.userId, b.url)
  if (!app) return id ? NextResponse.json({ error: 'That application is gone.' }, { status: 404 }) : NextResponse.json({ status: 'none', message: 'Cello has no application for this page.' })
  if (app.posting_url_hash) {
    const { data: blocked } = await a.admin.rpc('pipeline_send_blocked', { p_user: a.userId, p_hash: app.posting_url_hash })
    if (blocked === true) return refuse('already_sent', 'You already sent this one.')
  }
  if (!['ready', 'applying', 'needs_you'].includes(app.state ?? '')) return refuse('not_ready', 'This one is not ready to fill.')
  const claimed = app.state === 'applying' && app.auto_attempted_at !== null
  // an automatic claim is one browser's: the person's own fill waits until its lease ends
  if (!b.auto && claimed && app.lease_until && Date.parse(app.lease_until) > Date.now()) return refuse('claimed', 'Cello is sending this one now.')
  if (b.auto && !claimed) return refuse('not_claimed', 'Cello has not claimed this one.')

  const company = app.jobs!.companies?.name ?? null
  const fields = serverFields(b.fields, company)
  const session = await buildSession(a.admin, app, formFieldsOf(fields))
  if (b.auto && session.autoReason !== null) {
    await transition(a.admin, {
      applicationId: app.id,
      from: ['applying'],
      to: 'needs_you',
      reason: 'your_turn',
      detail: { cause: 'unknown_field', auto: true },
      step: 'Your turn on the site',
      event: { kind: 'fill.blocked', actor: X.actor, channel: X.channel, sentence: session.autoReason, idempotencyKey: `blocked:${app.id}:${app.last_event_at ?? 'none'}`, payload: { cause: 'unknown_field', auto: true } },
    })
    return NextResponse.json({ status: 'ended', cause: 'unknown_field', message: session.autoReason })
  }

  let sessionId = app.lease_holder ?? crypto.randomUUID()
  if (app.state === 'ready') {
    const r = await transition(a.admin, {
      applicationId: app.id,
      from: ['ready'],
      to: 'applying',
      step: 'Filling the form',
      event: {
        kind: 'fill.started',
        actor: X.actor,
        channel: X.channel,
        sentence: 'Your browser started filling the form.',
        idempotencyKey: `fill:${app.id}:${app.last_event_at ?? 'none'}`,
        payload: { auto: false, files: session.files.map((f) => ({ name: f.name, id: f.id })) },
      },
    })
    if (!r.ok) return refuse(r.refusal, r.sentence)
    sessionId = crypto.randomUUID()
    // the person's own fill: if the tab closes after filling, the sweeper asks "Did you send it?"
    await a.admin.from('applications').update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString(), lease_holder: sessionId }).eq('id', app.id).eq('user_id', a.userId).eq('state', 'applying')
  } else if (b.auto) {
    // Send for me: the files this claim serves, which the Send step must match exactly
    await note(a.admin, a.userId, app.id, { kind: 'fill.started', actor: X.actor, channel: X.channel, sentence: 'Your browser started filling the form for Send for me.', idempotencyKey: `fill:${app.id}:auto`, payload: { auto: true, files: session.files.map((f) => ({ name: f.name, id: f.id })) } })
  }
  await saveSessionFields(a.admin, a.userId, app.id, fields)

  return NextResponse.json({
    status: 'ok',
    application: app.id,
    session: sessionId,
    company: session.company,
    ...toWire(session, fields),
    // ponytail: no drafts and no file offered until K17's Writer and base resume are served by this deployment (/api/fill/draft answers 503 until then)
    drafts: [],
    file: null,
  })
}
