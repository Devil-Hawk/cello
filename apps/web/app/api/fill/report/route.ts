// POST /api/fill/report: what the extension saw. { applicationId, outcome, ... }
//
//   filled          the form is filled; nothing moves
//   blocked         { cause } a login, an account, a human check, an unknown field ...: the page is the person's
//   ready_to_send   Send for me asks to click: the server writes submission.sending and says go, or refuses
//   submitted       { confirmed } the send happened (the person's click, or Send for me's one click)
//   confirmation    { jobId } the employer's own confirmation page, matched by job id and nothing else
//
// A send counts as Sent only when the site confirmed it. An unconfirmed one is never called Sent: after
// the person's click it is recorded as unconfirmed, after an automatic click it is Needs you "Did you send it?".

import { NextRequest, NextResponse } from 'next/server'
import { detectApplyTarget } from '@/lib/ats-apply/detect'
import { fillAuth, isFillAuth, type FillAuth } from '@/lib/fill/auth'
import { loadFillApp, type FillApp } from '@/lib/fill/session'
import { DOORS } from '@/lib/pipeline/actors'
import { note, transition, type MoveResult } from '@/lib/pipeline/transition'
import { STOP_CAUSES, type StopCause } from '@/lib/pipeline/types'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const X = DOORS.extension

type Body = { applicationId?: unknown; outcome?: unknown; cause?: unknown; host?: unknown; confirmed?: unknown; jobId?: unknown; files?: unknown; finalUrl?: unknown }

const answer = (r: MoveResult, extra: Record<string, unknown> = {}) =>
  r.ok ? NextResponse.json({ ok: true, ...extra }) : NextResponse.json({ ok: false, refusal: r.refusal, error: r.sentence }, { status: r.refusal === 'missing' ? 404 : 409 })

const ev = (kind: Parameters<typeof note>[3]['kind'], key: string, sentence: string, extra: Partial<Parameters<typeof note>[3]> = {}) => ({
  kind,
  actor: X.actor,
  channel: X.channel,
  sentence,
  idempotencyKey: key,
  ...extra,
})

async function sendingEventExists(a: FillAuth, appId: string): Promise<boolean> {
  const { data } = await a.admin.from('pipeline_events').select('id').eq('user_id', a.userId).eq('application_id', appId).eq('kind', 'submission.sending').limit(1).maybeSingle()
  return Boolean(data)
}

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  const b = (await request.json().catch(() => null)) as Body | null
  if (!b || typeof b.applicationId !== 'string' || !UUID.test(b.applicationId) || typeof b.outcome !== 'string') return NextResponse.json({ error: 'Say which application and what happened.' }, { status: 400 })
  const app = await loadFillApp(a.admin, a.userId, b.applicationId)
  if (!app) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  const stamp = app.last_event_at ?? 'none'
  const company = app.jobs!.companies?.name ?? 'the company'

  switch (b.outcome) {
    case 'filled':
      return answer(await note(a.admin, a.userId, app.id, ev('fill.reported', `filled:${app.id}:${stamp}`, 'Your browser filled the form.')))

    case 'blocked': {
      const cause = (STOP_CAUSES as readonly string[]).includes(b.cause as string) ? (b.cause as StopCause) : null
      if (!cause) return NextResponse.json({ error: 'Say why it stopped.' }, { status: 400 })
      const host = typeof b.host === 'string' ? b.host.slice(0, 200) : null
      // an automatic claim that stopped before Send is never tried again automatically (auto_attempted_at stays)
      return answer(
        await transition(a.admin, {
          applicationId: app.id,
          from: ['applying', 'ready'],
          to: 'needs_you',
          reason: 'your_turn',
          detail: { cause, host, auto: app.auto_attempted_at !== null },
          step: 'Your turn on the site',
          event: ev('fill.blocked', `blocked:${app.id}:${stamp}`, `Your browser stopped on ${company}'s site.`, { payload: { cause, host } }),
        }),
      )
    }

    case 'ready_to_send': {
      const files = Array.isArray(b.files) ? b.files : []
      const r = await transition(a.admin, {
        applicationId: app.id,
        from: ['applying'],
        to: 'applying',
        step: 'Sending',
        event: ev('submission.sending', `sending:${app.id}`, 'Your browser is about to send this.', { payload: { token_id: a.tokenId, lease_holder: app.lease_holder, files } }),
      })
      return answer(r, { go: r.ok })
    }

    case 'submitted': {
      const confirmed = b.confirmed === true
      const automatic = app.auto_attempted_at !== null && app.state === 'applying'
      // an automatic send is only a send if the server said go first
      if (automatic && !(await sendingEventExists(a, app.id))) return NextResponse.json({ error: 'Send for me did not ask to send this one.' }, { status: 409 })
      if (automatic && !confirmed) {
        return answer(await transition(a.admin, { applicationId: app.id, from: ['applying'], to: 'needs_you', reason: 'check_sent', step: 'Did you send it?', event: ev('submission.unconfirmed', `unconfirmed:${app.id}:${stamp}`, `Your browser clicked Send on ${company}'s form but saw no confirmation.`, { trust: 'unconfirmed', origin: 'code' }) }))
      }
      if (confirmed) {
        return answer(await transition(a.admin, { applicationId: app.id, from: ['applying', 'ready', 'needs_you'], to: 'sent', event: ev('submission.sent', `sent:${app.id}:${stamp}`, `Sent to ${company}.`, { trust: 'proven', origin: 'code', payload: { auto: automatic } }) }))
      }
      // the person's own click and no confirmation seen: recorded as such, never as a confirmed send
      return answer(await transition(a.admin, { applicationId: app.id, from: ['applying', 'ready', 'needs_you'], to: 'sent', event: ev('submission.unconfirmed', `unconfirmed:${app.id}:${stamp}`, 'No confirmation seen yet.', { trust: 'unconfirmed', origin: 'code' }) }))
    }

    case 'confirmation': {
      // the page of the employer's own confirmation: matched by job id, never by company or title
      const target = detectApplyTarget(app.jobs!.url)
      if (!target?.jobId || typeof b.jobId !== 'string' || b.jobId !== target.jobId) return NextResponse.json({ error: 'That confirmation is not for this posting.' }, { status: 409 })
      return answer(await transition(a.admin, { applicationId: app.id, from: ['sent'], to: 'confirmed', event: ev('submission.confirmed', `confirmed:${app.id}`, `${company} confirmed it.`, { trust: 'proven', origin: 'code' }) }))
    }

    default:
      return NextResponse.json({ error: 'That is not something Cello understands.' }, { status: 400 })
  }
}

export type { FillApp }
