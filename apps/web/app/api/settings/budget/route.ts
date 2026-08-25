import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { DEFAULT_MONTHLY_USD } from '@/lib/harness/spend'

// GET/PUT for profiles.preferences.budget.monthlyUsd — the monthly AI spend cap.
//
// WHY THIS EXISTS
//   The cap was readable everywhere and writable nowhere: the dashboard meter,
//   the jobs page's budget hint and lib/harness/spend.ts all read
//   preferences.budget.monthlyUsd, but nothing in the product could set it. A
//   user who hit their ceiling mid-session had no way to raise it, and a user
//   who wanted a tighter one had no way to ask for it. Since this is a
//   bring-your-own-key product, the cap is the only lever the user has over
//   what Cello is allowed to spend on their behalf — it should not be a
//   constant only the code knows about.
//
// PUT is read-modify-write, for the same reason the targeting route documents:
// `preferences` also holds api_keys, targeting, model, digest and gmail_sync,
// so a naive `.update({ preferences: { budget } })` would silently wipe the
// user's saved API keys. Always read the row first and spread it.
//
// `spentUsd` and `periodStart` are deliberately NOT writable here. They are
// metering facts owned by lib/harness/spend.ts, which increments them when a
// real LLM call is billed. Letting the client set "how much I have spent" would
// make the budget unenforceable, which is the opposite of the point.

/** Floor and ceiling for a sane monthly cap, in USD. */
const MIN_MONTHLY_USD = 1
const MAX_MONTHLY_USD = 1000

interface BudgetPayload {
  monthlyUsd: number
  spentUsd: number
  periodStart: string | null
}

function readBudget(preferences: unknown): BudgetPayload {
  const prefs = (preferences ?? {}) as Record<string, unknown>
  const raw = (prefs.budget ?? {}) as Record<string, unknown>
  const monthlyUsd =
    typeof raw.monthlyUsd === 'number' && raw.monthlyUsd > 0 ? raw.monthlyUsd : DEFAULT_MONTHLY_USD
  return {
    monthlyUsd,
    spentUsd: typeof raw.spentUsd === 'number' && raw.spentUsd > 0 ? raw.spentUsd : 0,
    periodStart: typeof raw.periodStart === 'string' ? raw.periodStart : null,
  }
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[settings/budget] read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load your budget' }, { status: 500 })
  }

  return NextResponse.json({ budget: readBudget(profile?.preferences ?? null) })
}

export async function PUT(request: NextRequest) {
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

  const raw = (body ?? {}) as Record<string, unknown>
  const monthlyUsd = raw.monthlyUsd

  if (typeof monthlyUsd !== 'number' || !Number.isFinite(monthlyUsd)) {
    return NextResponse.json({ error: 'monthlyUsd must be a number' }, { status: 400 })
  }
  if (monthlyUsd < MIN_MONTHLY_USD || monthlyUsd > MAX_MONTHLY_USD) {
    return NextResponse.json(
      {
        error: `Set a monthly cap between $${MIN_MONTHLY_USD} and $${MAX_MONTHLY_USD}.`,
      },
      { status: 400 }
    )
  }

  // Round to cents. A cap of $8.333333 would render as "$8.33" everywhere while
  // the enforcement used the unrounded value — a small lie, but this is the
  // number the product quotes back to the user constantly.
  const capUsd = Math.round(monthlyUsd * 100) / 100

  const { data: profile, error: readError } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (readError) {
    console.error('[settings/budget] pre-write read failed:', readError.message)
    return NextResponse.json({ error: 'Failed to load your profile' }, { status: 500 })
  }

  const prefs = (profile?.preferences ?? {}) as Record<string, unknown>
  const existingBudget = (prefs.budget ?? {}) as Record<string, unknown>

  const { error: writeError } = await supabase
    .from('profiles')
    .update({
      preferences: {
        ...prefs,
        // Spread the existing budget first so spentUsd and periodStart survive
        // untouched — raising the cap must never look like resetting the meter.
        budget: { ...existingBudget, monthlyUsd: capUsd },
      },
    })
    .eq('id', user.id)

  if (writeError) {
    console.error('[settings/budget] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save your budget' }, { status: 500 })
  }

  return NextResponse.json({
    budget: readBudget({ ...prefs, budget: { ...existingBudget, monthlyUsd: capUsd } }),
  })
}
