import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoProfile } from '@/lib/access/guardrails'
import { refreshSuggestionsForUser } from '@/lib/companies/refresh'
import { readSuggestions } from '@/lib/companies/suggestions-store'

// GET  /api/companies/suggestions  the stored "Suggested for you" list. Never
//      computes: the daily cron builds it (lib/companies/refresh.ts).
// POST /api/companies/suggestions { refresh: true }  build it now, once an hour
//      at most, for the first run before the cron has reached a new person.
//      The work finishes inside the request (about a minute), so the page can
//      show its progress copy and then the list.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MIN_REFRESH_GAP_MS = 3600 * 1000

async function profileOf(db: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await db
    .from('profiles')
    .select('resume_text, preferences, is_demo, demo_expires_at')
    .eq('id', userId)
    .maybeSingle()
  return (data as { resume_text: string | null; preferences: unknown; is_demo: boolean | null; demo_expires_at: string | null } | null) ?? null
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const profile = await profileOf(supabase, user.id)
    if (isDemoProfile(profile)) {
      return NextResponse.json({ status: 'not_built', refresh: { state: null, computedAt: null, nextRefreshAt: null }, suggestions: [] })
    }
    return NextResponse.json(await readSuggestions(supabase, user.id, profile ?? { resume_text: null, preferences: null }))
  } catch (error) {
    console.error('Suggestions read error:', error)
    return NextResponse.json({ error: 'Could not load suggestions.' }, { status: 500 })
  }
}

const RefreshBody = z.object({ refresh: z.literal(true) })

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!RefreshBody.safeParse(json).success) return NextResponse.json({ error: 'refresh must be true' }, { status: 400 })

  try {
    const profile = await profileOf(supabase, user.id)
    if (!profile || isDemoProfile(profile)) {
      return NextResponse.json({ error: 'demo' }, { status: 403 })
    }
    // The generated database types predate these tables, so query through the untyped client.
    const { data: state } = await (supabase as unknown as SupabaseClient)
      .from('company_suggestion_state')
      .select('computed_at')
      .eq('user_id', user.id)
      .maybeSingle()
    const computedAt = (state as { computed_at: string | null } | null)?.computed_at ?? null
    if (computedAt && Date.now() - Date.parse(computedAt) < MIN_REFRESH_GAP_MS) {
      return NextResponse.json({ error: 'recently_refreshed', computedAt }, { status: 429 })
    }
    const result = await refreshSuggestionsForUser(createAdminClient(), user.id)
    return NextResponse.json({ status: result.status, stored: result.stored }, { status: 202 })
  } catch (error) {
    console.error('Suggestions refresh error:', error)
    return NextResponse.json({ error: 'Could not build suggestions.' }, { status: 500 })
  }
}
