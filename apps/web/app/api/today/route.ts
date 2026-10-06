// GET /api/today: what Today shows. The Needs you list, and "since you were last here" in the summary's
// own sentences. Add ?seen=1 when the person has looked: that moves the mark. Reading alone never does.

import { NextRequest, NextResponse } from 'next/server'
import { loadNeedsYou } from '@/lib/needs-you'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'
import { buildSummary, type SummaryEvent } from '@/lib/pipeline/summary'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const now = new Date()
  const { data: profile } = await c.admin.from('profiles').select('preferences, last_seen_at').eq('id', c.userId).maybeSingle()
  const p = profile as { preferences?: unknown; last_seen_at?: string | null } | null
  const since = p?.last_seen_at ?? new Date(now.getTime() - 24 * 3_600_000).toISOString()

  const [list, events] = await Promise.all([
    loadNeedsYou(c.admin, c.userId, now),
    c.admin.from('pipeline_events').select('kind, actor, trust, company_name').eq('user_id', c.userId).gte('created_at', since).limit(500),
  ])
  const summary = buildSummary({ events: (events.data ?? []) as SummaryEvent[], needsYouCount: list.count, paused: readPipelineSettings(p?.preferences).pausedAt !== null })

  if (request.nextUrl.searchParams.get('seen') === '1') await c.admin.from('profiles').update({ last_seen_at: now.toISOString() }).eq('id', c.userId)
  return NextResponse.json({ needsYou: list, since: { at: since, lines: summary.empty ? [] : summary.lines }, now: now.toISOString() })
}
