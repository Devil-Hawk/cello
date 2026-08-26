import { NextRequest, NextResponse } from 'next/server'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto'
import {
  demoLockdownGate,
  demoSettingsGate,
  type DemoGate,
  type DemoProfileFacts,
} from '@/lib/access/guardrails'

// A DEMO SESSION MAY NOT WRITE KEYS HERE.
//
// A demo workspace is provisioned server-side with exactly one credential — the
// owner's OpenRouter key, narrowed by lib/access/guardrails.ts's
// DEMO_API_KEY_ALLOWLIST — precisely so scoring, tailoring and drafting work
// for real while every model call is metered against the demo's own $1 ledger.
// Two things a demo must not be able to do with that arrangement:
//
//   POST — swap in key material of its own, which would make the owner's
//   workspace an outbound channel to a provider account they never authorised,
//   on requests that look like theirs.
//   DELETE — clear the key, which is not "turning a feature off" but forcing
//   whatever fallback path exists next.
//
// Enforced twice, because one layer is not a boundary: demoSettingsGate before
// each write, and demoLockdownGate for a refusal only the database saw
// (supabase/migrations/20260803000003 freezes the whole api_keys subtree for a
// demo row). Both produce the same 403 body. GET stays open to a demo — it
// returns only hasOpenai/hasAnthropic/hasOpenrouter, never key material, and
// the Settings page showing "OpenRouter: configured" is part of the demo.

interface ApiKeys {
  openai?: string
  anthropic?: string
  openrouter?: string
  [key: string]: string | undefined
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

/**
 * Read the caller's preferences plus the two demo columns, and refuse unless
 * this caller may write keys at all.
 *
 * Returns either the refusal to send back or the preferences blob the write
 * needs, so POST and DELETE cannot end up with different policies — they had
 * separate copies of this read before, and a guard added to one of them would
 * have been the kind of gap nobody notices.
 *
 * FAILS CLOSED: an unreadable profile cannot prove the caller is not a demo,
 * and demoSettingsGate(null) is the canonical 'profile-unavailable' refusal.
 * The demo columns are selected through an untyped view of the same client
 * because the access-codes migration's columns are not in @cello/shared's
 * generated Database type yet — the escape hatch app/api/access-codes/route.ts
 * uses for the identical reason.
 */
async function loadWritablePreferences(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<{ refusal: NextResponse } | { preferences: Record<string, unknown> }> {
  const { row: profile, error } = await readProfileForDemoGuards(
    supabase as unknown as SupabaseClient,
    userId
  )

  if (error) {
    // Named loudly: the likeliest cause is a schema that predates the
    // access-codes migration, in which case the select fails whole on `is_demo`
    // and every key write is refused until it is applied. That is the intended
    // direction to be wrong in — lib/harness/keys.ts takes the same posture for
    // key loads — but it should never be a mystery.
    console.error('[settings/keys] profile read failed:', error.message)
  }

  const gate = demoSettingsGate((profile ?? null) as DemoProfileFacts | null)
  if (!gate.allowed) return { refusal: demoRefusalResponse(gate) }

  return { preferences: (profile?.preferences || {}) as Record<string, unknown> }
}

// GET - Check which keys are configured (never return actual keys)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const keys = (preferences.api_keys || {}) as ApiKeys

  // Only return whether keys exist, never the actual keys
  return NextResponse.json({
    hasOpenai: !!keys.openai,
    hasAnthropic: !!keys.anthropic,
    hasOpenrouter: !!keys.openrouter,
  })
}

// POST - Save encrypted API keys
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Before the body is even read: a demo should be told the key is locked, not
  // handed a validation error about a key it was never allowed to set.
  const loaded = await loadWritablePreferences(supabase, user.id)
  if ('refusal' in loaded) return loaded.refusal

  const body = await request.json()
  const { openai, anthropic, openrouter } = body as ApiKeys

  // Validate key formats
  if (openai && !openai.startsWith('sk-')) {
    return NextResponse.json({ error: 'OpenAI key should start with sk-' }, { status: 400 })
  }
  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    return NextResponse.json({ error: 'Anthropic key should start with sk-ant-' }, { status: 400 })
  }
  if (openrouter && !openrouter.startsWith('sk-or-')) {
    return NextResponse.json({ error: 'OpenRouter key should start with sk-or-' }, { status: 400 })
  }

  const preferences = loaded.preferences
  const existingKeys = (preferences.api_keys || {}) as ApiKeys

  // Encrypt and update keys
  const newKeys: ApiKeys = { ...existingKeys }

  if (openai) {
    newKeys.openai = encrypt(openai)
  }
  if (anthropic) {
    newKeys.anthropic = encrypt(anthropic)
  }
  if (openrouter) {
    newKeys.openrouter = encrypt(openrouter)
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      preferences: { ...preferences, api_keys: newKeys }
    })
    .eq('id', user.id)

  if (error) {
    // A refusal the gate above could not see — a demo whose flags were
    // unreadable, or any path that reaches this write without passing it.
    // Answered exactly as the application layer would have, rather than
    // reporting a deliberate refusal as a server fault.
    const lockdown = demoLockdownGate(error)
    if (lockdown) return demoRefusalResponse(lockdown)

    console.error('Failed to save API keys:', error)
    return NextResponse.json({ error: 'Failed to save API keys' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    hasOpenai: !!newKeys.openai,
    hasAnthropic: !!newKeys.anthropic,
    hasOpenrouter: !!newKeys.openrouter,
  })
}

// DELETE - Remove a specific API key
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Same order as POST: the demo hears "the key is locked", not "invalid
  // provider", for a deletion it was never allowed to make.
  const loaded = await loadWritablePreferences(supabase, user.id)
  if ('refusal' in loaded) return loaded.refusal

  const { searchParams } = new URL(request.url)
  const provider = searchParams.get('provider') as 'openai' | 'anthropic' | 'openrouter'

  if (!provider || !['openai', 'anthropic', 'openrouter'].includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
  }

  const preferences = loaded.preferences
  const existingKeys = (preferences.api_keys || {}) as ApiKeys

  delete existingKeys[provider]

  const { error } = await supabase
    .from('profiles')
    .update({
      preferences: { ...preferences, api_keys: existingKeys }
    })
    .eq('id', user.id)

  if (error) {
    const lockdown = demoLockdownGate(error)
    if (lockdown) return demoRefusalResponse(lockdown)

    console.error('Failed to delete API key:', error)
    return NextResponse.json({ error: 'Failed to delete API key' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
