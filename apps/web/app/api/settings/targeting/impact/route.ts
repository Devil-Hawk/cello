import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createSupabaseStrategyDataSource } from '@/lib/strategy/datasource'
import { resolveTargeting } from '@/lib/targeting'

// POST /api/settings/targeting/impact — "what would THIS (unsaved) targeting
// exclude, right now" for the targeting-tab editor. Read-only: this route
// never writes profiles.preferences.targeting (that's PUT
// /api/settings/targeting) — it exists purely so the cost of a filter is
// visible on the screen where the filter is set, instead of only on Insights
// (components/insights/strategy-panel.tsx) after the user has already saved
// and left.
//
// Reuses getJobScopeCounts (lib/strategy/datasource.ts) rather than
// reimplementing the counting logic, so this route and the Insights "is your
// targeting too strict" panel can never disagree about what a filter costs.
// Every count query in there is `head: true` except the excludedKeywords /
// excludedCompanies text scan, which only runs when one of those lists is
// non-empty and is capped at 20,000 rows.

export const dynamic = 'force-dynamic'
// Smaller than /api/strategy's 30s: this route runs the same per-dimension
// count queries for a single user's pending targeting, with no
// applications/outreach/resume reads on top. Still generous because the
// caller (targeting-tab.tsx) debounces keystrokes rather than firing one
// request per request-in-flight.
export const maxDuration = 15

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
  }

  // Same normalization the PUT route applies before persisting: route the
  // pending (unsaved) body through resolveTargeting so a malformed field
  // (wrong type, out-of-range minScore, a stray non-string array entry)
  // gets clamped/dropped here rather than reaching the count queries below.
  const targeting = resolveTargeting({ targeting: body })

  try {
    const admin = createAdminClient()
    const dataSource = createSupabaseStrategyDataSource(admin, user.id)
    const counts = await dataSource.getJobScopeCounts(targeting)
    return NextResponse.json({ counts })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to compute targeting impact'
    console.error('[settings/targeting/impact] failed', e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
