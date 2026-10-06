// POST /api/fill/report: what the extension saw. { phase, application | application_id, ... } as in
// lib/fill/contract.ts and the extension's own spelling of it (lib/fill/wire.ts).
//
//   filled          the form is filled; nothing moves
//   blocked         { cause } a login, an account, a human check, an unknown field ...: the page is the person's
//   ready_to_send   Send for me asks to click: the server writes submission.sending and says go, or refuses
//   submitted       the form was sent and nothing confirmed it yet: Did you send it? (never Sent)
//   confirmation    the site's own confirmation: Sent, and once Sent, Confirmed
//   unconfirmed     Send for me clicked and saw nothing: Did you send it?
//   abandoned       the browser dropped it
//
// A send counts as Sent only when the site confirmed it. What was read back is recorded through the
// allowlist, against the server's own field list, in an application_attempts row.

import { NextRequest, NextResponse } from 'next/server'
import { detectApplyTarget } from '@/lib/ats-apply/detect'
import { PHASES } from '@/lib/fill/contract'
import { fillAuth, isFillAuth, type FillAuth } from '@/lib/fill/auth'
import { filledEvent, loadSessionFields, recordAttempt } from '@/lib/fill/record'
import { findFillAppByUrl, loadFillApp } from '@/lib/fill/session'
import { allowedReadBack, readReport, readScreenshot, toFillReport } from '@/lib/fill/wire'
import { DOORS } from '@/lib/pipeline/actors'
import { note, transition, type MoveResult } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

const X = DOORS.extension

const answer = (r: MoveResult, extra: Record<string, unknown> = {}) =>
  r.ok ? NextResponse.json({ ok: true, ...extra }) : NextResponse.json({ ok: false, refusal: r.refusal, error: r.sentence, ...extra }, { status: r.refusal === 'missing' ? 404 : 409 })

const ev = (kind: Parameters<typeof note>[3]['kind'], key: string, sentence: string, extra: Partial<Parameters<typeof note>[3]> = {}) => ({
  kind,
  actor: X.actor,
  channel: X.channel,
  sentence,
  idempotencyKey: key,
  ...extra,
})

async function sendingEvent(a: FillAuth, appId: string): Promise<boolean> {
  const { data } = await a.admin.from('pipeline_events').select('id').eq('user_id', a.userId).eq('application_id', appId).eq('kind', 'submission.sending').limit(1).maybeSingle()
  return Boolean(data)
}

/**
 * Whether this send is Cello's own (Send for me) and not the person's. auto_attempted_at only says Cello once
 * tried and never clears, so after an automatic stop the person's own finish would be written as Cello's.
 * The live claim, or the Did you send it? that Cello's own click left, says it: the latest line that began
 * a fill or asked, and whether it was the automatic one.
 */
async function isAutomatic(a: FillAuth, app: { id: string; state: string | null; needs_reason: string | null; auto_attempted_at: string | null }): Promise<boolean> {
  if (app.auto_attempted_at === null || !(app.state === 'applying' || (app.state === 'needs_you' && app.needs_reason === 'check_sent'))) return false
  const { data } = await a.admin.from('pipeline_events').select('payload').eq('user_id', a.userId).eq('application_id', app.id).in('kind', ['fill.started', 'submission.unconfirmed']).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as { payload?: { auto?: unknown } } | null)?.payload?.auto === true
}

/** The files the claim served, which the Send step must repeat exactly. */
async function servedFiles(a: FillAuth, appId: string): Promise<unknown[]> {
  const { data } = await a.admin.from('pipeline_events').select('payload').eq('user_id', a.userId).eq('application_id', appId).eq('kind', 'fill.started').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const files = (data as { payload?: { files?: unknown } } | null)?.payload?.files
  return Array.isArray(files) ? files : []
}

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  const read = readReport(await request.json().catch(() => null))
  if ('message' in read) return NextResponse.json({ error: read.message }, { status: 400 })
  const { raw, extra } = read
  if (!(PHASES as readonly string[]).includes(raw.phase as string)) return NextResponse.json({ error: 'That is not something Cello understands.' }, { status: 400 })
  const shot = readScreenshot(extra.screenshot)
  if ('error' in shot) return NextResponse.json({ error: shot.error }, { status: 413 })

  // a form the extension could not match to an application names none: the page's address finds it
  const pageUrl = typeof raw.url === 'string' ? raw.url : typeof raw.final_url === 'string' ? raw.final_url : null
  const app = read.id ? await loadFillApp(a.admin, a.userId, read.id) : pageUrl ? await findFillAppByUrl(a.admin, a.userId, pageUrl) : null
  if (!app) return read.id ? NextResponse.json({ error: 'That application is gone.' }, { status: 404 }) : NextResponse.json({ ok: true })

  const known = await loadSessionFields(a.admin, a.userId, app.id)
  const values = raw.values === undefined ? undefined : allowedReadBack(raw.values, known)
  const parsed = toFillReport(raw, app.id, values)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That report is not complete.' }, { status: 400 })
  const report = parsed.data

  const stamp = app.last_event_at ?? 'none'
  const company = app.jobs!.companies?.name ?? 'the company'
  const automatic = await isAutomatic(a, app)
  const version = request.headers.get('x-cello-extension-version')
  const sentBy = automatic ? 'cello' : 'person'
  const asked = (kind: 'submission.unconfirmed', key: string, sentence: string) =>
    transition(a.admin, { applicationId: app.id, from: ['applying', 'ready', 'needs_you'], to: 'needs_you', reason: 'check_sent', step: 'Did you send it?', event: ev(kind, key, sentence, { trust: 'unconfirmed', origin: 'code', payload: { auto: automatic } }) })

  switch (report.phase) {
    case 'filled':
      return answer(await note(a.admin, a.userId, app.id, filledEvent(app.id, stamp, { filled: extra.filled, total: extra.total })))

    case 'blocked': {
      const cause = report.cause!
      let host: string | null = null
      try {
        host = report.final_url ? new URL(report.final_url).hostname : null
      } catch {
        host = null
      }
      // an automatic claim that stopped before Send is never tried again automatically (auto_attempted_at stays, and the person's own finish is theirs)
      return answer(
        await transition(a.admin, {
          applicationId: app.id,
          from: ['applying', 'ready'],
          to: 'needs_you',
          reason: 'your_turn',
          detail: { cause, host, auto: automatic },
          step: 'Your turn on the site',
          event: ev('fill.blocked', `blocked:${app.id}:${stamp}`, `Your browser stopped on ${company}'s site.`, { payload: { cause, host } }),
        }),
      )
    }

    case 'ready_to_send': {
      const r = await transition(a.admin, {
        applicationId: app.id,
        from: ['applying'],
        to: 'applying',
        step: 'Sending',
        // ponytail: the form's hashes are recorded, not compared; the first listed host decides what the prepare step stores to compare them with
        event: ev('submission.sending', `sending:${app.id}`, 'Your browser is about to send this.', {
          payload: { token_id: a.tokenId, lease_holder: app.lease_holder, files: await servedFiles(a, app.id), fields_hash: extra.fieldsHash, values_hash: extra.valuesHash, submit_label: extra.submitLabel, file_hashes: extra.fileHashes },
        }),
      })
      // the same click asked for twice: the first event comes back and the second gets no go
      if (r.ok && r.replay) return NextResponse.json({ ok: true, go: false, already_sent: true })
      return answer(r, { go: r.ok })
    }

    case 'submitted': {
      // an automatic send is only a send if the server said go first
      if (automatic && app.state === 'applying' && !(await sendingEvent(a, app.id))) return NextResponse.json({ error: 'Send for me did not ask to send this one.' }, { status: 409 })
      const r = await asked('submission.unconfirmed', `unconfirmed:${app.id}:${stamp}`, automatic ? `Your browser clicked Send on ${company}'s form but saw no confirmation.` : 'You sent it. No confirmation seen yet.')
      if (r.ok) await recordAttempt(a.admin, { app, outcome: 'unconfirmed', sentBy, values, finalUrl: report.final_url, version })
      return answer(r)
    }

    case 'unconfirmed': {
      // the click was already recorded as Did you send it? when the submit was reported
      if (app.state === 'needs_you' && app.needs_reason === 'check_sent') return NextResponse.json({ ok: true })
      const r = await asked('submission.unconfirmed', `unconfirmed:${app.id}:${stamp}`, `Your browser clicked Send on ${company}'s form but saw no confirmation.`)
      if (r.ok) await recordAttempt(a.admin, { app, outcome: 'unconfirmed', sentBy, finalUrl: report.final_url, version })
      return answer(r)
    }

    case 'confirmation': {
      const c = report.confirmation!
      // the confirmation page is matched by job id, never by company or title
      const want = detectApplyTarget(app.jobs!.url)?.jobId
      const got = detectApplyTarget(c.url)?.jobId ?? detectApplyTarget(report.final_url)?.jobId
      if (want && got && want !== got) return NextResponse.json({ error: 'That confirmation is not for this posting.' }, { status: 409 })
      // Sent needs the id on both sides. Without it the page could be any page, so the person's check stands.
      if (!want || !got) {
        if (app.state === 'sent') return NextResponse.json({ ok: true })
        return answer(await asked('submission.unconfirmed', `unconfirmed:${app.id}:${stamp}`, `${company} showed a page Cello could not match to this posting. Check that it sent.`))
      }
      const confirmed = app.state === 'sent'
      const r = await transition(a.admin, {
        applicationId: app.id,
        from: confirmed ? ['sent'] : ['applying', 'ready', 'needs_you'],
        to: confirmed ? 'confirmed' : 'sent',
        event: ev(confirmed ? 'submission.confirmed' : 'submission.sent', `${confirmed ? 'confirmed' : 'sent'}:${app.id}${confirmed ? '' : `:${stamp}`}`, confirmed ? `${company} confirmed it.` : `Sent to ${company}.`, { trust: 'proven', origin: 'code', payload: { auto: automatic } }),
      })
      if (r.ok && !r.replay && !confirmed) await recordAttempt(a.admin, { app, outcome: 'sent', sentBy, finalUrl: c.url, confirmationText: c.text, screenshot: shot.bytes, version })
      return answer(r)
    }

    case 'abandoned': {
      if (app.state !== 'applying') return NextResponse.json({ ok: true })
      if (automatic) {
        return answer(await transition(a.admin, { applicationId: app.id, from: ['applying'], to: 'needs_you', reason: 'your_turn', detail: { cause: 'interrupted', auto: true }, step: 'Your turn on the site', event: ev('fill.blocked', `blocked:${app.id}:${stamp}`, 'Your browser stopped before Cello sent this. Open it and click Fill.', { payload: { cause: 'interrupted', auto: true } }) }))
      }
      return answer(await transition(a.admin, { applicationId: app.id, from: ['applying'], to: 'ready', step: 'Prepared', event: ev('fill.reported', `abandoned:${app.id}:${stamp}`, 'Nothing was sent, so this is ready again.', { payload: { phase: 'abandoned' } }) }))
    }
  }
}
