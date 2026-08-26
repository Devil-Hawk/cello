import { NextRequest, NextResponse } from 'next/server'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { DEFAULT_MONTHLY_USD } from '@/lib/harness/spend'
import {
  demoLockdownGate,
  demoSettingsGate,
  type DemoGate,
  type DemoProfileFacts,
} from '@/lib/access/guardrails'

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
//
// A DEMO SESSION MAY NOT WRITE HERE AT ALL. Its $1 cap (DEMO_MONTHLY_USD) is
// the guardrail that makes handing a stranger a real, working account
// affordable, and this route is the product's own editor for exactly that
// number — so without a check the holder of a shared code raises their own
// ceiling to this file's MAX_MONTHLY_USD with one request. Both PUT paths below
// refuse: demoSettingsGate before the write, demoLockdownGate for a refusal
// that only the database saw (supabase/migrations/20260803000003). Same body,
// same 403, either way. GET is untouched — a demo may read its own budget, and
// the banner that shows "$0.12 of $1.00 used" is part of the demo.

/** Floor and ceiling for a sane monthly cap, in USD. */
const MIN_MONTHLY_USD = 1
const MAX_MONTHLY_USD = 1000

interface BudgetPayload {
  monthlyUsd: number
  spentUsd: number
  periodStart: string | null
}

/**
 * One rendering of a demo refusal, so the answer is byte-identical whether the
 * application layer or the database trigger produced the gate. Mirrors the
 * shape app/api/outreach/send already returns for demoSendGate: `error` is the
 * terse reason, `message` the sentence a UI can show, `demo` the machine code.
 */
function demoRefusalResponse(gate: DemoGate): NextResponse {
  return NextResponse.json(
    { error: gate.reason, message: gate.message, demo: gate.code },
    { status: 403 }
  )
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

  // The read this route was already doing before its write, now also carrying
  // the two demo columns — so the guardrail costs no extra query. They are
  // selected through an untyped view of the same client because the
  // access-codes migration's columns are not in @cello/shared's generated
  // Database type yet; the same escape hatch app/api/access-codes/route.ts and
  // app/api/outreach/send/route.ts use, for the same reason.
  const { row: profile, error: readError } = await readProfileForDemoGuards(
    supabase as unknown as SupabaseClient,
    user.id
  )

  if (readError) {
    // Named loudly, because the likeliest cause is a schema that predates the
    // access-codes migration — the select then fails whole, on `is_demo`, and
    // the gate below refuses every write until it is applied. That is the
    // intended direction to be wrong in (lib/harness/keys.ts takes the same
    // posture for key loads) but it is not a mystery anyone should have to
    // debug twice.
    console.error('[settings/budget] pre-write read failed:', readError.message)
  }

  // FAILS CLOSED. An unreadable profile cannot prove the caller is not a demo,
  // and demoSettingsGate(null) is the canonical 'profile-unavailable' refusal —
  // built there rather than hand-written here so there is one wording and one
  // policy. Checked before the body is even parsed: a demo should be told the
  // budget is locked, not handed a validation error about a number it was never
  // allowed to set.
  const gate = demoSettingsGate((profile ?? null) as DemoProfileFacts | null)
  if (!gate.allowed) return demoRefusalResponse(gate)

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
    // A refusal the gate above could not see — a demo whose flags were
    // unreadable, or any path that reaches this write without passing it.
    // Answer it exactly as the application layer would have, rather than
    // reporting a deliberate refusal as a server fault.
    const lockdown = demoLockdownGate(writeError)
    if (lockdown) return demoRefusalResponse(lockdown)

    console.error('[settings/budget] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save your budget' }, { status: 500 })
  }

  return NextResponse.json({
    budget: readBudget({ ...prefs, budget: { ...existingBudget, monthlyUsd: capUsd } }),
  })
}
