// Who may use the relay routes. Two doors, and each one is narrow:
//   * the Cello page, with the person's session (the page carrier);
//   * the extension, with its own token of scope `relay`.
// A token without the `relay` scope is refused, so the extension's fill token (scope
// `fill:extension`) cannot claim a model job, and the relay token cannot reach a fill
// route (K18's routes require `fill:extension`; scopeAllows is the one check both use).
// Demo workspaces never use the relay.

import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { validateToken } from '@/lib/access/tokens'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import type { AdminClient } from '@/lib/harness/types'
import { isSameOriginRequest } from '@/lib/security/same-origin'
import { createClient } from '@/lib/supabase/server'

export const RELAY_SCOPE = 'relay'
export const NO_STORE = { 'Cache-Control': 'no-store' }

export const scopeAllows = (scopes: readonly string[] | undefined, required: string): boolean =>
  !!scopes && scopes.includes(required)

export type RelayAuth =
  | { ok: true; userId: string; via: 'session' | 'token'; admin: AdminClient }
  | { ok: false; response: NextResponse }

const refuse = (status: number, error: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ error }, { status, headers: NO_STORE }),
})

function bearerOf(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null
  return auth.slice(7).trim() || null
}

/** A demo workspace, or an account that cannot be verified as not one, never uses the relay. */
async function notDemo(admin: AdminClient, userId: string): Promise<boolean> {
  const { data, error } = await (admin as unknown as SupabaseClient)
    .from('profiles')
    .select('is_demo, demo_expires_at')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return false
  return !isDemoProfile(data as DemoProfileFacts)
}

export async function authorizeRelay(request: NextRequest): Promise<RelayAuth> {
  const admin = createAdminClient()
  const bearer = bearerOf(request)

  if (bearer) {
    const v = await validateToken(admin, bearer)
    if (!v.ok || !v.userId) return refuse(401, 'This token is not valid.')
    if (!scopeAllows(v.scopes, RELAY_SCOPE)) return refuse(403, 'This token cannot use the relay.')
    if (!(await notDemo(admin, v.userId))) return refuse(403, 'Demo workspaces cannot use the relay.')
    return { ok: true, userId: v.userId, via: 'token', admin }
  }

  // The session is a cookie, so a state change must come from Cello's own pages.
  if (!isSameOriginRequest(request.headers)) return refuse(403, 'This request did not come from Cello.')
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return refuse(401, 'Unauthorized')
  if (!(await notDemo(admin, user.id))) return refuse(403, 'Demo workspaces cannot use the relay.')
  return { ok: true, userId: user.id, via: 'session', admin }
}
