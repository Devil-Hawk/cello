// GET /api/fill/next: Send for me asks for the next application it may send from this browser.
// Answers { application: null, reason } unless every condition holds: the switch is on and bound to this
// token, Cello is not paused, it is not quiet hours, the person is not a demo, and a Ready application
// passes the database's checks and eligibility.ts. The one it returns has been claimed: the claim is the
// database's (pipeline_transition), which repeats the checks, takes the day's cap and holds the lease.
// With auto-hosts empty nothing passes eligibility, so this answers nothing today.

import { NextRequest, NextResponse } from 'next/server'
import { isDemoProfile } from '@/lib/access/guardrails'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'
import { isQuiet } from '@/lib/notifications/quiet'
import { buildSession, loadFillApp } from '@/lib/fill/session'
import { DOORS } from '@/lib/pipeline/actors'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { autoSendReason, transition } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

const none = (reason: string) => NextResponse.json({ application: null, reason })

export async function GET(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
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
    return NextResponse.json({ application: { ...session, url: app.jobs!.url, leaseHolder: claim.leaseHolder }, reason: null })
  }
  return none(why)
}
