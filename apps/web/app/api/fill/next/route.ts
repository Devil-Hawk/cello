// POST /api/fill/next { auto, version }: the extension asks what there is to do.
//   auto false: the person asked for the next ready application: { next: { application, url, company } }.
//   auto true: Send for me asks for an application it may send from this browser: { claim: { application,
//   url, company, hosts } } unless every condition holds: the switch is on and bound to this token, Cello
//   is not paused, it is not quiet hours, the person is not a demo, and a Ready application passes the
//   database's checks and eligibility.ts. The one it returns has been claimed: the claim is the
//   database's (pipeline_transition), which repeats the checks, takes the day's cap and holds the lease.
//   With auto-hosts empty nothing passes eligibility, so no claim is ever served today.
// Anything else is {} (and a reason, for the log).

import { NextRequest, NextResponse } from 'next/server'
import { isDemoProfile } from '@/lib/access/guardrails'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'
import { isQuiet } from '@/lib/notifications/quiet'
import { AUTO_HOSTS } from '@/lib/fill/auto-hosts'
import { buildSession, loadFillApp } from '@/lib/fill/session'
import { DOORS } from '@/lib/pipeline/actors'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { autoSendReason, transition } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

const none = (reason: string) => NextResponse.json({ reason })

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  const body = (await request.json().catch(() => null)) as { auto?: unknown } | null
  if (body?.auto !== true) {
    // the person's own "Send next": the oldest ready application, Pause or not, claimed by nobody
    const { data } = await a.admin.from('applications').select('id, jobs(url, companies(name))').eq('user_id', a.userId).eq('state', 'ready').order('last_event_at', { ascending: true }).limit(1).maybeSingle()
    const row = data as { id: string; jobs: { url: string; companies: { name: string } | null } | null } | null
    return row?.jobs ? NextResponse.json({ next: { application: row.id, url: row.jobs.url, company: row.jobs.companies?.name ?? 'the company' } }) : none('nothing_ready')
  }
  const { data: p } = await a.admin.from('profiles').select('preferences, is_demo, demo_expires_at').eq('id', a.userId).maybeSingle()
  const profile = p as { preferences: unknown; is_demo: boolean | null; demo_expires_at: string | null } | null
  if (!profile || isDemoProfile(profile)) return none('demo')
  const s = readPipelineSettings(profile.preferences)
  if (s.send.mode !== 'auto') return none('off')
  if (s.send.tokenId !== a.tokenId) return none('other_browser')
  if (s.pausedAt !== null) return none('paused')
  const { data: r } = await a.admin.from('routines').select('timezone').eq('user_id', a.userId).eq('command', 'roles.check').maybeSingle()
  if (isQuiet(new Date(), (r as { timezone?: string } | null)?.timezone ?? 'UTC', s.morning.quietFrom, s.morning.quietTo)) return none('quiet')

  const { data: ready } = await a.admin.from('applications').select('id').eq('user_id', a.userId).eq('state', 'ready').order('last_event_at', { ascending: true }).limit(10)
  let why = 'nothing_ready'
  for (const row of (ready ?? []) as { id: string }[]) {
    if ((await autoSendReason(a.admin, row.id)) !== null) {
      why = 'not_allowed'
      continue
    }
    const app = await loadFillApp(a.admin, a.userId, row.id)
    if (!app) continue
    const session = await buildSession(a.admin, app, app.form_fields ?? [])
    if (session.autoReason !== null) {
      why = 'site_not_supported'
      continue
    }
    const claim = await transition(a.admin, {
      applicationId: app.id,
      from: ['ready'],
      to: 'applying',
      step: 'Sending',
      event: {
        kind: 'fill.auto_started',
        actor: DOORS.extension.actor,
        channel: DOORS.extension.channel,
        sentence: 'Send for me started this one in your browser.',
        idempotencyKey: `auto:${app.id}`,
        payload: { token_id: a.tokenId, auto: true, files: session.files.map((f) => ({ name: f.name, id: f.id })) },
      },
    })
    if (!claim.ok) {
      why = claim.refusal
      continue
    }
    return NextResponse.json({
      claim: {
        application: app.id,
        url: app.jobs!.url,
        company: session.company,
        hosts: AUTO_HOSTS.map((h) => ({ host: h.host, url_pattern: h.urlPattern, submit_labels: h.submitLabels, confirmation_patterns: h.confirmationPatterns, confirmation_urls: h.confirmationUrls })),
      },
    })
  }
  return none(why)
}
