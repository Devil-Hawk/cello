import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { demoLockdownGate, demoSettingsGate, type DemoProfileFacts } from '@/lib/access/guardrails'
import { PKCE_COOKIE, PKCE_COOKIE_PATH, safeReturn } from '../pkce'

export const dynamic = 'force-dynamic'

const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'

function readCookie(request: NextRequest): { v: string; r: string } | null {
  const raw = request.cookies.get(PKCE_COOKIE)?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; r?: unknown }
    return typeof parsed.v === 'string' && parsed.v ? { v: parsed.v, r: safeReturn(typeof parsed.r === 'string' ? parsed.r : null) } : null
  } catch {
    return null
  }
}

// Back to where the round trip started, with the outcome in the query. The
// cookie is spent either way.
function back(request: NextRequest, path: string, outcome: 'free' | 'failed'): NextResponse {
  const response = NextResponse.redirect(new URL(`${path}?models=${outcome}`, request.url), 303)
  response.cookies.set(PKCE_COOKIE, '', { path: PKCE_COOKIE_PATH, maxAge: 0 })
  return response
}

// GET /api/auth/openrouter/callback?code=...
// OpenRouter sends the person here after they sign in. The code is exchanged,
// with the verifier from the cookie, for a key that starts sk-or-. The key is
// stored encrypted exactly as Settings stores a pasted one, and never shown.
export async function GET(request: NextRequest) {
  const cookie = readCookie(request)
  if (!cookie) {
    return NextResponse.json({ error: 'This sign-in expired. Start again.' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  const code = request.nextUrl.searchParams.get('code')
  if (!code) return back(request, cookie.r, 'failed')

  // A demo never gets a key of its own, and an unreadable profile cannot prove it is not one.
  const { row: profile } = await readProfileForDemoGuards(supabase as unknown as SupabaseClient, user.id)
  const gate = demoSettingsGate((profile ?? null) as DemoProfileFacts | null)
  if (!gate.allowed) return back(request, cookie.r, 'failed')

  let key: unknown
  try {
    const res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: cookie.v, code_challenge_method: 'S256' }),
    })
    if (!res.ok) return back(request, cookie.r, 'failed')
    key = ((await res.json()) as { key?: unknown }).key
  } catch {
    return back(request, cookie.r, 'failed')
  }
  if (typeof key !== 'string' || !key.startsWith('sk-or-')) return back(request, cookie.r, 'failed')

  const preferences = ((profile as { preferences?: unknown } | null)?.preferences ?? {}) as Record<string, unknown>
  const apiKeys = { ...((preferences.api_keys ?? {}) as Record<string, unknown>), openrouter: encrypt(key) }
  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, api_keys: apiKeys } as never })
    .eq('id', user.id)
  if (error) {
    if (!demoLockdownGate(error)) console.error('[auth/openrouter] could not save the key:', error.code, error.message)
    return back(request, cookie.r, 'failed')
  }
  return back(request, cookie.r, 'free')
}
