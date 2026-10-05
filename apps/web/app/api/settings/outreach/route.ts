// GET/POST /api/settings/outreach: the outreach policy stored at
// profiles.preferences.outreach: autoSend, dailyCap, followUpDays. Everything
// downstream (the send route, the queue banner, the follow-up window) already
// read these; nothing could write them, so every account ran on the defaults.
//
// The send route still requires a human click for any message, and a demo
// profile cannot switch autoSend on (the database lockdown trigger refuses it,
// and demoSettingsGate refuses the write up front).

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { demoLockdownGate, demoSettingsGate, type DemoProfileFacts } from '@/lib/access/guardrails'
import { resolveOutreachPreferences } from '@/lib/outreach/types'

export const dynamic = 'force-dynamic'

const DAILY_CAP = { min: 1, max: 50 }
const FOLLOW_UP_DAYS = { min: 1, max: 60 }

function inRange(v: unknown, r: { min: number; max: number }): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('preferences').eq('id', user.id).single()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  return NextResponse.json({ prefs: resolveOutreachPreferences(preferences.outreach) })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { row: profile } = await readProfileForDemoGuards(supabase as unknown as SupabaseClient, user.id)
  const gate = demoSettingsGate((profile ?? null) as DemoProfileFacts | null)
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason, message: gate.message, demo: gate.code }, { status: 403 })
  }

  if (body.autoSend !== undefined && typeof body.autoSend !== 'boolean') {
    return NextResponse.json({ error: 'autoSend must be true or false' }, { status: 400 })
  }
  if (body.dailyCap !== undefined && !inRange(body.dailyCap, DAILY_CAP)) {
    return NextResponse.json({ error: `dailyCap must be a whole number from ${DAILY_CAP.min} to ${DAILY_CAP.max}` }, { status: 400 })
  }
  if (body.followUpDays !== undefined && !inRange(body.followUpDays, FOLLOW_UP_DAYS)) {
    return NextResponse.json(
      { error: `followUpDays must be a whole number from ${FOLLOW_UP_DAYS.min} to ${FOLLOW_UP_DAYS.max}` },
      { status: 400 }
    )
  }

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const next = resolveOutreachPreferences({
    ...resolveOutreachPreferences(preferences.outreach),
    ...(body.autoSend !== undefined ? { autoSend: body.autoSend } : {}),
    ...(body.dailyCap !== undefined ? { dailyCap: body.dailyCap } : {}),
    ...(body.followUpDays !== undefined ? { followUpDays: body.followUpDays } : {}),
  })

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, outreach: { ...next } } })
    .eq('id', user.id)
  if (error) {
    const lockdown = demoLockdownGate(error)
    if (lockdown) {
      return NextResponse.json({ error: lockdown.reason, message: lockdown.message, demo: lockdown.code }, { status: 403 })
    }
    console.error('Failed to save outreach preferences:', error)
    return NextResponse.json({ error: 'Failed to save outreach preferences' }, { status: 500 })
  }

  return NextResponse.json({ success: true, prefs: next })
}
